/**
 * The working set: every proposed/observed file change of the current chat.
 * Mirrors the "changed files" list of Copilot agent mode. The webview renders
 * it from snapshots; accept/reject actions are executed by the DiffService.
 */
import type { EditInfo } from '@dsh-vscode/core';

export class WorkingSet {
  private readonly edits = new Map<string, EditInfo>();
  private readonly listeners = new Set<() => void>();

  registerEdit(edit: EditInfo): void {
    this.edits.set(edit.editId, edit);
    this.emit();
  }

  get(editId: string): EditInfo | undefined {
    return this.edits.get(editId);
  }

  update(edit: EditInfo): void {
    this.edits.set(edit.editId, edit);
    this.emit();
  }

  list(): EditInfo[] {
    return [...this.edits.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  pendingCount(): number {
    let count = 0;
    for (const edit of this.edits.values()) {
      if (edit.state === 'pending') {
        count += 1;
      }
    }
    return count;
  }

  clear(): void {
    this.edits.clear();
    this.emit();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
