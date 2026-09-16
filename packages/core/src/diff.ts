/**
 * Minimal line-level unified diff (LCS based). Pure and dependency-free so
 * the webview inline preview and unit tests share one implementation.
 */

export interface DiffLine {
  side: 'ctx' | 'add' | 'del';
  text: string;
}

/**
 * Produces an interleaved unified view of old/new text. Adjacent delete/add
 * runs stay grouped; `maxLines` trims the middle when the diff explodes.
 */
export function lineDiff(
  oldText: string | undefined,
  newText: string,
  maxLines = 120,
): { lines: DiffLine[]; truncated: boolean } {
  const oldLines = oldText === undefined ? [] : oldText.replace(/\n$/, '').split('\n');
  const newLines = newText.replace(/\n$/, '').split('\n');

  // LCS table over line indices; fine for preview-sized files.
  const table: number[][] = Array.from({ length: oldLines.length + 1 }, () =>
    new Array<number>(newLines.length + 1).fill(0),
  );
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      table[i]![j]! =
        oldLines[i] === newLines[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      lines.push({ side: 'ctx', text: oldLines[i]! });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ side: 'del', text: oldLines[i]! });
      i++;
    } else {
      lines.push({ side: 'add', text: newLines[j]! });
      j++;
    }
  }
  while (i < oldLines.length) {
    lines.push({ side: 'del', text: oldLines[i]! });
    i++;
  }
  while (j < newLines.length) {
    lines.push({ side: 'add', text: newLines[j]! });
    j++;
  }

  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }
  const head = lines.slice(0, Math.floor(maxLines / 2));
  const tail = lines.slice(-Math.floor(maxLines / 3));
  return { lines: [...head, ...tail], truncated: true };
}
