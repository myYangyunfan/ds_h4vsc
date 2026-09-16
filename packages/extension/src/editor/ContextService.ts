/**
 * Turns editor state into chat context attachments (active file, selection)
 * and provides the workspace file picker used by the `@` mention flow.
 */
import * as path from 'node:path';
import { l10n } from 'vscode';
import * as vscode from 'vscode';
import type { ContextAttachment } from '@dsh-vscode/core';

export class ContextService {
  constructor(private readonly newChipId: () => string = defaultChipId) {}

  /** Captures the active editor's file and selection, if any. */
  fromActiveEditor(includeSelection: boolean): ContextAttachment | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return undefined;
    }
    const doc = editor.document;
    const selection = editor.selection;
    const hasSelection = includeSelection && !selection.isEmpty;
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(doc.uri);
    const relPath = workspaceRoot
      ? path.relative(workspaceRoot.uri.fsPath, doc.uri.fsPath).split(path.sep).join('/')
      : doc.uri.fsPath;

    return {
      chipId: this.newChipId(),
      kind: hasSelection ? 'selection' : 'file',
      path: relPath,
      absolutePath: doc.uri.fsPath,
      label: hasSelection ? `${path.basename(relPath)} (selection)` : path.basename(relPath),
      range: hasSelection
        ? { startLine: selection.start.line + 1, endLine: selection.end.line + 1 }
        : undefined,
      selectionText: hasSelection ? doc.getText(selection) : undefined,
    };
  }

  /**
   * Builds a diagnostics context attachment for the active file (or the
   * whole workspace when no editor is open). Returns undefined when clean.
   */
  diagnosticsAttachment(newChipId: () => string): ContextAttachment | undefined {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    const diagnostics = uri
      ? vscode.languages.getDiagnostics(uri)
      : vscode.languages.getDiagnostics().flatMap((file) => file[1]);
    const relevant = diagnostics.slice(0, 8);
    if (relevant.length === 0) {
      return undefined;
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
    return {
      chipId: newChipId(),
      kind: 'diagnostics',
      path: relPath,
      label: l10n.t('问题诊断'),
      selectionText: text,
    };
  }

  /** Shows a QuickPick of workspace files for `@` mentions. */
  async pickFile(): Promise<ContextAttachment | undefined> {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showErrorMessage(l10n.t('请先打开一个文件夹再附加文件。'));
      return undefined;
    }
    // Open editors come first (Copilot-style recent context priority).
    const openUris: vscode.Uri[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = (tab.input as { uri?: vscode.Uri } | undefined)?.uri;
        if (uri?.scheme === 'file' && !openUris.some((u) => u.toString() === uri.toString())) {
          openUris.push(uri);
        }
      }
    }
    const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 2_000);
    if (files.length === 0 && openUris.length === 0) {
      return undefined;
    }
    const describe = (uri: vscode.Uri): string => {
      const root = vscode.workspace.getWorkspaceFolder(uri);
      return root ? path.relative(root.uri.fsPath, uri.fsPath).split(path.sep).join('/') : uri.fsPath;
    };
    const openItems = openUris.map((uri) => ({
      label: path.basename(uri.fsPath),
      description: `${describe(uri)} · ${l10n.t('已打开')}`,
      uri,
    }));
    const searchItems = files
      .filter((uri) => !openUris.some((u) => u.toString() === uri.toString()))
      .map((uri) => ({ label: path.basename(uri.fsPath), description: describe(uri), uri }));
    const picked = await vscode.window.showQuickPick([...openItems, ...searchItems], {
      placeHolder: l10n.t('选择要附加为上下文的文件'),
      matchOnDescription: true,
      matchOnDetail: false,
    });
    if (!picked) {
      return undefined;
    }
    return {
      chipId: this.newChipId(),
      kind: 'file',
      path: describe(picked.uri),
      absolutePath: picked.uri.fsPath,
      label: picked.label,
    };
  }
}

let chipCounter = 0;

function defaultChipId(): string {
  chipCounter += 1;
  return `chip-${chipCounter.toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
}
