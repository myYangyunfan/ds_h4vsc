# Testing

## Layers

| Layer | Tool | Scope |
| --- | --- | --- |
| Unit | vitest (`packages/core/src/timeline.test.ts`) | TimelineReducer: chunk streaming, tool-call lifecycle, diff effects, plan upserts, approvals, reset. Deterministic ids. |
| Integration | vitest (`packages/extension/test/acpclient.integration.test.ts`) | `AcpClient` against `test/mock-agent.mjs` - a real child process speaking ACP NDJSON over stdio: handshake, session/new, interleaved streaming, diff mapping, permission round trip. |
| Manual matrix | Human | Windows (PowerShell kernel path) / macOS / Linux; light/dark/high-contrast themes; kernel upgrade smoke. |

## Running

```bash
pnpm test
```

## Real-kernel pre-flight

With `dsh` (0.1.2+) installed and the ACP profile present, verify the handshake:

```bash
pnpm --filter deepseek-harness-plus run verify:kernel          # dsh --profile acp
node packages/extension/scripts/verify-kernel.mjs node <path-to-bin.js> --profile acp
```

Expected output ends with `SUCCESS - the kernel speaks ACP`, printing `sessionCapabilities` (close/list/resume) and a real session id.

## Webview UI

The panel runs standalone (`pnpm --filter @dsh-vscode/webview-ui run dev`) with a mock messaging API and a dark fallback theme (loaded only outside VS Code). Browser-verified behaviors: header, empty state, composer enable/disable, slash command menu with filtering, codicon icons.

## E2E smoke (pre-release checklist)

1. `pnpm package` then install the VSIX into a clean VS Code profile
2. Without dsh installed: panel shows guidance; **Install Kernel** completes
3. `/login` flow; API key via SecretStorage
4. Simple Q&A with streaming; stop button cancels
5. Multi-file task: diffs open natively; accept/reject/keep-all; revert works for applied edits
6. Command execution triggers approval card + notification; deny blocks the command
7. Kill the kernel process (Task Manager): panel surfaces the crash; next prompt reconnects

The ACP surface of dsh is verified in CI by the integration test against the mock agent; when the real kernel changes behavior, the `dsh.acpArgs` setting and the `AcpClient` adapter are the two intended adjustment points.
