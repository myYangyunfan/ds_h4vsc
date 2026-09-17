/**
 * Pure reducer that folds ACP session updates into the chat timeline.
 * No VS Code, no Node, no SDK dependencies - fully unit testable.
 *
 * The reducer mutates its internal entries array in place (cheap snapshots are
 * taken by the caller when pushing state to the webview) and returns a list of
 * side effects that the host must execute (e.g. registering a proposed file
 * edit with the diff/working-set services).
 */
import {
  contentBlockText,
  type AcpSessionUpdate,
  type AcpToolCallContent,
} from './acp.ts';
import type {
  ApprovalRequest,
  ContextAttachment,
  EditInfo,
  PlanEntry,
  TimelineEntry,
  ToolCallInfo,
} from './chat.ts';

export type TimelineEffect = { type: 'editProposed'; edit: EditInfo };

/** Optional streaming hooks so hosts can forward deltas to a webview. */
export interface ReducerHooks {
  onChunkAppended?(entryId: string, role: 'user' | 'assistant', delta: string): void;
  onThoughtAppended?(entryId: string, delta: string): void;
}

let idCounter = 0;

/** Default id factory: monotonic, collision-free within a process. */
export function defaultNewId(): string {
  idCounter += 1;
  return `e${idCounter.toString(36)}-${Math.floor(Math.random() * 0xffff).toString(36)}`;
}

export class TimelineReducer {
  readonly entries: TimelineEntry[] = [];

  private readonly toolEntryIds = new Map<string, string>();
  private readonly approvalEntryIds = new Map<string, string>();
  private readonly editEntryIds = new Map<string, string>();
  private planEntryId: string | undefined;

  constructor(
    private readonly newId: () => string = defaultNewId,
    private readonly hooks: ReducerHooks = {},
  ) {}

