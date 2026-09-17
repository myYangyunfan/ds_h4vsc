/**
 * Guards the webview -> host message contract.
 *
 * `isFromWebview` deliberately ignores unknown kinds so the two sides can ship
 * independently. The cost is that a message the host does not know is dropped
 * *silently*: the button renders, the click dispatches, and nothing happens -
 * with no error anywhere. That failure mode accounted for several bugs in this
 * codebase (accept/reject, review-next, the session controls), so every kind the
 * webview actually sends is asserted here.
 */
import { readFileSync, globSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isFromWebview } from '@dsh-vscode/core';

const webviewSrc = join(__dirname, '..', '..', 'webview-ui', 'src');

/** Every `{ type: '…' }` handed to send()/postToHost(), including multiline ones. */
function sentKinds(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of globSync('**/*.{ts,tsx}', { cwd: webviewSrc })) {
    const source = readFileSync(join(webviewSrc, file), 'utf8');
    for (const call of source.matchAll(/(?:send|postToHost)\(\{([\s\S]*?)\}\)/g)) {
      const kind = call[1]?.match(/type:\s*'([a-zA-Z]+)'/)?.[1];
      if (kind && !found.has(kind)) {
        found.set(kind, file);
      }
    }
  }
  return found;
}

describe('webview -> host messages', () => {
  it('finds the calls it is meant to be checking', () => {
    // A regex that silently matches nothing would make this file vacuous.
    expect(sentKinds().size).toBeGreaterThan(10);
  });

  it('accepts every kind the webview sends', () => {
    const rejected = [...sentKinds()]
      .filter(([kind]) => !isFromWebview({ type: kind }))
      .map(([kind, file]) => `${kind} (${file})`);
    expect(rejected).toEqual([]);
  });

  it('still ignores unknown kinds, so the two sides can ship independently', () => {
    expect(isFromWebview({ type: 'somethingTheFutureAdds' })).toBe(false);
    expect(isFromWebview({ type: 42 })).toBe(false);
    expect(isFromWebview(null)).toBe(false);
  });
});
