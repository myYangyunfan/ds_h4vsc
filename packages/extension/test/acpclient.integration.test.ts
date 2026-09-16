/**
 * Integration test: drives AcpClient against the mock ACP agent through a
 * real child process and NDJSON stdio stream. Verifies handshake, session
 * creation, streaming updates, diff mapping and the permission round trip.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpClient, type StopReason } from '../src/backend/AcpClient.js';
import type { AcpPermissionOutcome, AcpPermissionRequest, AcpSessionUpdate, KernelHandlers } from '@dsh-vscode/core';

const here = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT = join(here, 'mock-agent.mjs');

class MockKernel {
  readonly updates: AcpSessionUpdate[] = [];
  permissionRequest: AcpPermissionRequest | undefined;
  private permissionReply: ((outcome: AcpPermissionOutcome) => void) | undefined;
  private readonly client: Promise<AcpClient>;
  private readonly child;

  constructor() {
    this.child = spawn(process.execPath, [MOCK_AGENT], { stdio: ['pipe', 'pipe', 'pipe'] });
    const handlers: KernelHandlers = {
      onSessionUpdate: (_sessionId, update) => this.updates.push(update),
      onPermissionRequest: (req) =>
        new Promise((resolve) => {
          this.permissionRequest = req;
          this.permissionReply = resolve;
        }),
      onReadTextFile: async () => ({ content: '' }),
      onWriteTextFile: async () => undefined,
      onExit: () => undefined,
    };
    this.client = AcpClient.connect(this.child, handlers);
  }

  async ready(): Promise<AcpClient> {
    return this.client;
  }

  replyPermission(outcome: AcpPermissionOutcome): void {
    this.permissionReply?.(outcome);
  }
}

describe('AcpClient against a real ACP agent process', () => {
  let kernel: MockKernel;

  beforeAll(() => {
    kernel = new MockKernel();
  });

  afterAll(async () => {
    const client = await kernel.ready();
    await client.dispose();
  });

  it('completes the initialize handshake', async () => {
    const client = await kernel.ready();
    expect(client.authMethods).toEqual([{ id: 'mock-oauth', name: 'Mock sign-in', description: undefined }]);
    expect(client.canLoadSession).toBe(false);
  });

  it('creates a session', async () => {
    const client = await kernel.ready();
    const session = await client.newSession(process.cwd());
    expect(session.sessionId).toBe('mock-session');
    expect(session.modes).toEqual([]);
  });

  it('streams message chunks and maps diff tool calls', async () => {
    const client = await kernel.ready();
    const stop: StopReason = await client.prompt('mock-session', [{ type: 'text', text: 'hi' }]);
    // Let the interleaved notifications drain.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(stop).toBe('end_turn');

    const chunks = kernel.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk');
    const textJoined = chunks
      .map((u) => (u.content.type === 'text' ? u.content.text : ''))
      .join('');
    expect(textJoined).toBe('Hello world');

    const toolCalls = kernel.updates.filter((u) => u.sessionUpdate === 'tool_call');
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({
      toolCallId: 'tool-1',
      title: 'Edit mock.txt',
      kind: 'edit',
      status: 'completed',
    });
  });

  it('round-trips a permission request', async () => {
    const client = await kernel.ready();
    await client.prompt('mock-session', [{ type: 'text', text: 'again' }]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(kernel.permissionRequest).toBeDefined();
    expect(kernel.permissionRequest?.options.map((o) => o.optionId)).toEqual(['allow', 'deny']);

    kernel.replyPermission({ outcome: 'selected', optionId: 'allow' });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
