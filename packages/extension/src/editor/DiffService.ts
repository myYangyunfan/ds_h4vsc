/**
 * Reviews proposed file changes with the native VS Code diff editor and
 * applies/reverts them on disk via the workspace API.
 *
 * Two origins exist:
 *  - `toolDiff`: the kernel reported a diff for a tool call. The kernel has
 *    usually applied it already, so "reject" reverts to oldText when known.
 *  - `fsWrite`: the kernel asked the client (us) to write a file through
 *    ACP fs/write_text_file. The write happened while approving, so the edit
 *    starts out applied; reject reverts.
 */
import * as path from 'node:path';
import { l10n } from 'vscode';
import * as vscode from 'vscode';
import type { EditInfo } from '@dsh-vscode/core';
import type { WorkingSet } from './WorkingSet.js';
import type { Logger } from '../util/log.js';

export const EDIT_SCHEME = 'dsh-edit';

interface ParsedEditUri {
  editId: string;
  side: 'old' | 'new';
}

export class DiffService {
  private readonly provider: vscode.TextDocumentContentProvider;

  constructor(
    private readonly workingSet: WorkingSet,
    private readonly logger: Logger,
  ) {
    this.provider = {
      provideTextDocumentContent: (uri) => this.provideContent(uri),
    };
  }

  /** Must be called once from activate(). */
  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(EDIT_SCHEME, this.provider));
  }

  /** Opens the native diff editor for a working-set entry. */
  async openDiff(editId: string): Promise<void> {
    const edit = this.workingSet.get(editId);
    if (!edit) {
      void vscode.window.showWarningMessage(l10n.t('该变更已不在工作集中。'));
      return;
    }
    const fileUri = this.resolveEditPath(edit.path);
    const title = `${path.basename(edit.path)} (Working Set)`;

    const left = this.virtualUri(edit, 'old');
    const right = edit.applied ? fileUri : this.virtualUri(edit, 'new');
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  /** Applies a not-yet-applied edit to disk, or confirms an applied one. */
  async acceptEdit(editId: string): Promise<void> {
    const edit = this.workingSet.get(editId);
    if (!edit) {
      return;
    }
    if (!edit.applied) {
      await this.writeContent(edit.path, edit.newText);
      this.logger.info(`Applied edit ${editId} to ${edit.path}`);
    }
    this.workingSet.update({ ...edit, applied: true, state: 'accepted' });
  }

  /** Reverts an applied edit to oldText (when known), or just drops it. */
  async rejectEdit(editId: string): Promise<void> {
    const edit = this.workingSet.get(editId);
    if (!edit) {
      return;
    }
    if (edit.applied && edit.oldText !== undefined) {
      await this.writeContent(edit.path, edit.oldText);
      this.logger.info(`Reverted edit ${editId} on ${edit.path}`);
    } else if (edit.applied) {
      void vscode.window.showWarningMessage(l10n.t('无法还原 {0}：原始内容未知。', path.basename(edit.path)));
    }
    this.workingSet.update({ ...edit, applied: false, state: 'rejected' });
  }

  async acceptAll(): Promise<void> {
    for (const edit of this.workingSet.list()) {
      if (edit.state !== 'rejected') {
        await this.acceptEdit(edit.editId);
      }
    }
  }

  /**
   * Review loop (Copilot agent-mode style): opens the next pending diff.
   * Returns the opened edit id, or undefined when nothing is pending.
   */
  async openNextPending(): Promise<string | undefined> {
    const next = this.workingSet.list().find((edit) => edit.state === 'pending');
    if (!next) {
      return undefined;
    }
    await this.openDiff(next.editId);
    return next.editId;
  }

  async rejectAll(): Promise<void> {
    for (const edit of this.workingSet.list()) {
      if (edit.state !== 'accepted') {
        await this.rejectEdit(edit.editId);
      }
    }
  }

  /** Called by ChatSessionService when the kernel asks us to write a file. */
  buildFsWriteEdit(editId: string, absolutePath: string, content: string, previous?: string): EditInfo {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const rel = workspaceRoot ? path.relative(workspaceRoot, absolutePath).split(path.sep).join('/') : absolutePath;
    return {
      editId,
      path: rel,
      oldText: previous,
      newText: content,
      applied: true,
      origin: 'fsWrite',
      state: 'pending',
    };
  }

  /** Reads the current disk content of a path, if it exists. */
  async readCurrent(absolutePath: string): Promise<string | undefined> {
    try {
      const uri = vscode.Uri.file(absolutePath);
      const data = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder().decode(data);
    } catch {
      return undefined;
    }
  }

  /** Writes absolute-path content, creating parent folders as needed. */
  async writeFile(absolutePath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(absolutePath);
    const dir = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  // -------------------------------------------------------------------------

  private virtualUri(edit: EditInfo, side: 'old' | 'new'): vscode.Uri {
    const name = path.basename(edit.path);
    return vscode.Uri.from({
      scheme: EDIT_SCHEME,
      authority: edit.editId,
      path: `/${side}/${name}`,
    });
  }

  private provideContent(uri: vscode.Uri): string {
    const parsed = parseEditUri(uri);
    if (!parsed) {
      return '';
    }
    const edit = this.workingSet.get(parsed.editId);
    if (!edit) {
      return '';
    }
    return parsed.side === 'old' ? (edit.oldText ?? '') : edit.newText;
  }

  private async writeContent(relPath: string, content: string): Promise<void> {
    const uri = this.resolveEditPath(relPath);
    const dir = vscode.Uri.joinPath(uri, '..');
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  /**
   * Resolves an edit path (which may be workspace-relative or absolute)
   * consistently for openDiff, accept, and reject.
   */
  private resolveEditPath(editPath: string): vscode.Uri {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root || path.isAbsolute(editPath)) {
      return vscode.Uri.file(editPath);
    }
    return vscode.Uri.joinPath(root, editPath);
  }
}

function parseEditUri(uri: vscode.Uri): ParsedEditUri | undefined {
  const side = uri.path.split('/')[1];
  if (!uri.authority || (side !== 'old' && side !== 'new')) {
    return undefined;
  }
  return { editId: uri.authority, side };
}
