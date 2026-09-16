/**
 * Extension entry point. Wires the layers together:
 *   backend (dsh kernel via ACP) -> session service -> panel webview
 * plus editor integrations (context chips, diff review) and commands.
 */
import * as cp from 'node:child_process';
import * as path from 'node:path';
import { l10n } from 'vscode';
import * as vscode from 'vscode';
import type { ContextAttachment } from '@dsh-vscode/core';
import { readSettings, getApiKey, setApiKey, API_KEY_SECRET } from './config/Settings.js';
import { hasKernelCredential, resolveKernelHome } from './config/kernelCredentials.js';
import { AcpBackend } from './backend/AcpBackend.js';
import { DshLocator } from './backend/DshLocator.js';
import { ChatSessionService } from './chat/ChatSessionService.js';
import { SessionStore } from './chat/SessionStore.js';
import { ApprovalBridge } from './approval/ApprovalBridge.js';
import { ContextService } from './editor/ContextService.js';
import { DiffService } from './editor/DiffService.js';
import { WorkingSet } from './editor/WorkingSet.js';
import { CHAT_VIEW_ID, PanelController } from './ui/PanelController.js';
import { SESSIONS_VIEW_ID, SessionsView } from './sessions/SessionsView.js';
import { StatusItem } from './statusbar/StatusItem.js';
import { DisposableBag } from './util/dispose.js';
import { Logger } from './util/log.js';

