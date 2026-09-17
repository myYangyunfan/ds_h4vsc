/**
 * Per-session conversation storage, backed by workspaceState.
 *
 * The kernel does not replay a conversation over `session/resume` - it returns
 * mode and config state only - so the transcript exists nowhere else. Storing it
 * in a single slot (the previous layout) meant switching conversations destroyed
 * the previous one's text and reopening any session showed an empty chat.
 *
 * Kept free of any `vscode` import so the pruning and migration rules are
 * unit-testable with a memento stub, like `SessionStore`.
 */
import type { EditInfo, TimelineEntry } from '@dsh-vscode/core';
import type { MementoLike } from './SessionStore.js';

const STORAGE_KEY = 'dsh.timelines';
/** Key older builds used for their single-slot layout; read-only, for migration. */
const LEGACY_KEY = 'dsh.timeline';

/**
 * How many conversations stay reopenable. Each entry holds a full transcript, so
 * this bounds what workspaceState has to carry; the oldest are dropped first.
 */
export const MAX_STORED_TIMELINES = 20;

export interface StoredTimeline {
  entries: TimelineEntry[];
  workingSet: EditInfo[];
  updatedAt: number;
}

export class TimelineStore {
  constructor(private readonly memento: MementoLike) {}

  /** Records the current transcript of one session. */
  async save(sessionId: string, entries: TimelineEntry[], workingSet: EditInfo[]): Promise<void> {
    const stored = this.read();
    if (entries.length === 0) {
      // Nothing worth keeping; a conversation emptied by "new chat" must not
      // leave a stale transcript that reopens to blank messages.
      delete stored[sessionId];
    } else {
      // Strictly newer than anything on file: Date.now() alone ties when two
      // sessions are written inside one millisecond, which made "the most recent
      // conversation" ambiguous (and a backwards clock could invert it).
      const newest = Math.max(0, ...Object.values(stored).map((value) => value.updatedAt));
      stored[sessionId] = { entries, workingSet, updatedAt: Math.max(Date.now(), newest + 1) };
    }
    await this.memento.update(STORAGE_KEY, prune(stored));
  }

  /** The stored transcript of one session, if it was kept. */
  load(sessionId: string): StoredTimeline | undefined {
    const value = this.read()[sessionId];
    return value && value.entries.length > 0 ? value : undefined;
  }

  /** The most recently written transcript, which is what a reload should show. */
  latest(): { sessionId: string; timeline: StoredTimeline } | undefined {
    const entries = Object.entries(this.read()).filter(([, value]) => value.entries.length > 0);
    if (entries.length === 0) {
      return undefined;
    }
    const [sessionId, timeline] = entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt)[0]!;
    return { sessionId, timeline };
  }

  /** Drops a session's transcript, e.g. after the user deletes it. */
  async forget(sessionId: string): Promise<void> {
    const stored = this.read();
    if (!(sessionId in stored)) {
      return;
    }
    delete stored[sessionId];
    await this.memento.update(STORAGE_KEY, stored);
  }

  /**
   * Reads the store, folding in the single-slot layout older builds wrote so an
   * upgrade does not lose the conversation that was on screen.
   */
  private read(): Record<string, StoredTimeline> {
    const stored: Record<string, StoredTimeline> = {
      ...this.memento.get<Record<string, StoredTimeline>>(STORAGE_KEY),
    };
    const legacy = this.memento.get<{
      sessionId?: string;
      entries?: TimelineEntry[];
      workingSet?: EditInfo[];
    }>(LEGACY_KEY);
    if (legacy?.sessionId && Array.isArray(legacy.entries) && legacy.entries.length > 0) {
      stored[legacy.sessionId] ??= {
        entries: legacy.entries,
        workingSet: legacy.workingSet ?? [],
        // Deliberately the oldest possible stamp, and constant across reads:
        // `Date.now()` here made the migrated conversation "the most recent" on
        // every single read, so the panel kept reopening it instead of the
        // conversation the user had just been in.
        updatedAt: 0,
      };
    }
    return stored;
  }
}

/** Keeps the most recently written conversations, dropping the rest. */
function prune(stored: Record<string, StoredTimeline>): Record<string, StoredTimeline> {
  return Object.fromEntries(
    Object.entries(stored)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_STORED_TIMELINES),
  );
}
