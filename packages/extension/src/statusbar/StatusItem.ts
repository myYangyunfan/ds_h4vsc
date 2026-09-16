/**
 * Single status-bar entry mirroring the session state machine, in the same
 * spirit as Copilot's agent status indicator.
 */
import { l10n } from 'vscode';
import * as vscode from 'vscode';
import type { SessionStatus } from '@dsh-vscode/core';

const STATUS_ICONS: Record<SessionStatus, string> = {
  disconnected: '$(circle-slash)',
  connecting: '$(sync~spin)',
  idle: '$(sparkle)',
  prompting: '$(loading~spin)',
  awaitingApproval: '$(shield)',
  error: '$(error)',
};

const STATUS_LABELS: Record<SessionStatus, () => string> = {
  disconnected: () => 'DSH',
  connecting: () => l10n.t('DSH：连接中'),
  idle: () => 'DSH',
  prompting: () => l10n.t('DSH：工作中'),
  awaitingApproval: () => l10n.t('DSH：等待审批'),
  error: () => l10n.t('DSH：出错'),
};

export class StatusItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'DeepSeek Harness';
    this.item.command = 'dsh.statusMenu';
    this.update('disconnected');
    this.item.show();
  }

  update(
    status: SessionStatus,
    detail?: string,
    extra?: { sessionId?: string; pending?: number },
  ): void {
    this.item.text = `${STATUS_ICONS[status]} ${STATUS_LABELS[status]()}`;
    const lines = ['DeepSeek Harness'];
    if (extra?.sessionId) {
      lines.push(`\n${l10n.t('会话')}: ${extra.sessionId}`);
    }
    if (extra?.pending && extra.pending > 0) {
      lines.push(`\n${l10n.t('待审查变更')}: ${extra.pending}`);
    }
    if (detail) {
      lines.push(`\n${detail}`);
    }
    this.item.tooltip = new vscode.MarkdownString(
      lines.length === 1 ? l10n.t('DeepSeek Harness — 由 dsh 内核驱动的 AI 编码代理') : lines.join(''),
    );
    this.item.backgroundColor =
      status === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