export function activate(context: vscode.ExtensionContext): void {
  const bag = new DisposableBag();
  context.subscriptions.push(bag);

  const channel = bag.push(vscode.window.createOutputChannel('DeepSeek Harness'));
  const logger = new Logger(channel);

  const settings = readSettings();
  const locator = new DshLocator(context.globalStorageUri.fsPath, settings, logger);
  // A key stored in SecretStorage is handed to the kernel explicitly; with none,
  // the kernel authenticates from its own shared credential store.
  const syncApiKey = async (): Promise<void> => {
    locator.setApiKey(await getApiKey(context.secrets));
  };
  void syncApiKey();
  const backend = new AcpBackend(locator, logger);
  const workingSet = new WorkingSet();
  const diff = new DiffService(workingSet, logger);
  diff.register(context);
  const approvals = new ApprovalBridge(settings);
  const sessions = new SessionStore(context.workspaceState);
  const contexts = new ContextService();
  const status = new StatusItem();
  bag.push(status);
  bag.push(backend);

  const service = new ChatSessionService(
    backend,
    workingSet,
    diff,
    approvals,
    sessions,
    contexts,
    settings,
    logger,
  );
  bag.push(service);
  // Wire persistence + restore the previous session's timeline.
  service.setMemento(context.workspaceState);
  void service.restoreTimeline();

  const extensionVersion = readExtensionVersion(context);
  // The panel only needs to prompt when *no* layer has a key: not SecretStorage,
  // and not the kernel's own store, which a dsh CLI or the desktop app fills.
  const kernelIsSignedIn = async (): Promise<boolean> => {
    if (await getApiKey(context.secrets)) {
      return true;
    }
    const home = resolveKernelHome(readSettings().homeDir);
    return hasKernelCredential(home, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
  };
  const panel = new PanelController(context.extensionUri, {
    extensionVersion,
    service,
    contexts,
    diff,
    status,
    logger,
    hasApiKey: kernelIsSignedIn,
  });

  // The chat lives in the secondary (right) side bar. A container contributed
  // to the activity bar would always render in the primary side bar instead,
  // so there is deliberately no left-hand entry point.
  bag.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  /**
   * Reveals the chat panel in the secondary (right) side bar and focuses it.
   *
   * Two steps, each guarded separately:
   *  1. `focusAuxiliaryBar` shows the secondary side bar when the user has it
   *     collapsed. Our view lives there and nothing else would bring it back.
   *  2. `<viewId>.focus` activates our container in case a different one was
   *     showing. That generated command resolves with a view object which
   *     cannot cross the extension host RPC boundary ("An object could not be
   *     cloned."), so its result must never be propagated - hence the catch.
   *
   * This deliberately does not register a command named `dsh.chat.focus`: that
   * id already belongs to the generated view command, and shadowing it made the
   * handler call itself.
   */
  async function revealChat(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
    } catch (err) {
      logger.warn(`Could not show the secondary side bar: ${String(err)}`);
    }
    try {
      await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    } catch (err) {
      logger.warn(`Could not focus the chat view: ${String(err)}`);
    }
  }

  bag.push(vscode.commands.registerCommand('dsh.chat.openPanel', async () => {
    await revealChat();
  }));

  // The sessions list in the activity bar. Selecting an entry reopens it in the
  // panel on the right, so the left icon is a real navigation surface instead of
  // a second, differently-placed copy of the chat.
  const sessionsView = new SessionsView({
    store: sessions,
    open: async (sessionId) => {
      await service.loadSession(sessionId);
      await revealChat();
    },
    reloadHistory: () => service.reloadHistory(),
  });
  bag.push(
    vscode.window.createTreeView(SESSIONS_VIEW_ID, {
      treeDataProvider: sessionsView,
      showCollapseAll: false,
    }),
  );
  bag.push({ dispose: sessions.onChange(() => sessionsView.refresh()) });
  bag.push(
    vscode.commands.registerCommand('dsh.sessions.open', (node: unknown) => sessionsView.open(node)),
  );
  bag.push(
    vscode.commands.registerCommand('dsh.sessions.rename', (node: unknown) => sessionsView.rename(node)),
  );
  bag.push(
    vscode.commands.registerCommand('dsh.sessions.delete', (node: unknown) => sessionsView.remove(node)),
  );
  bag.push(
    vscode.commands.registerCommand('dsh.sessions.refresh', async () => {
      await service.reloadHistory();
      sessionsView.refresh();
    }),
  );

  bag.push(vscode.commands.registerCommand('dsh.newChat', async () => {
    await service.newChat();
    await revealChat();
  }));
  bag.push(vscode.commands.registerCommand('dsh.chat.resume', async () => {
    const history = await sessions.list();
    if (history.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('此工作区还没有历史会话。'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      history.map((meta) => ({
        label: meta.title,
        description: new Date(meta.updatedAt).toLocaleString(),
        sessionId: meta.sessionId,
      })),
      { placeHolder: l10n.t('恢复会话') },
    );
    if (picked) {
      await service.loadSession(picked.sessionId);
    }
  }));
  bag.push(vscode.commands.registerCommand('dsh.chat.addToChat', async () => {
    // Prefer the selection: adding "this bit of code" is the common case, and
    // fromActiveEditor falls back to the whole file when nothing is selected.
    const attachment = contexts.fromActiveEditor(true);
    if (!attachment) {
      void vscode.window.showInformationMessage(l10n.t('打开一个文件即可将其加入对话。'));
      return;
    }
    await revealChat();
    panel.addContext(attachment);
    void vscode.window.showInformationMessage(
      l10n.t('已加入对话：{0}', describeAttachment(attachment)),
    );
  }));
  // Shared flow for selection-driven prompts (commands + code actions).
  async function runWithSelection(prompt: string): Promise<void> {
    const attachment = contexts.fromActiveEditor(true);
    if (!attachment || !attachment.selectionText) {
      void vscode.window.showInformationMessage(l10n.t('请先选中要解释的代码。'));
      return;
    }
    await revealChat();
    panel.addContext(attachment);
    await service.submitPrompt(prompt, [attachment] as ContextAttachment[]);
  }

  bag.push(vscode.commands.registerCommand('dsh.chat.explainSelection', async () => {
    await runWithSelection('请详细解释附件中的代码：作用、逻辑与潜在问题。');
  }));
  bag.push(vscode.commands.registerCommand('dsh.chat.refactorSelection', async () => {
    await runWithSelection('请重构附件中的代码：保持行为不变，提升可读性与结构，并说明改动理由。');
  }));
  bag.push(vscode.commands.registerCommand('dsh.chat.explainProblem', async (item?: unknown) => {
    // The Problems panel passes the clicked problem; narrow defensively.
    const clicked = item as { uri?: vscode.Uri; range?: vscode.Range } | undefined;
    const editor = vscode.window.activeTextEditor;
    const uri = clicked?.uri ?? editor?.document.uri;
    let diagnostics = uri
      ? vscode.languages.getDiagnostics(uri)
      : vscode.languages.getDiagnostics().flatMap((file) => file[1]);
    if (clicked?.range && uri) {
      const clickedRange = clicked.range;
      diagnostics = diagnostics.filter((diagnostic) => diagnostic.range.intersection(clickedRange));
    }
    const relevant = diagnostics.slice(0, 8);
    if (relevant.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('当前没有可解释的诊断信息。'));
      return;
    }
    const relPath = uri ? vscode.workspace.asRelativePath(uri, false) : '*';
    const text = relevant
      .map(
        (diagnostic) =>
          `- [${vscode.DiagnosticSeverity[diagnostic.severity]}] ${diagnostic.message}${
            diagnostic.source ? ` (${diagnostic.source})` : ''
          } @ ${relPath}:${diagnostic.range.start.line + 1}`,
      )
      .join('\n');
    const attachment: ContextAttachment = {
      chipId: `diag-${Date.now().toString(36)}`,
      kind: 'diagnostics',
      path: relPath,
      label: l10n.t('问题诊断'),
      selectionText: text,
    };
    await revealChat();
    panel.addContext(attachment);
    await service.submitPrompt(
      '请分析附件中的诊断信息，定位根因并给出修复方案（可直接修改文件）。',
      [attachment],
    );
  }));
  bag.push(
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file', language: '*' },
      new AskDshCodeActions(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
  bag.push(vscode.commands.registerCommand('dsh.reviewChanges', async () => {
    const editId = await diff.openNextPending();
    if (!editId) {
      void vscode.window.showInformationMessage(l10n.t('没有待审查的变更。'));
    }
  }));
  // R1 (Cursor Cmd+K style): inline instruction over the selection.
  bag.push(vscode.commands.registerCommand('dsh.chat.inlineEdit', async () => {
    const instruction = await vscode.window.showInputBox({
      prompt: l10n.t('描述你想对选中代码做的修改…'),
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) {
      return;
    }
    await runWithSelection(
      `请按以下指令修改附件中的代码：${instruction.trim()}。完成后说明改动点。`,
    );
  }));
  // R2: export the current conversation to a Markdown file.
  bag.push(vscode.commands.registerCommand('dsh.exportChat', async () => {
    const snapshot = service.getSnapshot();
    if (snapshot.entries.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('当前对话为空，无可导出内容。'));
      return;
    }
    const lines: string[] = [`# DeepSeek Harness 对话导出`, '', `> ${new Date().toLocaleString()}`, ''];
    for (const entry of snapshot.entries) {
      switch (entry.kind) {
        case 'user':
          lines.push('## 🧑 用户', '', entry.text, '');
          break;
        case 'assistant':
          lines.push('## 🤖 DeepSeek Harness', '', entry.text, '');
          break;
        case 'toolCall':
          lines.push(`- 🔧 ${entry.toolCall.title} (${entry.toolCall.status})`);
          break;
        case 'error':
          lines.push(`> ⚠️ ${entry.text}`);
          break;
        default:
          break;
      }
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return;
    }
    const file = vscode.Uri.joinPath(
      root,
      `dsh-chat-${Date.now().toString(36)}.md`,
    );
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(lines.join('\n')));
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: true });
  }));
  // R3: session management.
  bag.push(vscode.commands.registerCommand('dsh.renameSession', async () => {
    const history = await sessions.list();
    if (history.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('此工作区还没有历史会话。'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      history.map((meta) => ({ label: meta.title, sessionId: meta.sessionId })),
      { placeHolder: l10n.t('重命名会话') },
    );
    if (!picked) {
      return;
    }
    const title = await vscode.window.showInputBox({
      prompt: l10n.t('输入新的会话标题'),
      value: picked.label,
    });
    if (title?.trim()) {
      await sessions.rename(picked.sessionId, title);
      await service.reloadHistory();
    }
  }));
  bag.push(vscode.commands.registerCommand('dsh.deleteSession', async () => {
    const history = await sessions.list();
    if (history.length === 0) {
      void vscode.window.showInformationMessage(l10n.t('此工作区还没有历史会话。'));
      return;
    }
    const picked = await vscode.window.showQuickPick(
      history.map((meta) => ({ label: meta.title, description: meta.sessionId, sessionId: meta.sessionId })),
      { placeHolder: l10n.t('选择要删除的会话') },
    );
    if (!picked) {
      return;
    }
    const confirmDelete = await vscode.window.showWarningMessage(
      l10n.t('确认删除会话“{0}”？', picked.label),
      { modal: true },
      l10n.t('删除'),
    );
    if (!confirmDelete) {
      return;
    }
    await sessions.remove(picked.sessionId);
    await service.reloadHistory();
  }));
  // R9 (deep Git coupling): staged diff -> commit message -> SCM input box.
  bag.push(vscode.commands.registerCommand('dsh.gitCommitMessage', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return;
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'DeepSeek Harness' },
      async (progress) => {
        progress.report({ message: l10n.t('正在读取 Git 差异…') });
        const staged = await gitOutput(root, ['diff', '--staged']);
        let diffText = staged.trim().length > 0 ? staged : await gitOutput(root, ['diff']);
        if (diffText.trim().length === 0) {
          // Untracked files are invisible to git diff; include them explicitly.
          const untracked = (await gitOutput(root, ['ls-files', '--others', '--exclude-standard']))
            .split(/\r?\n/)
            .filter((line) => line.trim().length > 0)
            .slice(0, 5);
          for (const file of untracked) {
            diffText += await gitOutput(root, ['diff', '--no-index', '--', 'NUL', file]);
          }
        }
        if (diffText.trim().length === 0) {
          void vscode.window.showInformationMessage(l10n.t('没有可用的 Git 差异。'));
          return;
        }
        progress.report({ message: l10n.t('正在生成提交信息…') });
        const message = await service.oneShot(
          `根据以下 Git 差异生成一条简洁的中文 Conventional Commit 提交信息，只输出一行标题（type: 描述），不要正文、不要代码块：\n\n${diffText.slice(0, 8_000)}`,
        );
        const title = message.split('\n').find((line) => line.trim().length > 0)?.trim();
        if (!title) {
          void vscode.window.showWarningMessage(l10n.t('生成提交信息失败。'));
          return;
        }
        try {
          vscode.scm.inputBox.value = title;
          void vscode.window.showInformationMessage(l10n.t('已生成提交信息。'));
        } catch {
          void vscode.window.showInformationMessage(title);
        }
      },
    );
  }));
  // R10: copy a diagnostics bundle for issue reports.
  bag.push(vscode.commands.registerCommand('dsh.copyDiagnostics', async () => {
    const settings = readSettings();
    const report = [
      '## DeepSeek Harness 诊断信息',
      `- 扩展版本: ${readExtensionVersion(context)}`,
      `- VS Code: ${vscode.version}`,
      `- 平台: ${process.platform}`,
      `- 内核定位: ${settings.executablePath ?? 'auto (PATH/托管安装)'}`,
      `- ACP 参数: ${settings.acpArgs.join(' ')}`,
      `- 内核 Profile: ${settings.acpProfile}`,
      `- 工作区: ${vscode.workspace.workspaceFolders?.[0]?.name ?? '(无)'}`,
      `- 历史会话数: ${(await sessions.list()).length}`,
    ].join('\n');
    await vscode.env.clipboard.writeText(report);
    void vscode.window.showInformationMessage(l10n.t('诊断信息已复制到剪贴板。'));
  }));
  // R6: status-bar click opens a quick action menu.
  bag.push(vscode.commands.registerCommand('dsh.statusMenu', async () => {
    const actions: Array<{ label: string; description?: string; command: string }> = [
      { label: `$(add) ${l10n.t('新对话')}`, command: 'dsh.newChat' },
      { label: `$(history) ${l10n.t('恢复会话')}`, command: 'dsh.chat.resume' },
      { label: `$(eye) ${l10n.t('逐个审查变更')}`, command: 'dsh.reviewChanges' },
      { label: `$(git-commit) ${l10n.t('生成提交信息')}`, command: 'dsh.gitCommitMessage' },
      { label: `$(settings-gear) ${l10n.t('打开设置')}`, command: 'dsh.openSettings' },
    ];
    const picked = await vscode.window.showQuickPick(actions, {
      placeHolder: l10n.t('选择要执行的操作…'),
    });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  }));
  // R6: accept/reject directly from the native diff editor title bar.
  const editIdFromActiveDiff = (): string | undefined => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'dsh-edit' ? uri.authority : undefined;
  };
  bag.push(vscode.commands.registerCommand('dsh.acceptCurrentEdit', async () => {
    const editId = editIdFromActiveDiff();
    if (editId) {
      await diff.acceptEdit(editId);
    }
  }));
  bag.push(vscode.commands.registerCommand('dsh.rejectCurrentEdit', async () => {
    const editId = editIdFromActiveDiff();
    if (editId) {
      await diff.rejectEdit(editId);
    }
  }));
  // R7: explain an error copied from any terminal.
  bag.push(vscode.commands.registerCommand('dsh.chat.explainClipboard', async () => {
    const clip = (await vscode.env.clipboard.readText()).trim();
    if (!clip) {
      void vscode.window.showInformationMessage(l10n.t('剪贴板为空。'));
      return;
    }
    await revealChat();
    await service.submitPrompt(
      `请解释下面这段报错的原因并给出修复方案：\n\n${clip.slice(0, 4_000)}`,
      [],
    );
  }));
  // R12: bootstrap an AGENTS.md project rule file (Aider/Claude Code style).
  bag.push(vscode.commands.registerCommand('dsh.createAgentsFile', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return;
    }
    const file = vscode.Uri.joinPath(root, 'AGENTS.md');
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      const template = [
        '# AGENTS.md',
        '',
        '本文件向 DeepSeek Harness 描述本仓库的约定，代理在每次会话时自动读取。',
        '',
        '## 项目结构',
        '- packages/core：协议与纯逻辑',
        '- packages/extension：VS Code 扩展宿主',
        '- packages/webview-ui：React 面板',
        '',
        '## 代码规范',
        '- TypeScript 严格模式，禁止 any',
        '- 提交信息使用 Conventional Commit',
        '',
        '## 注意事项',
        '- 修改后运行 pnpm typecheck && pnpm test',
        '',
      ].join('\n');
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(template));
    }
    const doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc, { preview: true });
  }));
  // R20: quick ask without leaving the keyboard flow.
  bag.push(vscode.commands.registerCommand('dsh.quickAsk', async () => {
    const question = await vscode.window.showInputBox({
      prompt: l10n.t('快速提问…'),
      ignoreFocusOut: true,
    });
    if (question?.trim()) {
      await revealChat();
      await service.submitPrompt(question.trim(), []);
    }
  }));
  // R8: settings hot-reload.
  bag.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('dsh')) {
        return;
      }
      const fresh = readSettings();
      locator.updateSettings(fresh);
      approvals.updateSettings(fresh);
      service.updateSettings(fresh);
      logger.info('Settings reloaded');
    }),
  );
  bag.push(vscode.commands.registerCommand('dsh.setApiKey', async () => {
    const value = await vscode.window.showInputBox({
      prompt: l10n.t('DeepSeek API Key（保存在 VS Code SecretStorage 中，绝不写入设置文件）'),
      password: true,
      ignoreFocusOut: true,
    });
    if (value) {
      await setApiKey(context.secrets, value);
      await syncApiKey();
      void vscode.window.showInformationMessage(l10n.t('DeepSeek Harness：API Key 已保存。'));
    }
  }));
  bag.push(vscode.commands.registerCommand('dsh.clearApiKey', async () => {
    await context.secrets.delete(API_KEY_SECRET);
    await syncApiKey();
    void vscode.window.showInformationMessage(l10n.t('DeepSeek Harness：API Key 已清除。'));
  }));
  bag.push(vscode.commands.registerCommand('dsh.showApiKeyStatus', async () => {
    const stored = Boolean(await getApiKey(context.secrets));
    const home = resolveKernelHome(readSettings().homeDir);
    const shared = await hasKernelCredential(home, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    if (stored) {
      void vscode.window.showInformationMessage(
        shared
          ? l10n.t('DeepSeek Harness：SecretStorage 中已存有 API Key（内核凭据库中也有）。')
          : l10n.t('DeepSeek Harness：SecretStorage 中已存有 API Key。'),
      );
      return;
    }
    void vscode.window.showInformationMessage(
      shared
        ? l10n.t('DeepSeek Harness：内核已通过自身凭据库登录，无需在此设置 API Key。')
        : l10n.t('DeepSeek Harness：尚未存储 API Key。'),
    );
  }));
  bag.push(vscode.commands.registerCommand('dsh.installKernel', async () => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'DeepSeek Harness' },
      async (progress) => {
        try {
          progress.report({ message: l10n.t('正在将 @deepseek-ai/dsh 安装到扩展存储 ...') });
          const spec = await backend.installKernel((text) => progress.report({ message: text }));
          logger.info(`Kernel installed: ${spec.command}`);
          progress.report({ message: l10n.t('正在引导 ACP profile ...') });
          await locator.ensureAcpProfile(spec, (text) => progress.report({ message: text }));
          void vscode.window.showInformationMessage(
            l10n.t('DeepSeek Harness 内核与 ACP profile 已安装。请重载窗口生效。'),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error('Kernel install failed', err instanceof Error ? err : undefined);
          void vscode.window.showErrorMessage(l10n.t('DeepSeek Harness：内核安装失败 - {0}', message));
        }
      },
    );
  }));
  bag.push(vscode.commands.registerCommand('dsh.showLogs', () => channel.show(true)));
  bag.push(vscode.commands.registerCommand('dsh.verify', async () => {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'DeepSeek Harness' },
      async (progress) => {
        progress.report({ message: l10n.t('正在验证内核连接…') });
        try {
          // Full stack check: locate → spawn → handshake → session.
          const handlers = {
            onSessionUpdate: () => undefined,
            onPermissionRequest: async () => ({ outcome: 'cancelled' as const }),
            onReadTextFile: async () => ({ content: '' }),
            onWriteTextFile: async () => undefined,
            onExit: () => undefined,
          };
          const session = await backend.newSession(
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
            handlers,
          );
          void vscode.window.showInformationMessage(
            l10n.t('内核验证通过（会话 {0}）', session.sessionId.slice(0, 8)),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(l10n.t('内核验证失败：{0}', message));
        }
      },
    );
  }));
  bag.push(vscode.commands.registerCommand('dsh.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'dsh.');
  }));

  // R47: suggest creating AGENTS.md once per workspace when missing.
  bag.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await suggestAgentsFile();
    }),
  );
  void suggestAgentsFile();
  async function suggestAgentsFile(): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      return;
    }
    const agentsFile = vscode.Uri.joinPath(root, 'AGENTS.md');
    try {
      await vscode.workspace.fs.stat(agentsFile);
      return; // Already present.
    } catch {
      // Missing - suggest once per session.
    }
    const stateKey = 'dsh.suggestedAgentsFile';
    if (context.workspaceState.get<boolean>(stateKey)) {
      return;
    }
    await context.workspaceState.update(stateKey, true);
    const pick = await vscode.window.showInformationMessage(
      l10n.t('检测到尚未创建 AGENTS.md 项目规则文件，要让代理更好地理解这个仓库吗？'),
      l10n.t('创建'),
    );
    if (pick) {
      await vscode.commands.executeCommand('dsh.createAgentsFile');
    }
  }

  // R46: pending-edit count as a when-context for view title badges.
  bag.push(
    vscode.commands.registerCommand('dsh.refreshBadge', () => {
      void vscode.commands.executeCommand('setContext', 'dsh.pendingCount', workingSet.pendingCount());
    }),
  );
  workingSet.onChange(() => {
    void vscode.commands.executeCommand('setContext', 'dsh.pendingCount', workingSet.pendingCount());
  });

  // Surface kernel environment hints in the log for support requests.
  void getApiKey(context.secrets).then((key) => {
    logger.info(`API key present in SecretStorage: ${Boolean(key)}`);
    logger.info(`Workspace root: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '(none)'}`);
    logger.info(`Managed kernel dir: ${path.join(context.globalStorageUri.fsPath, 'dsh')}`);
  });
}

