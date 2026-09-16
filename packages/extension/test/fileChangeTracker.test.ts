/**
 * The kernel sends no `diff` tool-call content, so reviewable edits are derived
 * from its mutation calls: read the target file when the call starts, read it
 * again when it settles. These tests pin both the tool vocabulary (ported from
 * the kernel's own client) and the before/after derivation.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileChangeTracker, mutationPath } from '../src/editor/FileChangeTracker.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-diff-'));
}

describe('mutationPath', () => {
  it('reads `write` arguments', () => {
    expect(mutationPath('write', { file_path: 'a.ts', content: 'x' })).toBe('a.ts');
    // Content is required: a call missing it never wrote anything.
    expect(mutationPath('write', { file_path: 'a.ts' })).toBeUndefined();
  });

  it('requires a complete `edit`', () => {
    expect(mutationPath('edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })).toBe('a.ts');
    expect(mutationPath('edit', { file_path: 'a.ts', old_string: '', new_string: 'y' })).toBeUndefined();
    // A no-op replacement is not an edit.
    expect(mutationPath('edit', { file_path: 'a.ts', old_string: 'x', new_string: 'x' })).toBeUndefined();
  });

  it('reads the mutating `str_replace_editor` commands only', () => {
    const base = { path: 'a.ts' };
    expect(mutationPath('str_replace_editor', { ...base, command: 'create', file_text: '' })).toBe('a.ts');
    expect(mutationPath('str_replace_editor', { ...base, command: 'str_replace', old_str: 'a' })).toBe('a.ts');
    expect(mutationPath('str_replace_editor', { ...base, command: 'insert', insert_line: 0, new_str: 'a' })).toBe('a.ts');
    // `view` reads, and an insert with a bad line number never ran.
    expect(mutationPath('str_replace_editor', { ...base, command: 'view' })).toBeUndefined();
    expect(mutationPath('str_replace_editor', { ...base, command: 'insert', insert_line: -1, new_str: 'a' })).toBeUndefined();
  });

  it('ignores reads, unknown tools, and malformed arguments', () => {
    expect(mutationPath('read', { file_path: 'a.ts' })).toBeUndefined();
    expect(mutationPath('bash', { command: 'rm a.ts' })).toBeUndefined();
    expect(mutationPath(undefined, { file_path: 'a.ts' })).toBeUndefined();
    expect(mutationPath('write', 'not-an-object')).toBeUndefined();
    expect(mutationPath('write', null)).toBeUndefined();
    expect(mutationPath('write', { file_path: '   ', content: 'x' })).toBeUndefined();
  });
});

describe('FileChangeTracker', () => {
  it('derives the before/after pair of an edit', async () => {
    const cwd = workspace();
    const file = join(cwd, 'a.ts');
    writeFileSync(file, 'one\ntwo\n', 'utf8');

    const tracker = new FileChangeTracker();
    expect(tracker.begin('call-1', 'write', { file_path: 'a.ts', content: 'x' }, cwd)).toBe(true);
    writeFileSync(file, 'one\ntwo\nthree\n', 'utf8');

    const edit = await tracker.settle('call-1', true);
    expect(edit).toMatchObject({ path: 'a.ts', oldText: 'one\ntwo\n', newText: 'one\ntwo\nthree\n' });
    expect(edit?.absolutePath).toBe(file);
    expect(tracker.trackedCount).toBe(0);
  });

  it('treats a missing file as a creation with an empty before side', async () => {
    const cwd = workspace();
    const tracker = new FileChangeTracker();
    tracker.begin('call-2', 'write', { file_path: 'new.ts', content: 'hi' }, cwd);
    writeFileSync(join(cwd, 'new.ts'), 'hi', 'utf8');

    const edit = await tracker.settle('call-2', true);
    expect(edit).toMatchObject({ path: 'new.ts', oldText: '', newText: 'hi' });
  });

  it('reports nothing when the tool failed or the file did not change', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'a.ts'), 'same', 'utf8');

    const failure = new FileChangeTracker();
    failure.begin('call-3', 'edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, cwd);
    writeFileSync(join(cwd, 'a.ts'), 'changed', 'utf8');
    expect(await failure.settle('call-3', false)).toBeUndefined();

    const untouched = new FileChangeTracker();
    untouched.begin('call-4', 'edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, cwd);
    expect(await untouched.settle('call-4', true)).toBeUndefined();
  });

  it('drains in-flight reads so the turn-end review hook sees the last edit', async () => {
    const cwd = workspace();
    const file = join(cwd, 'a.ts');
    writeFileSync(file, 'before', 'utf8');
    const tracker = new FileChangeTracker();

    tracker.begin('call-5', 'write', { file_path: 'a.ts', content: 'x' }, cwd);
    writeFileSync(file, 'after', 'utf8');
    await tracker.drain();
    

    const edit = await tracker.settle('call-5', true);
    expect(edit?.newText).toBe('after');
  });

  it('ignores a call it cannot attribute to a file', async () => {
    const cwd = workspace();
    const tracker = new FileChangeTracker();
    expect(tracker.begin('call-6', 'bash', { command: 'ls' }, cwd)).toBe(false);
    expect(tracker.trackedCount).toBe(0);
    expect(await tracker.settle('call-6', true)).toBeUndefined();
  });

  it('resolves relative paths against the workspace root', async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'nested.txt'), readFileSync(new URL(import.meta.url), 'utf8').slice(0, 5), 'utf8');
    const tracker = new FileChangeTracker();
    tracker.begin('call-7', 'write', { file_path: 'nested.txt', content: 'x' }, cwd);
    writeFileSync(join(cwd, 'nested.txt'), 'replaced', 'utf8');
    const edit = await tracker.settle('call-7', true);
    expect(edit?.absolutePath).toBe(join(cwd, 'nested.txt'));
  });
});
