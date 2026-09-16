/**
 * ACP (Agent Client Protocol) client bound to a dsh kernel child process.
 *
 * This module is VS Code-free so it can be integration-tested against a mock
 * ACP agent in plain vitest. All ACP knowledge funnels through here; the rest
 * of the extension only sees typed callbacks and core domain types.
 */
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  AcpAuthenticateMethod,
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpSessionUpdate,
} from '@dsh-vscode/core';
import { normalizeSessionUpdate, type AgentModeInfo } from '@dsh-vscode/core';

export type StopReason = 'end_turn' | 'cancelled' | 'refusal' | 'max_tokens' | 'other';

export interface PromptContentBlock {
  type: 'text' | 'resource_link';
  text?: string;
  uri?: string;
  name?: string;
}

export interface KernelHandlers {
  onSessionUpdate(sessionId: string, update: AcpSessionUpdate): void;
  onPermissionRequest(req: AcpPermissionRequest): Promise<AcpPermissionOutcome>;
  onReadTextFile(req: { sessionId: string; path: string; line?: number; limit?: number }): Promise<{ content: string }>;
  onWriteTextFile(req: { sessionId: string; path: string; content: string }): Promise<void>;
  onExit(code: number | null): void;
}

export interface SessionHandle {
  sessionId: string;
  modes: AgentModeInfo[];
  modeId?: string;
}

interface SessionModeState {
  currentModeId?: string;
  availableModes?: Array<{ id: string; name: string; description?: string }>;
}

/** Extracts the optional session-mode state from a new/load session response. */
function extractModes(result: unknown): { modes: AgentModeInfo[]; modeId?: string } {
  const modesState = (result as { modes?: SessionModeState } | undefined)?.modes;
  const available = modesState?.availableModes ?? [];
  const modes: AgentModeInfo[] = available.map((m) => ({ id: m.id, name: m.name ?? m.id }));
  return { modes, modeId: modesState?.currentModeId };
}

export class AcpClient {
  private readonly connection: acp.ClientSideConnection;
  private _authMethods: AcpAuthenticateMethod[] = [];
  private _canLoadSession = false;
  private _closed = false;

  private constructor(
    private readonly child: ChildProcess,
    handlers: KernelHandlers,
  ) {
    const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    const client: acp.Client = {
      sessionUpdate: (params) => {
        const update = normalizeSessionUpdate(params.update as unknown as Record<string, unknown>);
        handlers.onSessionUpdate(params.sessionId, update);
      },
      requestPermission: async (params) => {
        const outcome = await handlers.onPermissionRequest({
          sessionId: params.sessionId,
          toolCall: { toolCallId: params.toolCall.toolCallId, title: params.toolCall.title ?? undefined },
          options: params.options.map((o) => ({
            optionId: o.optionId,
            name: o.name,
            kind: o.kind,
          })),
        });
        if (outcome.outcome === 'cancelled' || !outcome.optionId) {
          return { outcome: { outcome: 'cancelled' } };
        }
        return { outcome: { outcome: 'selected', optionId: outcome.optionId } };
      },
      readTextFile: async (params) => {
        return handlers.onReadTextFile({
          sessionId: params.sessionId,
          path: params.path,
          line: params.line ?? undefined,
          limit: params.limit ?? undefined,
        });
      },
      writeTextFile: async (params) => {
        await handlers.onWriteTextFile({
          sessionId: params.sessionId,
          path: params.path,
          content: params.content,
        });
        return {};
      },
    };

    this.connection = new acp.ClientSideConnection(() => client, stream);
    void this.connection;
  }

  /** Performs the initialize handshake; call before any session method. */
  static async connect(child: ChildProcess, handlers: KernelHandlers): Promise<AcpClient> {
    if (!child.stdin || !child.stdout) {
      throw new Error('Kernel process must have piped stdin/stdout');
    }
    const client = new AcpClient(child, handlers);
    const init = await client.connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
    });
    client._authMethods = (init.authMethods ?? []).map((m) => ({
      id: m.id,
      name: m.name ?? undefined,
      description: m.description ?? undefined,
    }));
    // Resume capability moved between schema revisions: honor both shapes.
    const caps = init.agentCapabilities as
      | { loadSession?: boolean; sessionCapabilities?: { resume?: unknown } }
      | undefined;
    client._canLoadSession = Boolean(caps?.loadSession) || Boolean(caps?.sessionCapabilities?.resume);

    child.on('exit', (code) => {
      client._closed = true;
      handlers.onExit(code);
    });
    return client;
  }

  get authMethods(): AcpAuthenticateMethod[] {
    return this._authMethods;
  }

  get canLoadSession(): boolean {
    return this._canLoadSession;
  }

  get closed(): boolean {
    return this._closed;
  }

  async newSession(cwd: string): Promise<SessionHandle> {
    const result = await this.connection.newSession({ cwd, mcpServers: [] });
    const modes = extractModes(result);
    return { sessionId: result.sessionId, ...modes };
  }

  async loadSession(cwd: string, sessionId: string): Promise<SessionHandle> {
    if (!this._canLoadSession) {
      throw new Error('The connected kernel does not support session resumption');
    }
    const connection = this.connection as unknown as {
      loadSession?: (params: { cwd: string; sessionId: string; mcpServers: unknown[] }) => Promise<unknown>;
    };
    if (typeof connection.loadSession !== 'function') {
      throw new Error('Kernel ACP build lacks a loadSession method');
    }
    const result = (await connection.loadSession({ cwd, sessionId, mcpServers: [] })) as {
      sessionId?: string;
    };
    const modes = extractModes(result);
    return { sessionId: result.sessionId ?? sessionId, ...modes };
  }

  async prompt(sessionId: string, blocks: PromptContentBlock[]): Promise<StopReason> {
    const promptBlocks: acp.ContentBlock[] = blocks.map((b): acp.ContentBlock => {
      if (b.type === 'text') {
        return { type: 'text', text: b.text ?? '' } as acp.ContentBlock;
      }
      const name = b.name ?? b.uri?.split(/[\\/]/).pop() ?? 'context';
      return { type: 'resource_link', uri: b.uri ?? '', name } as acp.ContentBlock;
    });
    const result = await this.connection.prompt({ sessionId, prompt: promptBlocks });
    switch (result.stopReason) {
      case 'end_turn':
      case 'cancelled':
      case 'refusal':
      case 'max_tokens':
        return result.stopReason;
      default:
        return 'other';
    }
  }

  cancel(sessionId: string): void {
    const connection = this.connection as unknown as {
      cancel?: (params: { sessionId: string }) => void | Promise<void>;
    };
    if (typeof connection.cancel === 'function') {
      void Promise.resolve(connection.cancel({ sessionId })).catch(() => undefined);
    }
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    const connection = this.connection as unknown as {
      setSessionMode?: (params: { sessionId: string; modeId: string }) => Promise<unknown>;
    };
    if (typeof connection.setSessionMode !== 'function') {
      throw new Error('The connected kernel does not support session modes');
    }
    await connection.setSessionMode({ sessionId, modeId });
  }

  async authenticate(methodId: string): Promise<void> {
    await this.connection.authenticate({ methodId });
  }

  async dispose(): Promise<void> {
    this._closed = true;
    try {
      this.child.stdin?.end();
    } catch {
      // Already gone.
    }
  }
}