function readExtensionVersion(context: vscode.ExtensionContext): string {
  const pkg = context.extension?.packageJSON as { version?: string } | undefined;
  return pkg?.version ?? '0.0.0';
}

/** Names a context chip in a notification: the file, plus the selected lines. */
function describeAttachment(attachment: ContextAttachment): string {
  const { range } = attachment;
  if (!range) {
    return attachment.path;
  }
  const span =
    range.startLine === range.endLine
      ? l10n.t('第 {0} 行', range.startLine)
      : l10n.t('第 {0}-{1} 行', range.startLine, range.endLine);
  return `${attachment.path} ${span}`;
}

/** Runs git in the workspace root and returns stdout (empty on failure). */
function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    cp.execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout));
    });
  });
}

/** Lightbulb actions: ask the agent about the current selection. */
class AskDshCodeActions implements vscode.CodeActionProvider {
  provideCodeActions(_document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    if (range.isEmpty) {
      return [];
    }
    const explain = new vscode.CodeAction(
      l10n.t('用 DeepSeek Harness 解释所选代码'),
      vscode.CodeActionKind.QuickFix,
    );
    explain.command = { command: 'dsh.chat.explainSelection', title: explain.title };
    const refactor = new vscode.CodeAction(
      l10n.t('让 DeepSeek Harness 重构所选代码'),
      vscode.CodeActionKind.QuickFix,
    );
    refactor.command = { command: 'dsh.chat.refactorSelection', title: refactor.title };
    return [explain, refactor];
  }
}

export function deactivate(): void {
  // All teardown is handled through context.subscriptions (DisposableBag).
}
