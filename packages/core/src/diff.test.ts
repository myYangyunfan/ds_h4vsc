import { describe, expect, it } from 'vitest';
import { lineDiff } from './diff.ts';

describe('lineDiff', () => {
  it('marks pure additions', () => {
    const result = lineDiff('a\nb', 'a\nb\nc\nd');
    expect(result.lines.map((l) => `${l.side}:${l.text}`)).toEqual([
      'ctx:a',
      'ctx:b',
      'add:c',
      'add:d',
    ]);
    expect(result.truncated).toBe(false);
  });

  it('marks pure deletions', () => {
    const result = lineDiff('a\nb\nc', 'a');
    expect(result.lines.map((l) => `${l.side}:${l.text}`)).toEqual(['ctx:a', 'del:b', 'del:c']);
  });

  it('interleaves modifications as del+add pairs', () => {
    const result = lineDiff('a\nb\nc', 'a\nx\nc');
    const kinds = result.lines.map((l) => `${l.side}:${l.text}`);
    expect(kinds).toContain('del:b');
    expect(kinds).toContain('add:x');
    expect(kinds).toEqual(['ctx:a', 'del:b', 'add:x', 'ctx:c']);
  });

  it('treats missing oldText as a new file', () => {
    const result = lineDiff(undefined, 'x\ny');
    expect(result.lines.every((l) => l.side === 'add')).toBe(true);
  });

  it('trims oversized diffs in the middle', () => {
    const old = Array.from({ length: 100 }, (_, n) => `o${n}`).join('\n');
    const next = Array.from({ length: 100 }, (_, n) => (n === 50 ? 'CHANGED' : `o${n}`)).join('\n');
    const result = lineDiff(old, next, 20);
    expect(result.truncated).toBe(true);
    expect(result.lines.length).toBeLessThanOrEqual(20);
  });
});
