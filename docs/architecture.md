# Architecture

## Positioning

The extension is the **shell**; the official open-source DeepSeek Harness (`@deepseek-ai/dsh`) is the **kernel**. This mirrors Kimi Code for VS Code, which runs the Kimi SDK in the Extension Host and shares its home directory with the CLI. The kernel owns the agent loop, tools (file/bash/pwsh/web/todo/skill/subagent), MCP, compaction and plan mode. The extension owns the UI, editor integration, approvals and diff review.

## Process topology

```
VS Code Extension Host
└── packages/extension
    ├── WebviewView "dsh.chat"  ◄── ToWebview / FromWebview ──►  packages/webview-ui (React)
    ├── ChatSessionService          (state machine + timeline reducer)
    ├── AcpBackend ── ACP/NDJSON over stdio ──►  dsh kernel child process
    │                                              └─► DeepSeek API / providers
    ├── DiffService (native diff + workspace writes)
    ├── ApprovalBridge (request_permission UX)
    └── StatusItem / ContextService / SessionStore
```

## Key decisions

1. **ACP child process instead of in-process SDK.** dsh is a developer preview with declared breaking changes. A process boundary + the standard ACP protocol (same one Zed uses) isolates the extension from kernel churn and enables version pinning. Transport abstraction lives in `AcpClient`; swapping to a headless-mode adapter touches one file.

2. **Kernel discovery order** (`DshLocator`): `dsh.executablePath` setting → managed install in `globalStorage/dsh` (installed via `npm --prefix`, executed with `ELECTRON_RUN_AS_NODE=1`) → `dsh` on PATH (shell spawn on Windows for `.cmd` shims).

3. **The ACP server is a version-paired profile plugin** (verified against kernel 0.1.2-rc.1). The default CLI ships no `acp` command; instead the extension boots `dsh --profile acp` and ensures the profile exists via `dsh plugin --profile acp add @deepseek-ai/dsh-acp-app@<kernel version>`. The plugin's import surface must match the kernel version exactly (mixing 0.1.0 kernels with 0.1.2 plugins fails with missing exports), so `ensureAcpProfile` pins the plugin to the probed kernel version. If the first handshake times out (profile missing → ACP app never mounts), `AcpBackend` bootstraps the profile and retries once. Requires the 0.1.2+ kernel line. A standalone pre-flight check exists: `pnpm --filter deepseek-harness run verify:kernel`.

3. **Single source of truth for the chat state** is the `TimelineReducer` in `packages/core` - a pure, dependency-free reducer from ACP session updates to timeline entries plus effects (e.g. `editProposed`). The webview receives coalesced snapshots; streaming text additionally travels as chunk deltas for smoothness. The reducer is fully unit tested.

4. **Two edit origins, one working set.**
   - `toolDiff`: kernel tool calls report a diff. The kernel usually applied it already; *Reject* reverts using the recorded `oldText`.
   - `fsWrite`: the kernel asked the client to write via ACP `fs/write_text_file`. We apply on approval and register the edit as applied, so *Reject* = revert. This matches Copilot agent-mode "approve = apply" semantics.

5. **Theming**: zero hardcoded chrome colors. Everything uses `--vscode-*` custom properties; only curated syntax-token palettes are theme-kind scoped (`vscode-light` / `vscode-dark` / `vscode-high-contrast` body classes).

6. **Secrets**: API keys only in VS Code SecretStorage (`dsh.apiKey`), passed to the kernel via environment, never persisted to settings.

## Message protocol (packages/core/protocol.ts)

- `ToWebview`: `init` (static payload) · `snapshot` (authoritative full state) · `chunk` (streaming deltas) · `addContext` · `error`
- `FromWebview`: `ready` · `submitPrompt` · `cancel` · `approve` · `openDiff` · `acceptEdit` / `rejectEdit` / `acceptAllEdits` · `newChat` · `loadSession` · `openFilePicker` · `authenticate` · `setMode` · `insertCode` · `showPlan`

Unknown kinds are ignored defensively (`isFromWebview` / reducer `unknown` arm) so host and webview can be deployed independently.
