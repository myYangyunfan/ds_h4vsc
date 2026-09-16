/**
 * Derives file edits from the kernel's own mutation calls.
 *
 * The kernel's ACP bridge never sends `diff` tool-call content - its
 * implementation contains no diff construction at all and hardcodes
 * `kind: "other"` - so a client that only reacts to `content[].type === "diff"`
 * never sees a single edit. The information is still there though: the
 * `tool_call` event carries the wire tool name in `title` and the model's
 * arguments in `rawInput`, and those name the target file. Reading that file
 * when the call starts and again when it settles yields the exact before/after
 * pair, which is what the diff review UI needs.
 *
 * The tool vocabulary below mirrors `mutationPath` in the kernel's own client
 * (`@deepseek-ai/dsh-client-ui-deliverables`), including its argument
 * validation, so this agrees with what the kernel treats as a mutating call.
 *
 * Only node APIs are used, so this stays unit-testable without the vscode host.
 */
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** One derived change: the file as it was, and as it is now. */
export interface DerivedEdit {
  /** Absolute path of the file that changed. */
  absolutePath: string;
  /** Path as the model spelled it, which is what the UI should show. */
  path: string;
  oldText: string;
  newText: string;
}

interface PendingMutation {
  absolutePath: string;
  path: string;
  before: string;
}

/**
 * A mutating tool call paired with the file content read before it ran.
 * `begin`/`settle` are keyed by ACP toolCallId.
 */
export class FileChangeTracker {
  private readonly pending = new Map<string, PendingMutation>();
  private readonly inFlight = new Set<Promise<unknown>>();

  /**
   * Records the pre-call content for a mutating tool call. Returns true when the
   * call was recognised as a mutation of a readable target.
   *
   * Deliberately synchronous: the kernel announces the call and then runs the
   * tool, and an async read could land *after* the tool already rewrote the
   * file - capturing the post-edit text as the "before" side and silently
   * dropping the diff. Source files are small, so blocking briefly here is the
   * cheaper trade.
   */
  begin(toolCallId: string, toolName: string | undefined, rawInput: unknown, cwd: string): boolean {
    if (!toolCallId) {
      return false;
    }
    const target = mutationPath(toolName, rawInput);
    if (!target) {
      return false;
    }
    const absolutePath = path.resolve(cwd, target);
    let before = '';
    try {
      before = readFileSync(absolutePath, 'utf8');
    } catch {
      // A file that does not exist yet is a creation: the "before" side is empty.
      before = '';
    }
    this.pending.set(toolCallId, { absolutePath, path: target, before });
    return true;
  }

  /**
   * Reads the file again and returns the change, or undefined when the tool
   * failed, was never tracked, or left the file byte-identical.
   */
  settle(toolCallId: string, succeeded: boolean): Promise<DerivedEdit | undefined> {
    const operation = this.settleInternal(toolCallId, succeeded);
    this.inFlight.add(operation);
    void operation.finally(() => this.inFlight.delete(operation));
    return operation;
  }

  private async settleInternal(
    toolCallId: string,
    succeeded: boolean,
  ): Promise<DerivedEdit | undefined> {
    const entry = this.pending.get(toolCallId);
    if (!entry) {
      return undefined;
    }
    this.pending.delete(toolCallId);
    if (!succeeded) {
      return undefined;
    }
    let after: string;
    try {
      after = await fs.readFile(entry.absolutePath, 'utf8');
    } catch {
      // Deleted by the tool; there is no "after" side to review.
      return undefined;
    }
    if (after === entry.before) {
      return undefined;
    }
    return { absolutePath: entry.absolutePath, path: entry.path, oldText: entry.before, newText: after };
  }

  /**
   * Waits for the settle reads already in flight. The turn-end review hook
   * calls this so a diff derived from the last tool call is not missed by a few
   * milliseconds.
   */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Drops tracking state for a call that will never settle. */
  forget(toolCallId: string): void {
    this.pending.delete(toolCallId);
  }

  get trackedCount(): number {
    return this.pending.size;
  }
}

/**
 * The path a supported first-party mutation call targets, or undefined when the
 * call does not mutate a single file. Mirrors the kernel's own reader: a call
 * only counts once its arguments are complete enough to have run.
 */
export function mutationPath(toolName: string | undefined, rawInput: unknown): string | undefined {
  if (!toolName || typeof rawInput !== 'object' || rawInput === null || Array.isArray(rawInput)) {
    return undefined;
  }
  const args = rawInput as Record<string, unknown>;
  switch (toolName) {
    case 'write':
      return typeof args['content'] === 'string' ? pathValue(args['file_path']) : undefined;
    case 'edit':
      return isCompleteEdit(args) ? pathValue(args['file_path']) : undefined;
    case 'str_replace_editor':
      return editorMutationPath(args);
    default:
      return undefined;
  }
}

function isCompleteEdit(args: Record<string, unknown>): boolean {
  const oldString = args['old_string'];
  const newString = args['new_string'];
  return (
    typeof oldString === 'string' &&
    oldString.length > 0 &&
    typeof newString === 'string' &&
    oldString !== newString
  );
}

function editorMutationPath(args: Record<string, unknown>): string | undefined {
  const target = pathValue(args['path']);
  if (!target) {
    return undefined;
  }
  switch (args['command']) {
    case 'create':
      return typeof args['file_text'] === 'string' ? target : undefined;
    case 'str_replace': {
      const oldStr = args['old_str'];
      const newStr = args['new_str'];
      return typeof oldStr === 'string' &&
        oldStr.length > 0 &&
        (newStr === undefined || typeof newStr === 'string')
        ? target
        : undefined;
    }
    case 'insert': {
      const line = args['insert_line'];
      return typeof line === 'number' &&
        Number.isInteger(line) &&
        line >= 0 &&
        typeof args['new_str'] === 'string'
        ? target
        : undefined;
    }
    default:
      return undefined;
  }
}

/** A non-blank path preserves the exact spelling supplied to the tool. */
function pathValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
