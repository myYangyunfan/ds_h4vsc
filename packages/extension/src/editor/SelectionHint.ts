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
 * Off by default? No - but it is a setting (`dsh.selectionHint`) because a hint
 * that follows every selection can get in the way, and selecting text is also
 * how people copy things.
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
    this.decoration.dispose();
  }

  /** Paints the hint on the active editor, or clears it. */
  private refresh(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const selection = editor.selection;
    const show = this.enabled && !selection.isEmpty && editor.document.uri.scheme === 'file';
    // An empty list clears whatever was painted before, which is how the hint
    // disappears again when the selection collapses.
    editor.setDecorations(this.decoration, show ? [new vscode.Range(selection.end, selection.end)] : []);
  }
}
