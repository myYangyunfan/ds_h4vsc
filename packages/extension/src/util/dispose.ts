import type * as vscode from 'vscode';

/** Collects disposables so that activation can register everything tersely. */
export class DisposableBag implements vscode.Disposable {
  private readonly items: vscode.Disposable[] = [];

  push<T extends vscode.Disposable>(item: T): T {
    this.items.push(item);
    return item;
  }

  dispose(): void {
    for (const item of this.items.splice(0)) {
      item.dispose();
    }
  }
}

/** Invokes an async disposable on teardown, swallowing secondary errors. */
export async function disposeQuietly(target: { dispose(): unknown } | undefined): Promise<void> {
  if (!target) {
    return;
  }
  try {
    await target.dispose();
  } catch {
    // Teardown must never throw.
  }
}
