/**
 * Domain models shared between the extension host and the chat webview.
 * Everything in this module is plain, JSON-serializable data.
 */

export type SessionStatus =
  | 'disconnected'
  | 'connecting'
  | 'idle'
  | 'prompting'
  | 'awaitingApproval'
  | 'error';

// ---------------------------------------------------------------------------
// Context attachments (editor context passed with a prompt)
// ---------------------------------------------------------------------------

export interface ContextAttachmentRange {
  startLine: number;
  endLine: number;
}

export interface ContextAttachment {
  chipId: string;
  kind: 'file' | 'directory' | 'selection' | 'diagnostics';
  /** Workspace-relative or absolute path as shown to the user. */
  path: string;
  /** Absolute path used by the host to resolve content. */
  absolutePath?: string;
  label: string;
  range?: ContextAttachmentRange;
  selectionText?: string;
}

/** Quick actions offered on the empty state and via editor surfaces. */
export type QuickActionId = 'explainSelection' | 'writeTests' | 'refactor' | 'init';

// ---------------------------------------------------------------------------
// Timeline entries
// ---------------------------------------------------------------------------

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolCallKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'other';

export interface ToolCallDiff {
  path: string;
  oldText?: string;
  newText: string;
}

export interface ToolCallInfo {
  toolCallId: string;
  title: string;
  kind: ToolCallKind;
  status: ToolCallStatus;
  /** Short text output attached by the agent (e.g. command output excerpt). */
  detailText?: string;
  /** Diff content attached by the agent for edit-style tools. */
  diff?: ToolCallDiff;
  startedAt: number;
  endedAt?: number;
}

export interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export type EditOrigin = 'toolDiff' | 'fsWrite';

export type EditState = 'pending' | 'accepted' | 'rejected';

export interface EditInfo {
  editId: string;
  path: string;
  oldText?: string;
  newText: string;
  /**
   * True when the content is already on disk: either the agent wrote the file
   * itself, or the client applied it while approving an fs/write_text_file
   * request (Copilot agent-mode style "approve = apply").
   */
  applied: boolean;
  origin: EditOrigin;
  state: EditState;
}

export type ApprovalKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface ApprovalOption {
  optionId: string;
  label: string;
  kind: ApprovalKind;
}

export interface ApprovalRequest {
  approvalId: string;
  toolCallId?: string;
  title: string;
  options: ApprovalOption[];
  state: 'pending' | 'resolved';
  chosenOptionId?: string;
}

export interface SessionMeta {
  sessionId: string;
  title: string;
  updatedAt: number;
}

export type TimelineEntry =
  | {
      entryId: string;
      kind: 'user';
      text: string;
      attachments: ContextAttachment[];
      timestamp: number;
    }
  | {
      entryId: string;
      kind: 'assistant';
      text: string;
      thought?: string;
      timestamp: number;
    }
  | { entryId: string; kind: 'toolCall'; toolCall: ToolCallInfo }
  | { entryId: string; kind: 'plan'; entries: PlanEntry[] }
  | { entryId: string; kind: 'edit'; edit: EditInfo }
  | { entryId: string; kind: 'approval'; approval: ApprovalRequest }
  | { entryId: string; kind: 'error'; text: string };

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export interface SlashCommandInfo {
  name: string;
  description: string;
}
