import { describe, expect, it } from 'vitest';
import { deepClonePlain, isFromWebview, type ToWebview } from './protocol.ts';
import type { TimelineEntry } from './chat.ts';

describe('deepClonePlain', () => {
  it('round-trips plain payloads', () => {
    const message: ToWebview = {
      type: 'chunk',
      entryId: 'e1',
      textDelta: 'hello',
      thoughtDelta: undefined,
    };
    expect(deepClonePlain(message)).toEqual({ type: 'chunk', entryId: 'e1', textDelta: 'hello' });
  });

  it('snapshots live arrays instead of retaining references', () => {
    const entries: TimelineEntry[] = [
      { entryId: 'a', kind: 'error', text: 'one' },
    ];
    const clone = deepClonePlain({ entries });
    (entries[0] as Extract<TimelineEntry, { kind: 'error' }>).text = 'mutated';
    entries.push({ entryId: 'b', kind: 'error', text: 'two' });
    expect((clone as { entries: TimelineEntry[] }).entries).toEqual([
      { entryId: 'a', kind: 'error', text: 'one' },
    ]);
  });

  it('drops function-valued fields instead of failing structured clone', () => {
    const payload = {
      ok: 1,
      // Functions make postMessage throw "An object could not be cloned.";
      // the JSON boundary drops them.
      callback: () => 42,
    };
    expect(deepClonePlain(payload)).toEqual({ ok: 1 });
  });

  it('throws on circular structures so the boundary can log and drop', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(() => deepClonePlain(a)).toThrow();
  });
});

describe('isFromWebview', () => {
  it('accepts known message types and rejects unknown data', () => {
    expect(isFromWebview({ type: 'ready' })).toBe(true);
    expect(isFromWebview({ type: 'submitPrompt', text: 'x', attachments: [] })).toBe(true);
    expect(isFromWebview({ type: 'futureThing' })).toBe(false);
    expect(isFromWebview('ready')).toBe(false);
    expect(isFromWebview(null)).toBe(false);
  });
});
