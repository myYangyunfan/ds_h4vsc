/**
 * Per-session conversation storage. The kernel never replays a conversation over
 * `session/resume`, so this store is the only place a transcript exists - and a
 * single-slot layout (what it replaced) silently destroyed the previous one when
 * the user switched sessions.
 */
import { describe, expect, it } from 'vitest';
import type { EditInfo, TimelineEntry } from '@dsh-vscode/core';
import { MAX_STORED_TIMELINES, TimelineStore } from '../src/chat/TimelineStore.js';
import type { MementoLike } from '../src/chat/SessionStore.js';

function memoryMemento(): MementoLike & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: <T,>(key: string) => (store.has(key) ? (store.get(key) as T) : undefined),
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

function transcript(...texts: string[]): TimelineEntry[] {
  return texts.map((text, index) => ({
    entryId: `e${index}`,
    kind: 'user',
    text,
    attachments: [],
    timestamp: index,
  }));
}

function edit(editId: string): EditInfo {
  return {
    editId,
    path: `${editId}.ts`,
    oldText: 'a',
    newText: 'b',
    applied: true,
    origin: 'toolDiff',
    state: 'pending',
  };
}

describe('TimelineStore', () => {
  it('keeps a transcript per session instead of one shared slot', async () => {
    const store = new TimelineStore(memoryMemento());
    await store.save('s1', transcript('first chat'), []);
    await store.save('s2', transcript('second chat'), []);

    // The point of the rewrite: writing s2 must not destroy s1.
    expect(store.load('s1')?.entries.map((e) => e.kind === 'user' && e.text)).toEqual(['first chat']);
    expect(store.load('s2')?.entries).toHaveLength(1);
  });

  it('round-trips the working set alongside the transcript', async () => {
    const store = new TimelineStore(memoryMemento());
    await store.save('s1', transcript('hi'), [edit('edit-1')]);
    expect(store.load('s1')?.workingSet.map((e) => e.editId)).toEqual(['edit-1']);
  });

  it('reports the most recently written session as the one to restore', async () => {
    const store = new TimelineStore(memoryMemento());
    await store.save('s1', transcript('older'), []);
    await store.save('s2', transcript('newer'), []);
    expect(store.latest()?.sessionId).toBe('s2');
  });

  it('has nothing to restore when no transcript was kept', async () => {
    const store = new TimelineStore(memoryMemento());
    expect(store.latest()).toBeUndefined();
    expect(store.load('missing')).toBeUndefined();
  });

  it('drops a session emptied by "new chat" rather than storing a blank transcript', async () => {
    const store = new TimelineStore(memoryMemento());
    await store.save('s1', transcript('hi'), []);
    await store.save('s1', [], []);
    expect(store.load('s1')).toBeUndefined();
  });

  it('forgets a deleted session without touching the others', async () => {
    const store = new TimelineStore(memoryMemento());
    await store.save('s1', transcript('one'), []);
    await store.save('s2', transcript('two'), []);
    await store.forget('s1');
    expect(store.load('s1')).toBeUndefined();
    expect(store.load('s2')).toBeDefined();
  });

  it('caps how many conversations it carries, dropping the oldest', async () => {
    const memento = memoryMemento();
    const store = new TimelineStore(memento);
    // Writes land in the same millisecond here, which is why save() has to make
    // the ordering strictly increasing rather than trusting the clock.
    for (let i = 0; i < MAX_STORED_TIMELINES + 5; i += 1) {
      await store.save(`s${i}`, transcript(`chat ${i}`), []);
    }
    const raw = memento.store.get('dsh.timelines') as Record<string, unknown>;
    expect(Object.keys(raw)).toHaveLength(MAX_STORED_TIMELINES);
    expect(store.load('s0')).toBeUndefined();
    expect(store.load(`s${MAX_STORED_TIMELINES + 4}`)).toBeDefined();
  });

  it('adopts the single-slot layout older builds wrote', async () => {
    const memento = memoryMemento();
    memento.store.set('dsh.timeline', {
      sessionId: 'legacy-session',
      entries: transcript('written by an older build'),
      workingSet: [],
    });
    const store = new TimelineStore(memento);
    expect(store.load('legacy-session')?.entries).toHaveLength(1);
    expect(store.latest()?.sessionId).toBe('legacy-session');
  });

  it('lets a newer conversation outrank the migrated one, across a reload', async () => {
    // Regression: the migrated entry used to be re-stamped with `Date.now()` on
    // every read, so after a reload it was "the most recent" again and the panel
    // reopened the pre-upgrade conversation instead of the one just used. The
    // second store below is what a window reload looks like.
    const memento = memoryMemento();
    memento.store.set('dsh.timeline', {
      sessionId: 'legacy-session',
      entries: transcript('from before the upgrade'),
      workingSet: [],
    });

    const beforeReload = new TimelineStore(memento);
    expect(beforeReload.latest()?.sessionId).toBe('legacy-session');
    await beforeReload.save('fresh-session', transcript('just now'), []);

    const afterReload = new TimelineStore(memento);
    expect(afterReload.latest()?.sessionId).toBe('fresh-session');
    expect(afterReload.load('legacy-session')?.entries).toHaveLength(1);
  });

  it('prefers the per-session entry when both layouts describe a session', async () => {
    const memento = memoryMemento();
    const store = new TimelineStore(memento);
    await store.save('s1', transcript('current', 'layout'), []);
    memento.store.set('dsh.timeline', {
      sessionId: 's1',
      entries: transcript('stale'),
      workingSet: [],
    });
    expect(store.load('s1')?.entries).toHaveLength(2);
  });
});
