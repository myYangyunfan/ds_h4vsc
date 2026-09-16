/**
 * A minimal ACP agent used to integration-test AcpClient over a real stdio
 * NDJSON stream. It answers initialize/session/new, streams a message chunk,
 * a tool call with a diff, a plan, issues a permission request, and finishes
 * the prompt.
 */
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

let nextId = 0;
const pendingPermission = new Map();

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  if (message.id === undefined) {
    return; // notification (e.g. session/cancel) - ignored by the mock
  }
  switch (message.method) {
    case 'initialize':
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          authMethods: [{ id: 'mock-oauth', name: 'Mock sign-in' }],
          agentCapabilities: { loadSession: false },
        },
      });
      break;
    case 'session/new':
      write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'mock-session' } });
      break;
    case 'session/prompt': {
      write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      // Stream updates right after resolving the prompt (order irrelevant for
      // the mock; the client must handle interleaved traffic).
      const sessionId = message.params.sessionId;
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
        },
      });
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'tool-1',
            title: 'Edit mock.txt',
            kind: 'edit',
            status: 'completed',
            content: [{ type: 'diff', path: 'mock.txt', oldText: 'a\n', newText: 'a\nb\n' }],
          },
        },
      });
      const permId = (nextId += 1);
      write({
        jsonrpc: '2.0',
        id: permId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'tool-1' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
      pendingPermission.set(permId, sessionId);
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'world' },
          },
        },
      });
      break;
    }
    default:
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not implemented' } });
  }
});

// When the client answers a permission request, close the session quietly.
process.stdout.on('error', () => process.exit(0));
process.on('exit', () => undefined);
