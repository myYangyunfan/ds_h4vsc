/**
 * The layout of the virtual URIs that back the diff editor's two sides.
 *
 * Kept separate from the VS Code types so the round trip is unit-testable, and
 * kept in one place because it now has two consumers: the content provider that
 * serves each side, and the diff title-bar commands that resolve the active
 * editor back to a working-set entry. When each side decoded the URI itself, a
 * change to the layout broke the title-bar buttons *silently* - they simply did
 * nothing when clicked.
 *
 * Everything lives in the path, percent-encoded. Edit ids contain underscores
 * and file names are frequently non-ASCII, neither of which survives being
 * carried raw in a URI component.
 */

export type DiffSide = 'old' | 'new';

export interface ParsedEditPath {
  editId: string;
  side: DiffSide;
}

/** Path for one side of an edit, e.g. `/old/edit-1/KNN_%E5%88%86%E7%B1%BB.py`. */
export function editPathFor(editId: string, side: DiffSide, fileName: string): string {
  return `/${side}/${encodeURIComponent(editId)}/${encodeURIComponent(fileName)}`;
}

/** Reads that path back, or undefined when it is not one of ours. */
export function parseEditPath(path: string): ParsedEditPath | undefined {
  const [, side, rawId] = path.split('/');
  if ((side !== 'old' && side !== 'new') || !rawId) {
    return undefined;
  }
  try {
    return { editId: decodeURIComponent(rawId), side };
  } catch {
    // A malformed escape sequence is not one of our URIs.
    return undefined;
  }
}
