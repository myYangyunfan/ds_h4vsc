/**
 * Verifies a real DeepSeek Harness kernel over ACP:
 *   node scripts/verify-kernel.mjs [dsh command] [args...]
 *
 * Defaults to `dsh --profile acp`. Performs initialize + session/new and
 * prints the negotiated capabilities. Useful as a pre-flight diagnostic
 * before filing kernel integration issues.
 */
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const command = process.argv[2] ?? 'dsh';
const args = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['--profile', 'acp'];

console.log(`[verify-kernel] spawning: ${command} ${args.join(' ')}`);
const child = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
  windowsHide: true,
});

child.on('exit', (code) => {
  console.log(`[verify-kernel] kernel exited with code ${code}`);
});

const input = Readable.toWeb(child.stdout);
const output = Writable.toWeb(child.stdin);
const stream = acp.ndJsonStream(output, input);

const updates = [];
const client /*: acp.Client */ = {
  sessionUpdate: (params) => updates.push(params.update),
  requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  readTextFile: async () => ({ content: '' }),
  writeTextFile: async () => ({}),
};

const connection = new acp.ClientSideConnection(() => client, stream);
try {
  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  console.log('[verify-kernel] initialize OK');
  console.log('  protocolVersion:', init.protocolVersion);
  console.log('  agentCapabilities:', JSON.stringify(init.agentCapabilities));
  console.log('  authMethods:', JSON.stringify(init.authMethods));

  const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
  console.log('[verify-kernel] newSession OK:', session.sessionId);
  if (session.modes) {
    console.log('  modes:', JSON.stringify(session.modes));
  }
  console.log('[verify-kernel] SUCCESS - the kernel speaks ACP');
} catch (err) {
  console.error('[verify-kernel] FAILED:', err.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