  /** Folds one session update into the timeline, returning host effects. */
  apply(update: AcpSessionUpdate): TimelineEffect[] {
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        this.appendChunk('user', contentBlockText(update.content));
        return [];
      case 'agent_message_chunk':
        this.appendChunk('assistant', contentBlockText(update.content));
        return [];
      case 'agent_thought_chunk':
        this.appendThought(contentBlockText(update.content));
        return [];
      case 'tool_call':
      case 'tool_call_update':
        return this.applyToolCall(update);
      case 'plan':
        this.applyPlan(update.entries);
        return [];
      case 'available_commands_update':
      case 'current_mode_update':
      case 'unknown':
        // Handled by the host directly (composer command list / mode picker).
        return [];
      default: {
        const exhaustive: never = update;
        return this.onUnexpected(exhaustive);
      }
    }
  }

  /** Appends a resolved approval to the timeline (host-driven, not from ACP). */
  addApproval(request: ApprovalRequest): void {
    const entryId = this.newId();
    this.approvalEntryIds.set(request.approvalId, entryId);
    this.entries.push({ entryId, kind: 'approval', approval: request });
  }

  /** Updates an existing approval entry after the user made a choice. */
  resolveApproval(approvalId: string, chosenOptionId: string): boolean {
    const entry = this.findEntryByIndex(this.approvalEntryIds.get(approvalId));
    if (!entry || entry.kind !== 'approval') {
      return false;
    }
    entry.approval = {
      ...entry.approval,
      state: 'resolved',
      chosenOptionId,
    };
    return true;
  }

  /** Appends an edit entry proposed/registered by the host (e.g. fs writes). */
  registerEdit(edit: EditInfo): void {
    const existing = this.editEntryIds.get(edit.editId);
    if (existing) {
      this.updateEditEntry(existing, edit);
      return;
    }
    const entryId = this.newId();
    this.editEntryIds.set(edit.editId, entryId);
    this.entries.push({ entryId, kind: 'edit', edit });
  }

  /** Appends a user message with attachments (host-driven on submit). */
  addUserMessage(text: string, attachments: ContextAttachment[]): void {
    this.entries.push({
      entryId: this.newId(),
      kind: 'user',
      text,
      attachments,
      timestamp: Date.now(),
    });
  }

  /** Appends a local error entry (transport failures, kernel crash, ...). */
  addError(text: string): void {
    this.entries.push({ entryId: this.newId(), kind: 'error', text });
  }

  /** Clears all state (new chat). */
  reset(): void {
    this.entries.length = 0;
    this.toolEntryIds.clear();
    this.approvalEntryIds.clear();
    this.editEntryIds.clear();
    this.planEntryId = undefined;
  }

  /**
   * Restores previously persisted entries (after a window reload) and
   * rebuilds the internal index maps for subsequent updates.
   */
  restore(persisted: TimelineEntry[]): void {
    this.reset();
    for (const entry of persisted) {
      this.entries.push(entry);
      switch (entry.kind) {
        case 'toolCall':
          this.toolEntryIds.set(entry.toolCall.toolCallId, entry.entryId);
          break;
        case 'approval':
          this.approvalEntryIds.set(entry.approval.approvalId, entry.entryId);
          break;
        case 'edit':
          this.editEntryIds.set(entry.edit.editId, entry.entryId);
          break;
        case 'plan':
          this.planEntryId = entry.entryId;
          break;
        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private onUnexpected(_value: never): TimelineEffect[] {
    return [];
  }

  private appendChunk(role: 'user' | 'assistant', delta: string): void {
    if (!delta) {
      return;
    }
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === role) {
      last.text += delta;
      this.hooks.onChunkAppended?.(last.entryId, role, delta);
      return;
    }
    if (role === 'assistant') {
      const entryId = this.newId();
      this.entries.push({
        entryId,
        kind: 'assistant',
        text: delta,
        timestamp: Date.now(),
      });
      this.hooks.onChunkAppended?.(entryId, role, delta);
      return;
    }
    const entryId = this.newId();
    this.entries.push({
      entryId,
      kind: 'user',
      text: delta,
      attachments: [],
      timestamp: Date.now(),
    });
    this.hooks.onChunkAppended?.(entryId, role, delta);
  }

  private appendThought(delta: string): void {
    if (!delta) {
      return;
    }
    const last = this.entries[this.entries.length - 1];
    if (last && last.kind === 'assistant') {
      last.thought = (last.thought ?? '') + delta;
      this.hooks.onThoughtAppended?.(last.entryId, delta);
      return;
    }
    const entryId = this.newId();
    this.entries.push({
      entryId,
      kind: 'assistant',
      text: '',
      thought: delta,
      timestamp: Date.now(),
    });
    this.hooks.onThoughtAppended?.(entryId, delta);
  }

  private applyToolCall(
    update: Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>,
  ): TimelineEffect[] {
    const effects: TimelineEffect[] = [];
    const existingEntryId = this.toolEntryIds.get(update.toolCallId);
    const existing = this.findEntryByIndex(existingEntryId);

    if (existing && existing.kind === 'toolCall') {
      const tool = existing.toolCall;
      this.mergeToolCall(tool, update);
      if (update.content) {
        effects.push(...this.collectEditEffects(tool, update.content));
      }
      return effects;
    }

    const tool: ToolCallInfo = {
      toolCallId: update.toolCallId,
      title: update.title ?? update.toolCallId,
      kind: update.kind ?? 'other',
      status: update.status ?? 'pending',
      startedAt: Date.now(),
    };
    this.applyToolContent(tool, update.content);
    const entryId = this.newId();
    this.toolEntryIds.set(update.toolCallId, entryId);
    this.entries.push({ entryId, kind: 'toolCall', toolCall: tool });
    if (update.content) {
      effects.push(...this.collectEditEffects(tool, update.content));
    }
    return effects;
  }

  private mergeToolCall(
    tool: ToolCallInfo,
    update: Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>,
  ): void {
    if (update.title !== undefined) {
      tool.title = update.title;
    }
    if (update.kind !== undefined) {
      tool.kind = update.kind;
    }
    if (update.status !== undefined) {
      tool.status = update.status;
      if (update.status === 'completed' || update.status === 'failed') {
        tool.endedAt = Date.now();
      }
    }
    if (update.content) {
      this.applyToolContent(tool, update.content);
    }
  }

  private applyToolContent(tool: ToolCallInfo, content: AcpToolCallContent[] | undefined): void {
    if (!content) {
      return;
    }
    for (const item of content) {
      if (item.type === 'content' && item.content.type === 'text') {
        tool.detailText = tool.detailText
          ? tool.detailText + item.content.text
          : item.content.text;
      } else if (item.type === 'diff') {
        tool.diff = { path: item.path, oldText: item.oldText, newText: item.newText };
      }
      // 'terminal' content is surfaced via the terminal title only (MVP).
    }
    if (tool.status === 'completed' || tool.status === 'failed') {
      tool.endedAt = tool.endedAt ?? Date.now();
    }
  }

  private collectEditEffects(tool: ToolCallInfo, content: AcpToolCallContent[]): TimelineEffect[] {
    const effects: TimelineEffect[] = [];
    for (const item of content) {
      if (item.type !== 'diff') {
        continue;
      }
      tool.diff = { path: item.path, oldText: item.oldText, newText: item.newText };
      effects.push({
        type: 'editProposed',
        edit: {
          editId: `edit-${tool.toolCallId}`,
          path: item.path,
          oldText: item.oldText,
          newText: item.newText,
          // Agent-side tool diffs are usually already applied by the kernel.
          applied: true,
          origin: 'toolDiff',
          state: 'pending',
        },
      });
    }
    return effects;
  }

  private applyPlan(entries: PlanEntry[]): void {
    if (this.planEntryId) {
      const existing = this.findEntryByIndex(this.planEntryId);
      if (existing && existing.kind === 'plan') {
        existing.entries = entries;
        return;
      }
    }
    const entryId = this.newId();
    this.planEntryId = entryId;
    this.entries.push({ entryId, kind: 'plan', entries });
  }

  private updateEditEntry(entryId: string, edit: EditInfo): void {
    const entry = this.findEntryByIndex(entryId);
    if (entry && entry.kind === 'edit') {
      entry.edit = edit;
    }
  }

  private findEntryByIndex(entryId: string | undefined): TimelineEntry | undefined {
    if (!entryId) {
      return undefined;
    }
    return this.entries.find((entry) => entry.entryId === entryId);
  }
}

/**
 * Reuses the previous object for every entry a snapshot did not change.
 *
 * Snapshots arrive as freshly parsed data, so every entry would otherwise get a
 * new identity on each push and every memoised entry component would re-render -
 * re-parsing the markdown of the whole conversation several times a second while
 * a reply streams. Entries that are byte-identical keep their old reference and
 * React skips them.
 *
 * The comparison is structural rather than field-by-field on purpose: a shallow
 * check cannot see a nested change (a tool call settling, an edit being decided),
 * and a missed change would freeze the UI on stale data. Serializing is far
 * cheaper than the render it avoids.
 *
 * @param previous - Entries currently rendered, in order.
 * @param next - Entries from the incoming snapshot.
 * @returns `next` with unchanged entries replaced by their previous object, or
 *   `previous` itself when nothing changed at all.
 */
export function reconcileEntries(
  previous: readonly TimelineEntry[],
  next: readonly TimelineEntry[],
): TimelineEntry[] {
  if (previous.length === 0) {
    return next as TimelineEntry[];
  }
  let changed = previous.length !== next.length;
  // Same length but a different id sequence means the order changed, which
  // affects the render even though every entry is individually unchanged.
  if (!changed) {
    for (let i = 0; i < next.length; i += 1) {
      if (previous[i]!.entryId !== next[i]!.entryId) {
        changed = true;
        break;
      }
    }
  }
  const byId = new Map(previous.map((entry) => [entry.entryId, entry]));
  const merged = next.map((entry) => {
    const prior = byId.get(entry.entryId);
    if (prior && prior.kind === entry.kind && JSON.stringify(prior) === JSON.stringify(entry)) {
      return prior;
    }
    changed = true;
    return entry;
  });
  return changed ? merged : (previous as TimelineEntry[]);
}
