/**
 * Wire protocol between the extension host and the chat webview.
 * Messages flow strictly in one direction per channel; the host is the source
 * of truth and periodically pushes full snapshots, while fast streaming text
 * travels as small chunk deltas to keep rendering smooth.
 */
import type {
  ApprovalRequest,
  ContextAttachment,
  EditInfo,
  PlanEntry,
  QuickActionId,
  SessionMeta,
  SessionStatus,
  SlashCommandInfo,
  TimelineEntry,
} from './chat.ts';
import type { AcpAuthenticateMethod } from './acp.ts';

// ---------------------------------------------------------------------------
// Host -> Webview
// ---------------------------------------------------------------------------

export interface AgentModeInfo {
  id: string;
  name: string;
}

export interface WebviewInitPayload {
  extensionVersion: string;
  workspaceName: string;
  /** VS Code display language (e.g. `zh-cn`); webview strings follow it. */
  language: string;
  /** Whether an API key is present in SecretStorage (drives setup hints). */
  hasApiKey: boolean;
  /** Slash commands built into the extension; merged with kernel-provided ones. */
  slashCommands: SlashCommandInfo[];
  authMethods: AcpAuthenticateMethod[];
  capabilities: {
    canLoadSession: boolean;
    hasModes: boolean;
  };
}

export interface WebviewSnapshot {
  status: SessionStatus;
  statusDetail?: string;
  sessionId?: string;
  entries: TimelineEntry[];
  history: SessionMeta[];
  workingSet: EditInfo[];
  availableCommands: SlashCommandInfo[];
  modes: AgentModeInfo[];
  modeId?: string;
  authMethods: AcpAuthenticateMethod[];
  canLoadSession: boolean;
}

export type ToWebview =
  | { type: 'init'; payload: WebviewInitPayload }
  | { type: 'snapshot'; payload: WebviewSnapshot }
  | { type: 'chunk'; entryId: string; textDelta: string; thoughtDelta?: string }
  | { type: 'addContext'; attachment: ContextAttachment }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Webview -> Host
// ---------------------------------------------------------------------------

export type FromWebview =
  | { type: 'ready' }
  | { type: 'submitPrompt'; text: string; attachments: ContextAttachment[] }
  | { type: 'cancel' }
  | { type: 'approve'; approvalId: string; optionId: string }
  | { type: 'openDiff'; editId: string }
  | { type: 'acceptEdit'; editId: string }
  | { type: 'rejectEdit'; editId: string }
  | { type: 'acceptAllEdits' }
  | { type: 'newChat' }
  | { type: 'loadSession'; sessionId: string }
  | { type: 'openFilePicker' }
  | { type: 'authenticate'; methodId: string }
  | { type: 'openSettings' }
  | { type: 'setMode'; modeId: string }
  | { type: 'insertCode'; code: string }
  | { type: 'showPlan'; entries: PlanEntry[] }
  | { type: 'quickAction'; action: QuickActionId }
  | { type: 'reconnect' }
  | { type: 'reviewNext' }
  | { type: 'addContextByUris'; uris: string[] }
  | { type: 'attachDiagnostics' }
  | { type: 'hostCommand'; command: HostCommandId }
  | { type: 'resend'; text: string; attachments: ContextAttachment[] }
  | { type: 'rejectAllEdits' }
  | { type: 'openFile'; path: string; absolutePath?: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isFromWebview(value: unknown): value is FromWebview {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const knownTypes = [
    'ready',
    'submitPrompt',
    'cancel',
    'approve',
    'openDiff',
    'acceptEdit',
    'rejectEdit',
    'acceptAllEdits',
    'newChat',
    'loadSession',
    'openFilePicker',
    'authenticate',
    'openSettings',
    'setMode',
    'insertCode',
    'showPlan',
    'quickAction',
    'reconnect',
    'reviewNext',
    'addContextByUris',
    'attachDiagnostics',
    'hostCommand',
    'resend',
    'rejectAllEdits',
    'openFile',
  ];
  const t = (value as { type?: unknown }).type;
  return typeof t === 'string' && knownTypes.includes(t);
}

/** Runtime guard for host -> webview messages (useful in webview tests). */
export function isToWebview(value: unknown): value is ToWebview {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const t = (value as { type?: unknown }).type;
  return typeof t === 'string' && ['init', 'snapshot', 'chunk', 'addContext', 'error'].includes(t);
}

/** Panel menu actions delegated to whitelisted host commands. */
export type HostCommandId = 'exportChat' | 'renameSession' | 'deleteSession' | 'gitCommitMessage';

/** Convenience accessor for the active approval entry of a timeline. */
export function findPendingApproval(entries: TimelineEntry[]): ApprovalRequest | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.kind === 'approval' && entry.approval.state === 'pending') {
      return entry.approval;
    }
  }
  return undefined;
}

/**
 * Produces a structured-clone-safe copy for crossing the host→webview
 * postMessage boundary. JSON round-trip guarantees plain data: live array
 * references are snapshotted, functions/undefined are dropped, and any
 * non-serializable value (cycles, class instances with accessors) surfaces
 * here - at the boundary with full context - instead of as a DataCloneError
 * inside the platform RPC ("An object could not be cloned.").
 */
export function deepClonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
