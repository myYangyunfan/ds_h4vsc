/**
 * An inline hint that appears at the end of a text selection, telling the user
 * how to send the selection to the chat.
 *
 * Trae renders a floating button anchored to the selection; a VS Code extension
 * cannot do that (there is no selection-anchored, interactive affordance). What
 * is available is a decoration's `after` content, which renders text right after
 * a range - so this is a *hint* carrying the shortcut, and the clickable routes
 * stay the lightbulb (code actions), the editor context menu and the palette.
 *
 * It only appears once the selection has held still (see SETTLE_MS) and can be
 * turned off entirely (`dsh.selectionHint`): selecting text is also how people
 * copy things, and a hint that reacts to every selection change gets in the way.
 */
import { l10n } from 'vscode';
import * as vscode from 'vscode';

/** The shortcut declared for `dsh.chat.addToChat`, per platform. */
function shortcutHint(): string {
  return process.platform === 'darwin' ? '⌘⌥A' : 'Ctrl+Alt+A';
}

export class SelectionHint implements vscode.Disposable {
  private readonly decoration: vscode.TextEditorDecorationType;
  private enabled = true;
  private timer: NodeJS.Timeout | undefined;

  /**
   * How long the selection must hold still before the hint appears.
   *
   * Showing it on every selection change repainted the hint on every mouse move
   * while dragging, which read as constant flashing. Clearing immediately and
   * waiting for the selection to settle means nothing appears mid-drag, and the
   * hint arrives once the selection is what the user meant to select.
   */
  private static readonly SETTLE_MS = 600;

  constructor() {
    this.decoration = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: `  ${shortcutHint()} ${l10n.t('加入对话')}`,
        // Dimmed and spaced so it reads as a hint rather than as code.
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 0 0 1em',
        fontStyle: 'italic',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  /** Wires the editor listeners; returns the disposables for the caller's bag. */
  register(): vscode.Disposable[] {
    return [
      vscode.window.onDidChangeTextEditorSelection(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    ];
  }

  /** Applies the `dsh.selectionHint` setting. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    this.refresh();
  }

  dispose(): void {
    this.cancelPending();
    this.clear();
    this.decoration.dispose();
  }

  /** Clears the hint, then shows it again once the selection stops moving. */
  private refresh(): void {
    this.cancelPending();
    this.clear();
    const editor = vscode.window.activeTextEditor;
    if (!this.enabled || !editor || editor.selection.isEmpty) {
      return;
    }
    if (editor.document.uri.scheme !== 'file') {
      return;
    }
    const target = editor;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.paint(target);
    }, SelectionHint.SETTLE_MS);
  }

  /** Paints the hint, re-checking the state that may have moved on. */
  private paint(editor: vscode.TextEditor): void {
    if (!this.enabled || editor !== vscode.window.activeTextEditor || editor.selection.isEmpty) {
      return;
    }
    const { end } = editor.selection;
    editor.setDecorations(this.decoration, [new vscode.Range(end, end)]);
  }

  /** Clears the hint from every visible editor, not just the active one. */
  private clear(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.decoration, []);
    }
  }

  private cancelPending(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
