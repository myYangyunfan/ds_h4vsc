/**
 * Minimal, dependency-free typings for the subset of the Agent Client Protocol
 * (ACP) that this extension consumes. These types intentionally mirror the
 * schema of @agentclientprotocol/sdk so that `AcpClient` in the extension can
 * map SDK objects into these structures with plain field copies.
 *
 * Keeping a local subset means the pure reducer in `timeline.ts` stays
 * unit-testable without loading the SDK.
 */
import type {
  ApprovalKind,
  ContextUsage,
  PlanEntry,
  SessionConfigOption,
  SessionConfigValue,
  SlashCommandInfo,
  ToolCallKind,
  ToolCallStatus,
} from './chat.ts';

export interface AcpTextContent {
  type: 'text';
  text: string;
}

export interface AcpResourceLinkContent {
  type: 'resource_link';
  uri: string;
  name?: string;
}

export interface AcpOtherContent {
  type: 'image' | 'audio' | 'resource';
}

export type AcpContentBlock = AcpTextContent | AcpResourceLinkContent | AcpOtherContent;

export type AcpToolCallContent =
  | { type: 'content'; content: AcpContentBlock }
  | { type: 'diff'; path: string; oldText?: string; newText: string }
  | { type: 'terminal'; terminalId: string };

interface ToolCallUpdateFields {
  toolCallId: string;
  title?: string;
  kind?: ToolCallKind;
  status?: ToolCallStatus;
  content?: AcpToolCallContent[];
  rawInput?: unknown;
}

export type AcpSessionUpdate =
  | ({ sessionUpdate: 'user_message_chunk' } & AcpChunkFields)
  | ({ sessionUpdate: 'agent_message_chunk' } & AcpChunkFields)
  | ({ sessionUpdate: 'agent_thought_chunk' } & AcpChunkFields)
  | ({ sessionUpdate: 'tool_call' } & ToolCallUpdateFields)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCallUpdateFields)
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | { sessionUpdate: 'available_commands_update'; commands: SlashCommandInfo[] }
  | { sessionUpdate: 'current_mode_update'; currentModeId: string }
  | { sessionUpdate: 'config_options'; options: SessionConfigOption[] }
  | { sessionUpdate: 'usage'; usage: ContextUsage }
  | { sessionUpdate: 'unknown'; observedKind: string };

interface AcpChunkFields {
  content: AcpContentBlock;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: ApprovalKind;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: { toolCallId: string; title?: string };
  options: AcpPermissionOption[];
}

export interface AcpPermissionOutcome {
  outcome: 'selected' | 'cancelled';
  optionId?: string;
}

export interface AcpAuthenticateMethod {
  id: string;
  name?: string;
  description?: string;
}

/** A resource-link style prompt block used to hand files to the agent. */
export interface PromptContentBlock {
  type: 'text' | 'resource_link';
  text?: string;
  uri?: string;
  name?: string;
}

export type PromptStopReason = 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' | 'other';

/** Handlers the client (editor) must answer while a kernel is connected. */
export interface KernelHandlers {
  onSessionUpdate(sessionId: string, update: AcpSessionUpdate): void;
  onPermissionRequest(req: AcpPermissionRequest): Promise<AcpPermissionOutcome>;
  onReadTextFile(req: { sessionId: string; path: string; line?: number; limit?: number }): Promise<{ content: string }>;
  onWriteTextFile(req: { sessionId: string; path: string; content: string }): Promise<void>;
  onExit(code: number | null): void;
}

/** Extracts the plain text of a content block, if any. */
export function contentBlockText(block: AcpContentBlock | undefined): string {
  if (!block) {
    return '';
  }
  return block.type === 'text' ? block.text : '';
}

