/**
 * Owns the webview view lifecycle: HTML with a strict CSP, the init payload,
 * message routing from the webview into services, and snapshot delivery.
 */
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import {
  deepClonePlain,
  isFromWebview,
  type ContextAttachment,
  type FromWebview,
  type QuickActionId,
  type ToWebview,
} from '@dsh-vscode/core';
import type { ChatSessionService } from '../chat/ChatSessionService.js';
import { QUICK_PROMPTS } from '../chat/ChatSessionService.js';

/** Runtime whitelist for hostCommand - blocks forged webview messages. */
const HOST_COMMAND_WHITELIST = new Set<string>([
  'exportChat',
  'renameSession',
  'deleteSession',
  'gitCommitMessage',
]);
import type { ContextService } from '../editor/ContextService.js';
import type { DiffService } from '../editor/DiffService.js';
import type { StatusItem } from '../statusbar/StatusItem.js';
import type { Logger } from '../util/log.js';

/**
 * The chat panel in the secondary (right) side bar. This is the primary
 * placement, so it keeps the original view id and every command targets it.
 */
export const CHAT_VIEW_ID = 'dsh.chat';
/**
 * The same chat in the activity bar. Contributing a second container keeps a
 * permanent icon on the left; VS Code cannot place one view in two containers,
 * so this is a distinct view id served by the same provider.
 */
export const CHAT_SIDEBAR_VIEW_ID = 'dsh.chatSidebar';

export interface PanelDeps {
  extensionVersion: string;
  service: ChatSessionService;
  contexts: ContextService;
  diff: DiffService;
  status: StatusItem;
  logger: Logger;
  /** SecretStorage probe for the setup hint banner. */
  hasApiKey: () => Promise<boolean>;
}

