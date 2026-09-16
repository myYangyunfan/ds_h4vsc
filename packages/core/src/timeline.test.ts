import { describe, expect, it } from 'vitest';
import { TimelineReducer, type TimelineEffect } from './timeline.ts';
import type { AcpSessionUpdate } from './acp.ts';
import type { EditInfo } from './chat.ts';

/** Deterministic id factory for assertions. */
function testIds(): () => string {
  let n = 0;
  return () => `id-${(n += 1)}`;
}

const text = (t: string): AcpSessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: t },
});

describe('TimelineReducer - streaming chunks', () => {
  it('accumulates consecutive agent chunks into one entry', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply(text('Hello '));
    reducer.apply(text('world'));
    expect(reducer.entries).toHaveLength(1);
    const entry = reducer.entries[0]!;
    expect(entry).toMatchObject({ kind: 'assistant', text: 'Hello world' });
  });

  it('starts a new assistant entry after a tool call', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply(text('before'));
    reducer.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read file',
      kind: 'read',
      status: 'in_progress',
    });
    reducer.apply(text('after'));
    const kinds = reducer.entries.map((entry) => entry.kind);
    expect(kinds).toEqual(['assistant', 'toolCall', 'assistant']);
  });

  it('accumulates thoughts on the current assistant entry', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm ' } });
    reducer.apply({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ok' } });
    const entry = reducer.entries[0]!;
    expect(entry.kind === 'assistant' && entry.thought).toBe('hmm ok');
  });

  it('invokes the chunk hook with deltas', () => {
    const seen: string[] = [];
    const reducer = new TimelineReducer(testIds(), {
      onChunkAppended: (_id, role, delta) => seen.push(`${role}:${delta}`),
    });
    reducer.apply(text('a'));
    reducer.apply(text('b'));
    expect(seen).toEqual(['assistant:a', 'assistant:b']);
  });

  it('ignores empty chunks', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply(text(''));
    expect(reducer.entries).toHaveLength(0);
  });
});

describe('TimelineReducer - tool calls', () => {
  it('creates a pending tool call without status', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Search' });
    const entry = reducer.entries[0]!;
    expect(entry.kind === 'toolCall' && entry.toolCall.status).toBe('pending');
  });

  it('merges updates by toolCallId and records duration', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Bash', status: 'in_progress' });
    reducer.apply({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    const entry = reducer.entries[0]!;
    expect(entry.kind === 'toolCall' && entry.toolCall.status).toBe('completed');
    expect(entry.kind === 'toolCall' && entry.toolCall.endedAt).toBeDefined();
  });

  it('collects text content into detailText', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Bash',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'stdout line' } }],
    });
    const entry = reducer.entries[0]!;
    expect(entry.kind === 'toolCall' && entry.toolCall.detailText).toBe('stdout line');
  });
});

describe('TimelineReducer - edits', () => {
  const diffContent = { type: 'diff' as const, path: 'src/a.ts', oldText: 'old', newText: 'new' };

  it('emits one editProposed effect per tool diff', () => {
    const reducer = new TimelineReducer(testIds());
    const effects = reducer.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Edit file',
      kind: 'edit',
      status: 'completed',
      content: [diffContent],
    });
    expect(effects).toHaveLength(1);
    const effect: TimelineEffect = effects[0]!;
    expect(effect.type).toBe('editProposed');
    expect(effect.edit).toMatchObject({
      editId: 'edit-t1',
      path: 'src/a.ts',
      oldText: 'old',
      newText: 'new',
      origin: 'toolDiff',
    } satisfies Partial<EditInfo>);
  });

  it('does not duplicate edits when the update re-sends the diff', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Edit file',
      status: 'in_progress',
      content: [diffContent],
    });
    const effects = reducer.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [diffContent],
    });
    // Same editId is produced again; host dedupes by editId in the working set.
    expect(effects[0]).toMatchObject({ type: 'editProposed', edit: { editId: 'edit-t1' } });
  });

  it('registerEdit replaces an existing entry with the same editId', () => {
    const reducer = new TimelineReducer(testIds());
    const base = { editId: 'e1', path: 'x.ts', newText: 'a', applied: true, origin: 'fsWrite' as const, state: 'pending' as const };
    reducer.registerEdit(base);
    reducer.registerEdit({ ...base, state: 'accepted' });
    expect(reducer.entries).toHaveLength(1);
    const entry = reducer.entries[0]!;
    expect(entry.kind === 'edit' && entry.edit.state).toBe('accepted');
  });
});

describe('TimelineReducer - plan', () => {
  it('keeps a single plan entry that is updated in place', () => {
    const reducer = new TimelineReducer(testIds());
    const plan = {
      sessionUpdate: 'plan' as const,
      entries: [{ content: 'step 1', priority: 'high' as const, status: 'in_progress' as const }],
    };
    reducer.apply(plan);
    reducer.apply({ ...plan, entries: [{ content: 'step 1', priority: 'high', status: 'completed' }] });
    expect(reducer.entries).toHaveLength(1);
    const entry = reducer.entries[0]!;
    expect(entry.kind === 'plan' && entry.entries[0]?.status).toBe('completed');
  });
});

describe('TimelineReducer - approvals', () => {
  it('adds and resolves approvals', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.addApproval({
      approvalId: 'a1',
      title: 'Run command',
      options: [{ optionId: 'opt-1', label: 'Allow', kind: 'allow_once' }],
      state: 'pending',
    });
    expect(reducer.resolveApproval('a1', 'opt-1')).toBe(true);
    expect(reducer.resolveApproval('missing', 'x')).toBe(false);
    const entry = reducer.entries[0]!;
    expect(entry.kind === 'approval' && entry.approval.state).toBe('resolved');
  });
});

describe('TimelineReducer - misc', () => {
  it('ignores unknown update kinds without throwing', () => {
    const reducer = new TimelineReducer(testIds());
    const effects = reducer.apply({ sessionUpdate: 'unknown', observedKind: 'future_thing' });
    expect(effects).toEqual([]);
  });

  it('reset clears everything', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply(text('hi'));
    reducer.reset();
    expect(reducer.entries).toHaveLength(0);
  });

  it('handles user_message_chunk entries', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } });
    const entry = reducer.entries[0]!;
    expect(entry).toMatchObject({ kind: 'user', text: 'echo' });
  });
});

describe('TimelineReducer - restore', () => {
  it('restores entries and rebuilds indexes so updates continue appending', () => {
    const source = new TimelineReducer(testIds());
    source.apply(text('before'));
    source.apply({
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-x',
      title: 'Read',
      kind: 'read',
      status: 'completed',
    });
    const persisted = source.entries.map((entry) => JSON.parse(JSON.stringify(entry)));

    const restored = new TimelineReducer(testIds());
    restored.restore(persisted);
    expect(restored.entries).toHaveLength(2);

    // A subsequent update for the restored tool merges (not duplicates).
    restored.apply({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-x',
      title: 'Read updated',
      status: 'completed',
    });
    expect(restored.entries).toHaveLength(2);
    const toolEntry = restored.entries.find((e) => e.kind === 'toolCall');
    expect(toolEntry && toolEntry.kind === 'toolCall' && toolEntry.toolCall.title).toBe('Read updated');

    // New chunks append normally.
    restored.apply(text('after'));
    expect(restored.entries).toHaveLength(3);
  });

  it('restore of an empty array is a no-op', () => {
    const reducer = new TimelineReducer(testIds());
    reducer.apply(text('x'));
    reducer.restore([]);
    expect(reducer.entries).toHaveLength(0);
  });
});
