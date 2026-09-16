/**
 * Unit tests for host-side service logic that does not need the vscode API.
 * Pure-domain services (WorkingSet, SessionStore) receive a memento stub.
 */
import { describe, expect, it } from 'vitest';

// WorkingSet is vscode-free (plain domain types), so it can be imported directly.
import { WorkingSet } from '../src/editor/WorkingSet.js';
import { SessionStore, type MementoLike } from '../src/chat/SessionStore.js';
import type { EditInfo } from '@dsh-vscode/core';

function memoryMemento(): MementoLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T>(key: string) => (store.has(key) ? (store.get(key) as T) : undefined),
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function edit(editId: string, state: EditInfo['state'] = 'pending'): EditInfo {
  return { editId, path: `src/${editId}.ts`, oldText: 'a', newText: 'b', applied: true, origin: 'toolDiff', state };
}

describe('WorkingSet', () => {
  it('registers, updates and counts pending edits', () => {
    const ws = new WorkingSet();
    ws.registerEdit(edit('e1'));
    ws.registerEdit(edit('e2', 'accepted'));
    expect(ws.pendingCount()).toBe(1);
    expect(ws.list()).toHaveLength(2);
    ws.update({ ...ws.get('e1')!, state: 'rejected' });
    expect(ws.pendingCount()).toBe(0);
  });

  it('notifies listeners on change', () => {
    const ws = new WorkingSet();
    let fired = 0;
    const off = ws.onChange(() => (fired += 1));
    ws.registerEdit(edit('e1'));
    expect(fired).toBe(1);
    ws.clear();
    expect(fired).toBe(2);
    off();
    ws.registerEdit(edit('e2'));
    expect(fired).toBe(2);
  });
});

describe('SessionStore', () => {
  it('upserts newest-first and caps history', async () => {
    const store = new SessionStore(memoryMemento());
    await store.upsert('s1', 'First');
    await store.upsert('s2', 'Second');
    const list = await store.list();
    expect(list[0]!.sessionId).toBe('s2');
    expect(list).toHaveLength(2);
  });

  it('renames without changing order', async () => {
    const store = new SessionStore(memoryMemento());
    await store.upsert('s1', 'Old');
    await store.rename('s1', 'New title');
    const list = await store.list();
    expect(list[0]!.title).toBe('New title');
  });

  it('removes sessions', async () => {
    const store = new SessionStore(memoryMemento());
    await store.upsert('s1', 'A');
    await store.upsert('s2', 'B');
    await store.remove('s1');
    expect(await store.list()).toHaveLength(1);
  });
});
