/**
 * Builds webview snapshot payloads from the live service state. Keeping the
 * assembly in one pure-ish place makes the host->webview contract easy to
 * review and test.
 */
import type {
  EditInfo,
  SessionMeta,
  SessionStatus,
  SlashCommandInfo,
  TimelineEntry,
} from '@dsh-vscode/core';
import type { AgentModeInfo, AcpAuthenticateMethod } from '@dsh-vscode/core';
import type { WebviewSnapshot } from '@dsh-vscode/core';
import { mergeCommands } from '@dsh-vscode/core';

export interface SnapshotInput {
  status: SessionStatus;
  statusDetail?: string;
  sessionId?: string;
  entries: TimelineEntry[];
  history: SessionMeta[];
  workingSet: EditInfo[];
  kernelCommands: SlashCommandInfo[];
  modes: AgentModeInfo[];
  modeId?: string;
  authMethods: AcpAuthenticateMethod[];
  canLoadSession: boolean;
}

export function buildSnapshot(input: SnapshotInput): WebviewSnapshot {
  return {
    status: input.status,
    statusDetail: input.statusDetail,
    sessionId: input.sessionId,
    entries: input.entries,
    history: input.history,
    workingSet: input.workingSet,
    availableCommands: mergeCommands(input.kernelCommands),
    modes: input.modes,
    modeId: input.modeId,
    authMethods: input.authMethods,
    canLoadSession: input.canLoadSession,
  };
}
