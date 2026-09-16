/**
 * Maps ACP permission requests to an in-panel approval card plus a native
 * notification, and remembers the user's choice per session when they pick an
 * "always allow" option.
 */
import { l10n } from 'vscode';
import * as vscode from 'vscode';
import type { ApprovalRequest, ToolCallKind } from '@dsh-vscode/core';
import type { DshSettings } from '../config/Settings.js';

const READ_ONLY_KINDS: ReadonlySet<ToolCallKind> = new Set(['read', 'search', 'think', 'fetch']);

export class ApprovalBridge {
  private readonly pending = new Map<string, (optionId: string | undefined) => void>();

  constructor(private readonly settings: DshSettings) {}

  /** Applies changed settings without a reload (R8). */
  updateSettings(settings: DshSettings): void {
    Object.assign(this.settings, settings);
  }

  /**
   * Resolves a pending approval from the UI. Returns false if the id was not
   * pending (e.g. the request already timed out or the session restarted).
   */
  resolve(approvalId: string, optionId: string): boolean {
    const resolver = this.pending.get(approvalId);
    if (!resolver) {
      return false;
    }
    this.pending.delete(approvalId);
    resolver(optionId);
    return true;
  }

  /** Waits for the user's choice on a converted approval request. */
  awaitChoice(request: ApprovalRequest): Promise<string | undefined> {
    return new Promise((resolveChoice) => {
      this.pending.set(request.approvalId, (optionId) => resolveChoice(optionId));
      void this.notify(request);
    });
  }

  dispose(): void {
    for (const [, resolver] of this.pending) {
      resolver(undefined);
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------

  private async notify(request: ApprovalRequest): Promise<void> {
    const allowOption = request.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always');
    const denyOption = request.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always');
    const items: vscode.MessageItem[] = [];
    if (allowOption) {
      items.push({ title: l10n.t('允许') });
    }
    if (denyOption) {
      items.push({ title: l10n.t('拒绝'), isCloseAffordance: true });
    }

    void vscode.window
      .showInformationMessage(`DeepSeek Harness: ${request.title}`, { modal: false }, ...items)
      .then((picked) => {
        if (!picked) {
          return; // Dismissed; the in-panel card remains.
        }
        const option = picked.title === l10n.t('允许') ? allowOption : denyOption;
        if (option) {
          this.resolve(request.approvalId, option.optionId);
        }
      });
  }

  /** Auto-approval policy for read-only tools (opt-in setting). */
  isAutoApprovable(toolKind: ToolCallKind | undefined): boolean {
    if (!this.settings.autoApproveReadOnly) {
      return false;
    }
    return toolKind !== undefined && READ_ONLY_KINDS.has(toolKind);
  }
}
