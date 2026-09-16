/**
 * Workspace-scoped session history. The dsh kernel persists session data on
 * its side; this store only remembers which sessions belong to this workspace
 * so the history picker can offer them for resumption.
 */
import type { SessionMeta } from '@dsh-vscode/core';

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

const STORAGE_KEY = 'dsh.sessions';
const MAX_HISTORY = 50;

export class SessionStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly memento: MementoLike) {}

  async list(): Promise<SessionMeta[]> {
    return this.memento.get<SessionMeta[]>(STORAGE_KEY) ?? [];
  }

  async upsert(sessionId: string, title: string): Promise<void> {
    const sessions = await this.list();
    const existing = sessions.findIndex((s) => s.sessionId === sessionId);
    const meta: SessionMeta = { sessionId, title: title.trim() || 'New chat', updatedAt: Date.now() };
    if (existing >= 0) {
      sessions[existing] = meta;
    } else {
      sessions.unshift(meta);
    }
    const trimmed = sessions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_HISTORY);
    await this.memento.update(STORAGE_KEY, trimmed);
    this.emit();
  }

  async remove(sessionId: string): Promise<void> {
    const sessions = (await this.list()).filter((s) => s.sessionId !== sessionId);
    await this.memento.update(STORAGE_KEY, sessions);
    this.emit();
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const sessions = await this.list();
    const target = sessions.find((s) => s.sessionId === sessionId);
    if (!target) {
      return;
    }
    target.title = title.trim() || target.title;
    await this.memento.update(STORAGE_KEY, sessions);
    this.emit();
  }

  /** Notifies when the history changes, so the sessions view can refresh. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