/** Normalizes an SDK session update into the local subset. */
export function normalizeSessionUpdate(raw: Record<string, unknown>): AcpSessionUpdate {
  const kind = typeof raw['sessionUpdate'] === 'string' ? raw['sessionUpdate'] : 'unknown';
  switch (kind) {
    case 'user_message_chunk':
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
      return { sessionUpdate: kind, content: raw['content'] as AcpContentBlock };
    case 'tool_call':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: String(raw['toolCallId'] ?? ''),
        title: raw['title'] === undefined ? undefined : String(raw['title']),
        kind: raw['kind'] as ToolCallKind | undefined,
        status: raw['status'] as ToolCallStatus | undefined,
        content: raw['content'] as AcpToolCallContent[] | undefined,
        rawInput: raw['rawInput'],
      };
    case 'tool_call_update':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: String(raw['toolCallId'] ?? ''),
        title: raw['title'] === undefined ? undefined : String(raw['title']),
        kind: raw['kind'] as ToolCallKind | undefined,
        status: raw['status'] as ToolCallStatus | undefined,
        content: raw['content'] as AcpToolCallContent[] | undefined,
        rawInput: raw['rawInput'],
      };
    case 'plan':
      // Copy - raw values come from the SDK and must not be retained.
      return {
        sessionUpdate: kind,
        entries: Array.isArray(raw['entries'])
          ? (raw['entries'] as PlanEntry[]).map((entry) => ({ ...entry }))
          : [],
      };
    case 'available_commands_update':
      return {
        sessionUpdate: kind,
        commands: Array.isArray(raw['commands'])
          ? (raw['commands'] as SlashCommandInfo[]).map((command) => ({
              name: String(command?.name ?? ''),
              description: command?.description === undefined ? '' : String(command.description),
            }))
          : [],
      };
    case 'current_mode_update':
      return {
        sessionUpdate: kind,
        currentModeId: String(raw['currentModeId'] ?? ''),
      };
    case 'config_option_update':
      // The kernel re-sends the whole option list on every change (including
      // the initial one), so this is authoritative rather than a patch.
      return { sessionUpdate: 'config_options', options: normalizeConfigOptions(raw['configOptions']) };
    case 'usage_update':
      return {
        sessionUpdate: 'usage',
        usage: { used: Number(raw['used'] ?? 0), size: Number(raw['size'] ?? 0) },
      };
    default:
      return { sessionUpdate: 'unknown', observedKind: kind };
  }
}

/**
 * Maps the kernel's session configuration options (model, reasoning effort, ...)
 * into the shape the panel renders.
 *
 * Values are opaque: a model value looks like `["provider","name"]`, so it is
 * carried as a string and echoed back verbatim rather than parsed.
 */
export function normalizeConfigOptions(raw: unknown): SessionConfigOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const options: SessionConfigOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const source = entry as Record<string, unknown>;
    const id = typeof source['id'] === 'string' ? source['id'] : '';
    if (!id) {
      continue;
    }
    options.push({
      id,
      name: typeof source['name'] === 'string' ? source['name'] : id,
      category: typeof source['category'] === 'string' ? source['category'] : undefined,
      type: typeof source['type'] === 'string' ? source['type'] : 'select',
      currentValue: typeof source['currentValue'] === 'string' ? source['currentValue'] : '',
      options: normalizeConfigChoices(source['options']),
    });
  }
  return options;
}

function normalizeConfigChoices(raw: unknown): SessionConfigOption['options'] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const choices: SessionConfigOption['options'] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const source = entry as Record<string, unknown>;
    if (Array.isArray(source['options'])) {
      choices.push({
        group: typeof source['group'] === 'string' ? source['group'] : '',
        name: typeof source['name'] === 'string' ? source['name'] : '',
        options: normalizeConfigChoices(source['options']) as SessionConfigValue[],
      });
      continue;
    }
    const value = source['value'];
    if (typeof value !== 'string') {
      continue;
    }
    choices.push({
      value,
      name: typeof source['name'] === 'string' ? source['name'] : value,
      description: typeof source['description'] === 'string' ? source['description'] : undefined,
    });
  }
  return choices;
}
