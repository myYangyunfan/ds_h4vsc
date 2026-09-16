/**
 * Probe how the real kernel manages session activation.
 * Answers: can two sessions be active at once? What does resume do to the
 * previously active one? Does close free the slot?
 */
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const child = spawn('dsh', ['--profile', 'acp'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
  windowsHide: true,
});

const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
const client = {
  sessionUpdate: () => undefined,
  requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  readTextFile: async () => ({ content: '' }),
  writeTextFile: async () => ({}),
};
const connection = new acp.ClientSideConnection(() => client, stream);
const cwd = process.cwd();

async function step(label, fn) {
  try {
    const result = await fn();
    const detail = result && result.sessionId ? ` id=${result.sessionId}` : '';
    console.log(`OK    ${label}${detail}`);
    return { ok: true, result };
  } catch (err) {
    console.log(`FAIL  ${label} -> ${err.message}`);
    return { ok: false };
  }
}

try {
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });

  const a = (await connection.newSession({ cwd, mcpServers: [] })).sessionId;
  console.log('newSession A:', a);
  const b = (await connection.newSession({ cwd, mcpServers: [] })).sessionId;
  console.log('newSession B:', b);
  console.log('--- 两个新会话是否都被接受（说明可多会话并存）---');

  await step('resume A', () => connection.resumeSession({ sessionId: a, cwd, mcpServers: [] }));
  await step('resume A again', () => connection.resumeSession({ sessionId: a, cwd, mcpServers: [] }));
  await step('resume B', () => connection.resumeSession({ sessionId: b, cwd, mcpServers: [] }));
  await step('resume A after B', () => connection.resumeSession({ sessionId: a, cwd, mcpServers: [] }));

  if (connection.closeSession) {
    await step('close A', () => connection.closeSession({ sessionId: a }));
    await step('resume A after close', () => connection.resumeSession({ sessionId: a, cwd, mcpServers: [] }));
  } else {
    console.log('closeSession not exposed by this SDK build');
  }

  if (connection.listSessions) {
    const listed = await step('listSessions', () => connection.listSessions({}));
    if (listed.ok) {
      const sessions = listed.result?.sessions ?? [];
      console.log(`      列出的会话 ${sessions.length} 个`);
    }
  }
} catch (err) {
  console.error('probe failed:', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
