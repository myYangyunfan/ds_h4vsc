/**
 * The diff editor's virtual URI layout.
 *
 * This round trip has two consumers - the content provider that serves each side
 * and the diff title-bar commands - and when each decoded it separately, moving
 * the edit id out of the URI authority left the title-bar buttons doing nothing
 * when clicked, with no error anywhere. These cases pin the layout, including
 * the characters that caused it: ids full of underscores, and non-ASCII names.
 */
import { describe, expect, it } from 'vitest';
import { editPathFor, parseEditPath } from '../src/editor/editUri.js';

// The ids and names observed in a real session.
const TOOL_CALL_ID = 'edit-call_00_ET_NnsJJMYx4NzTjXYmQHOq6450';
const CHINESE_NAME = 'KNN_分类.py';

describe('edit URI layout', () => {
  it('round-trips an id with underscores and a non-ASCII file name', () => {
    const path = editPathFor(TOOL_CALL_ID, 'old', CHINESE_NAME);
    expect(parseEditPath(path)).toEqual({ editId: TOOL_CALL_ID, side: 'old' });
    expect(parseEditPath(editPathFor(TOOL_CALL_ID, 'new', CHINESE_NAME))).toEqual({
      editId: TOOL_CALL_ID,
      side: 'new',
    });
  });

  it('encodes both components so neither can be mangled in transit', () => {
    const path = editPathFor(TOOL_CALL_ID, 'old', CHINESE_NAME);
    expect(path.startsWith('/old/')).toBe(true);
    // Percent-encoded, not raw: a raw component is resolved lossily, which showed
    // up as an empty "original" side in the diff editor.
    expect(path).not.toContain('分类');
    expect(path).toContain('%E5%88%86%E7%B1%BB');
  });

  it('accepts a plain ASCII name unchanged', () => {
    expect(parseEditPath(editPathFor('edit-1', 'new', 'src/app.ts'))).toEqual({
      editId: 'edit-1',
      side: 'new',
    });
  });

  it('rejects anything that is not one of ours', () => {
    expect(parseEditPath('')).toBeUndefined();
    expect(parseEditPath('/')).toBeUndefined();
    expect(parseEditPath('/old')).toBeUndefined();
    expect(parseEditPath('/old/')).toBeUndefined();
    expect(parseEditPath('/sideways/edit-1/app.ts')).toBeUndefined();
    // A bare authority-style uri (the previous layout) has no path to parse.
    expect(parseEditPath('/app.ts')).toBeUndefined();
    expect(parseEditPath('/old/%E0%A4%A/app.ts')).toBeUndefined();
  });

  it('keeps the id in the path, never in the authority', () => {
    // The bug: consumers reading `uri.authority` broke the moment the id moved.
    expect(editPathFor(TOOL_CALL_ID, 'old', 'a.ts')).toContain(encodeURIComponent(TOOL_CALL_ID));
  });
});