export class PanelController implements vscode.WebviewViewProvider {
  /**
   * Every live host for this chat - the view in the secondary side bar and the
   * one in the activity bar. They share one session, so each push and each
   * inbound message is handled identically for all of them.
   */
  private readonly views = new Set<vscode.WebviewView>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly deps: PanelDeps,
  ) {}

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.views.add(view);
    view.onDidDispose(() => this.views.delete(view));
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
    };
    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage((raw) => {
      if (!isFromWebview(raw)) {
        this.deps.logger.warn(`Ignored unknown webview message: ${JSON.stringify(raw)}`);
        return;
      }
      void this.handle(raw);
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postNow({ type: 'snapshot', payload: this.deps.service.getSnapshot() });
      }
    });

    this.deps.service.setPanelSink((message) => this.post(message));
    void this.deps.service.reloadHistory();
    this.postNow({ type: 'snapshot', payload: this.deps.service.getSnapshot() });
    // Init payload probes SecretStorage; sent after the first snapshot so the
    // panel can render immediately.
    this.postNow({ type: 'init', payload: await this.buildInitPayload() });
  }

  /** Host-driven context chips (editor title button, code actions). */
  addContext(attachment: ContextAttachment): void {
    this.post({ type: 'addContext', attachment });
  }

  // -------------------------------------------------------------------------

  private async handle(message: FromWebview): Promise<void> {
    const { service, diff, contexts } = this.deps;
    try {
      switch (message.type) {
        case 'ready':
          this.postNow({ type: 'init', payload: await this.buildInitPayload() });
          this.postNow({ type: 'snapshot', payload: service.getSnapshot() });
          break;
        case 'submitPrompt':
          await service.submitPrompt(message.text, message.attachments);
          break;
        case 'cancel':
          service.cancel();
          break;
        case 'approve':
          await service.approve(message.approvalId, message.optionId);
          break;
        case 'openDiff':
          await diff.openDiff(message.editId);
          break;
        case 'acceptEdit':
          await diff.acceptEdit(message.editId);
          break;
        case 'rejectEdit':
          await diff.rejectEdit(message.editId);
          break;
        case 'acceptAllEdits':
          await diff.acceptAll();
          break;
        case 'newChat':
          await service.newChat();
          break;
        case 'loadSession':
          await service.loadSession(message.sessionId);
          break;
        case 'openFilePicker': {
          const attachment = await contexts.pickFile();
          if (attachment) {
            this.addContext(attachment);
          }
          break;
        }
        case 'authenticate':
          await service.authenticate(message.methodId);
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'dsh.');
          break;
        case 'setMode':
          await service.setMode(message.modeId);
          break;
        case 'insertCode':
          await this.insertIntoActiveEditor(message.code);
          break;
        case 'showPlan':
          // Plan rendering is inline in the webview; no host action today.
          break;
        case 'quickAction':
          await this.runQuickAction(message.action);
          break;
        case 'reconnect':
          await service.reconnect();
          break;
        case 'reviewNext': {
          const editId = await diff.openNextPending();
          if (!editId) {
            void vscode.window.showInformationMessage(l10n.t('没有待审查的变更。'));
          }
          break;
        }
        case 'addContextByUris': {
          // Drag & drop from the explorer delivers a text/uri-list.
          for (const raw of message.uris) {
            try {
              const uri = vscode.Uri.parse(raw);
              if (uri.scheme !== 'file') {
                continue;
              }
              this.addContext({
                chipId: `chip-${Math.random().toString(36).slice(2)}`,
                kind: 'file',
                path: vscode.workspace.asRelativePath(uri, false),
                absolutePath: uri.fsPath,
                label: uri.path.split('/').pop() || uri.fsPath,
              });
            } catch {
              // Skip malformed drop entries.
            }
          }
          break;
        }
        case 'attachDiagnostics': {
          const attachment = contexts.diagnosticsAttachment(
            () => `chip-${Math.random().toString(36).slice(2)}`,
          );
          if (!attachment) {
            void vscode.window.showInformationMessage(l10n.t('没有可附加的诊断。'));
            return;
          }
          this.addContext(attachment);
          break;
        }
        case 'hostCommand':
          if (!HOST_COMMAND_WHITELIST.has(message.command)) {
            this.deps.logger.warn(`Blocked forged host command: ${String(message.command)}`);
            break;
          }
          await vscode.commands.executeCommand(`dsh.${message.command}`);
          break;
        case 'resend':
          await service.submitPrompt(message.text, message.attachments);
          break;
        case 'rejectAllEdits':
          await diff.rejectAll();
          break;
        case 'openFile': {
          const target = message.absolutePath ?? message.path;
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch {
            // Non-file or missing path; ignore quietly.
          }
          break;
        }
        default: {
          const exhaustive: never = message;
          this.deps.logger.warn(`Unhandled webview message: ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      this.deps.logger.error(`Message handling failed (${message.type})`, err instanceof Error ? err : undefined);
      this.post({ type: 'error', message: text });
    }
  }

  /** Executes an empty-state quick action with editor context. */
  private async runQuickAction(action: QuickActionId): Promise<void> {
    const { service, contexts } = this.deps;
    if (!(action in QUICK_PROMPTS)) {
      this.deps.logger.warn(`Blocked forged quickAction: ${String(action)}`);
      return;
    }
    await vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    if (action === 'init') {
      await service.submitPrompt(QUICK_PROMPTS.init, []);
      return;
    }
    const attachment = contexts.fromActiveEditor(true);
    if (!attachment || !attachment.selectionText) {
      void vscode.window.showInformationMessage(
        l10n.t('快捷操作需要先在编辑器中选中代码。'),
      );
      return;
    }
    this.addContext(attachment);
    await service.submitPrompt(QUICK_PROMPTS[action], [attachment]);
  }

  private async insertIntoActiveEditor(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Open a file to insert the code block.');
      return;
    }
    await editor.edit((builder) => {
      const selection = editor.selection;
      if (selection.isEmpty) {
        builder.insert(selection.start, code);
      } else {
        builder.replace(selection, code);
      }
    });
    await vscode.window.showTextDocument(editor.document);
  }

  private async buildInitPayload() {
    const folders = vscode.workspace.workspaceFolders;
    const snapshot = this.deps.service.getSnapshot();
    return {
      extensionVersion: this.deps.extensionVersion,
      workspaceName: folders?.[0]?.name ?? 'no workspace',
      language: vscode.env.language,
      hasApiKey: await this.deps.hasApiKey(),
      slashCommands: [],
      authMethods: snapshot.authMethods,
      capabilities: {
        canLoadSession: snapshot.canLoadSession,
        hasModes: true,
      },
    };
  }

  private post(message: ToWebview): void {
    if (this.views.size > 0) {
      this.postNow(message);
    }
    // Keep the status bar in lock-step with every snapshot push.
    if (message.type === 'snapshot') {
      this.deps.status.update(message.payload.status, message.payload.statusDetail, {
        sessionId: message.payload.sessionId?.slice(0, 8),
        pending: message.payload.workingSet.filter((edit) => edit.state === 'pending').length,
      });
    }
    // Messages dropped while the panel is hidden are fine: every view
    // visibility change re-sends a full snapshot.
  }

  private postNow(message: ToWebview): void {
    if (this.views.size === 0) {
      return;
    }
    // The postMessage channel rejects non-plain data ("An object could not
    // be cloned."). Clone to plain JSON at this single boundary; the timeline
    // reducer mutates its entries in place, so this also snapshots the exact
    // state the webview should see.
    let safe: ToWebview;
    try {
      safe = deepClonePlain(message);
    } catch (err) {
      this.deps.logger.error(
        `Dropping webview message that failed serialization (${message.type})`,
        err instanceof Error ? err : undefined,
      );
      return;
    }
    for (const view of this.views) {
      view.webview.postMessage(safe).then(undefined, (err) => {
        this.deps.logger.error(`postMessage failed (${message.type})`, err instanceof Error ? err : undefined);
      });
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'assets', 'index.js'),
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'assets', 'index.css'),
    );
    const codiconCss = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'codicons', 'codicon.css'),
    );
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${codiconCss}" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>DeepSeek Harness</title>
</head>
<body class="dsh-root">
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
