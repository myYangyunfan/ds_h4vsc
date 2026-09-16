/**
 * The sessions list in the activity bar.
 *
 * VS Code binds a view container to one location: the chat panel must live in
 * the secondary (right) side bar, and a container on the activity bar can only
 * render on the left. So the left icon hosts something that genuinely belongs
 * on the left - the workspace's session history - and selecting an entry
 * reopens that session in the panel on the right.
 *
 * A native tree is used rather than a webview: it is cheaper, follows the
 * user's theme and density for free, and an empty tree gets VS Code's built-in
 * welcome content (see `viewsWelcome` in package.json) for first-run guidance.
 */
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import type { SessionMeta } from '@dsh-vscode/core';
import type { SessionStore } from '../chat/SessionStore.js';

export const SESSIONS_VIEW_ID = 'dsh.sessions';

export interface SessionsViewDeps {
  store: SessionStore;
  /** Reopens a session and reveals the chat panel on the right. */
  open: (sessionId: string) => Promise<void>;
  /** Keeps the webview's own history list in step after a mutation. */
  reloadHistory: () => Promise<void>;
}

type Node = { kind: 'new' } | { kind: 'session'; meta: SessionMeta };

export class SessionsView implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly deps: SessionsViewDeps) {}

  /** Re-reads the store and repaints. Safe to call from anywhere. */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'new') {
      const item = new vscode.TreeItem(l10n.t('新对话'), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('add');
      item.command = { command: 'dsh.newChat', title: l10n.t('新对话') };
      return item;
    }
    const { meta } = node;
    const item = new vscode.TreeItem(meta.title, vscode.TreeItemCollapsibleState.None);
    item.id = meta.sessionId;
    item.description = relativeTime(meta.updatedAt);
    item.tooltip = `${meta.title}\n${meta.sessionId}`;
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.contextValue = 'dsh.session';
    item.command = {
      command: 'dsh.sessions.open',
      title: l10n.t('打开会话'),
      arguments: [node],
    };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) {
      return [];
    }
    const metas = await this.deps.store.list();
    if (metas.length === 0) {
      // An empty list lets VS Code show the viewsWelcome guidance instead.
      return [];
    }
    return [{ kind: 'new' }, ...metas.map((meta): Node => ({ kind: 'session', meta }))];
  }

  /** The session a tree item refers to, tolerating a missing argument. */
  static sessionOf(node: unknown): SessionMeta | undefined {
    const candidate = node as Node | undefined;
    return candidate?.kind === 'session' ? candidate.meta : undefined;
  }

  /** Reopens a session in the chat panel and brings the panel to the front. */
  async open(node: unknown): Promise<void> {
    const meta = SessionsView.sessionOf(node);
    if (!meta) {
      return;
    }
    await this.deps.open(meta.sessionId);
  }

  async rename(node: unknown): Promise<void> {
    const meta = SessionsView.sessionOf(node);
    if (!meta) {
      return;
    }
    const title = await vscode.window.showInputBox({
      prompt: l10n.t('输入新的会话标题'),
      value: meta.title,
      ignoreFocusOut: true,
    });
    if (title?.trim()) {
      await this.deps.store.rename(meta.sessionId, title);
      await this.deps.reloadHistory();
    }
  }

  async remove(node: unknown): Promise<void> {
    const meta = SessionsView.sessionOf(node);
    if (!meta) {
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      l10n.t('确认删除会话“{0}”？', meta.title),
      { modal: true },
      l10n.t('删除'),
    );
    if (confirmed) {
      await this.deps.store.remove(meta.sessionId);
      await this.deps.reloadHistory();
    }
  }
}

/** Compact age label for a session row. */
function relativeTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) {
    return l10n.t('刚刚');
  }
  if (minutes < 60) {
    return l10n.t('{0} 分钟前', String(minutes));
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return l10n.t('{0} 小时前', String(hours));
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return l10n.t('{0} 天前', String(days));
  }
  return new Date(timestamp).toLocaleDateString();
}
