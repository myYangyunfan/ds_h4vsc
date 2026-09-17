# AGENTS.md

## What this is

A pnpm monorepo for the **DeepSeek Harness** VS Code extension (`deepseek-harness`, publisher `dsh-tools`). The extension is a *shell*: the AI agent loop, tools, MCP, compaction and plan mode all live in the external kernel `@deepseek-ai/dsh`, which is **not vendored in this repo** — the extension spawns it as a child process and speaks ACP (NDJSON over stdio) to it. The extension owns only UI, editor integration, approvals and diff review.

## Layout

| Path | Role |
| --- | --- |
| `packages/core` | Published as `@dsh-vscode/core`. Pure TypeScript: wire protocol, domain models, the `TimelineReducer`. **Zero runtime dependencies and no `vscode` import** — that is what keeps it unit-testable. Sources are imported directly (`main` points at `src/index.ts`), there is no build step. |
| `packages/extension` | Extension host: `src/backend` (ACP client, kernel locator, process), `src/chat` (session service, event mapper, session store), `src/editor` (diff service, working set, context), `src/approval`, `src/ui/PanelController`, `src/config/Settings`. Bundled by esbuild to `dist/extension.js`. |
| `packages/webview-ui` | React chat panel, bundled by Vite into `packages/extension/dist/webview/assets/index.{js,css}` (fixed filenames — the extension HTML hardcodes them). |
| `docs/` | `architecture.md`, `testing.md`, `release.md` — read `architecture.md` before touching the ACP or diff layers. |
| `.kern-test/` | Gitignored scratch dir: a local kernel install plus a `dsh` shim and UI screenshots from manual verification. Not part of the build. |

Not a git repository in its current state. There is no `scripts/` content and no test runner beyond vitest.

## Commands

```bash
pnpm install
pnpm build        # webview-ui first, then extension (order matters)
pnpm typecheck    # tsc --noEmit across all packages
pnpm lint         # root eslint config covers all packages
pnpm test         # vitest -r; core reducer tests + extension ACP integration tests
pnpm watch        # extension esbuild watch only (does NOT watch webview-ui)
pnpm package      # build + vsce package -> packages/extension/dist/deepseek-harness.vsix
pnpm --filter deepseek-harness run verify:kernel   # real-kernel ACP handshake pre-flight
```

Focused runs: `pnpm --filter @dsh-vscode/core run test`, `pnpm --filter deepseek-harness run test`. `pnpm --filter @dsh-vscode/webview-ui run dev` runs the panel standalone against a mock messaging API with a dark fallback theme.

Debugging the extension itself: open the folder in VS Code and press F5 (`.vscode/launch.json` → "Run DeepSeek Harness extension").

## Conventions that will bite you

- **Relative import extensions differ per package.** `packages/core` uses `./foo.ts`; `packages/extension` and `packages/webview-ui` use `./foo.js`. `allowImportingTsExtensions` is on everywhere, so both compile — match the surrounding package.
- **Strict TS:** `noUncheckedIndexedAccess` (index access yields `T | undefined` — use `!` or narrow), `verbatimModuleSyntax` (use `import type` for type-only imports), `noUnusedLocals`/`noUnusedParameters` (prefix intentionally unused params with `_`).
- **ESLint is not advisory here:** `@typescript-eslint/no-explicit-any` is an error, `no-console` is an error except `console.warn`/`console.error`, plus `eqeqeq` and `prefer-const`. Prettier: 100 columns, single quotes, trailing commas, LF.
- **Ordering:** `pnpm build` must run webview first. A root `pnpm build` handles it; running the extension filter alone produces a VSIX with a stale panel.
- **Localization:** user-facing extension strings go through `vscode.l10n.t()` with **Chinese source text** as the key, registered in `l10n/bundle.l10n.zh-cn.json` (zh, identity mapping) and `l10n/bundle.l10n.en.json` (English). The filename is load-bearing: VS Code reads exactly `<l10n>/bundle.l10n.<language>.json` with no fallback to `bundle.l10n.json`, so a differently-named file is never read and the UI silently stays in the source language. Manifest strings live in `package.nls.json` / `package.nls.en.json`. Chinese is the default language — do not "fix" source strings to English.
- **Webview UI:** zero hardcoded chrome colors. Everything must come from `--vscode-*` custom properties; theme-specific palettes are scoped to `vscode-light` / `vscode-dark` / `vscode-high-contrast` body classes. The panel HTML sets a nonce-based CSP (`script-src 'nonce-...'`) and `localResourceRoots` limited to `dist/webview` — new assets must load through `asWebviewUri`.
- **Never `import()` from webview code.** A dynamic import makes Vite emit an `import.meta` reference; the panel HTML loads the bundle as a module so it parses, but the invariant is easy to break and a violation silently kills the whole panel. Dev-only styling belongs in `packages/webview-ui/index.html`, not in application code.
- **View placement is fixed by VS Code, not by us.** A container contributed to `activitybar` *always* renders in the primary (left) side bar, and an extension cannot relocate a container between side bars (no public command; `moveViewContainerToLocation` is internal). So the two containers host different things on purpose: the **chat panel** (`dsh.chat`) lives in `secondarySidebar` on the right, and the **sessions list** (`dsh.sessions`, a native `TreeView`) is the left icon. Selecting a session there reopens it in the right-hand panel - do not try to make the left icon open the right panel. `revealChat()` in `extension.ts` also shows the secondary side bar when the user has collapsed it.

## Architecture boundaries

- **`packages/core/src/protocol.ts` is the single contract** between host and panel (`ToWebview` / `FromWebview`). Adding a message kind means touching the union, the `isFromWebview` guard, and the `TimelineReducer` — otherwise it is silently dropped. Unknown kinds are ignored *by design* so host and webview can ship independently.
- **Session settings are config options, not modes.** The kernel implements no `session/set_mode`; it advertises `configOptions` (model, reasoning effort) on `session/new` and re-sends them via `config_option_update`, with `session/set_config_option` to change one. Values are opaque strings - a model value is JSON text like `["provider","name"]` and must be echoed back verbatim. Its `usage_update` carries context occupancy (`used`/`size`); both are live host state, so they bypass the reducer like modes and commands do.
- **The balance is the only thing fetched client-side.** ACP has no billing and the kernel's bridge has no balance support, so `config/balance.ts` calls `GET https://api.deepseek.com/user/balance` with the key from SecretStorage or the kernel's own credential store. The key is never logged, snapshotted or stored.
- **Conversation text lives only in workspaceState.** The kernel does not replay messages over `session/resume` (it returns mode/config state only), so `TimelineStore` is the sole home of a transcript: one entry per session under `dsh.timelines`, newest 20 kept, with the pre-0.8.9 single-slot `dsh.timeline` folded in on read. Never collapse it back to one slot - that silently destroyed the previous conversation on every switch.
- **All state transitions go through `TimelineReducer`** in core (pure, no dependencies, fully unit tested); it emits timeline entries plus effects. The webview receives coalesced `snapshot` messages plus `chunk` deltas for streaming. Never mutate panel state anywhere else, and extend the reducer's tests (`packages/core/src/timeline.test.ts`) with behavior changes.
- **The webview never imports from `packages/extension`.** It shares contracts only via `@dsh-vscode/core` (types + the pure reducer).
- **Two edit origins, one working set:** `toolDiff` (kernel already applied; *Reject* reverts from the recorded `oldText`) vs `fsWrite` (client applies on approval, so *Reject* = revert). Preserve the "approve = apply" semantics.
- **Inbound webview messages are untrusted.** `PanelController` validates with `isFromWebview` and keeps a runtime `HOST_COMMAND_WHITELIST` plus quick-action key checks — any new host command must be added to that whitelist.
- **Secrets:** the API key lives only in VS Code SecretStorage (`dsh.apiKey` in `src/config/Settings.ts`) and reaches the kernel via environment variables. It must never appear in the settings schema or on disk. Timeline/session persistence uses `workspaceState` (`SessionStore`), not global state.
- **ACP surface is the intended adjustment point.** `packages/core/src/acp.ts` intentionally re-declares a minimal subset of the ACP SDK schema so the reducer stays dependency-free; `AcpClient` maps SDK objects into it. When the real kernel changes, adjust `AcpClient` and the `dsh.acpArgs` setting rather than reaching for the SDK types everywhere.
- **Capabilities name methods, not features.** `sessionCapabilities.resume` means `session/resume` and nothing else: it does **not** imply `session/load`, which has no entry in `SessionCapabilities` at all (it survives only as the older top-level `loadSession` flag). Conflating the two asks the kernel for a method it never advertised. The mock agent mirrors the real kernel's advertisement so `test/acpclient.integration.test.ts` fails if this regresses.
- **A session stays active until it is closed.** `session/new` and `session/resume` both leave the session open, and resuming a session the kernel already holds is rejected with `Invalid params: session is already active`. `session/close` frees it and is *not* destructive - `session/resume` works again afterwards. `ChatSessionService` therefore tracks `activeSessionId` separately from `sessionId` (the latter is also restored from workspaceState after a window reload, when a fresh kernel has nothing active) and closes the session it is leaving. `scripts/probe-sessions.mjs` re-verifies this against a real kernel.

## Kernel and platform gotchas

- **The kernel sends no diffs.** Its ACP bridge contains no diff construction and hardcodes `kind: "other"` on tool calls, so nothing reacts to `content[].type === 'diff'` in practice. Reviewable edits are derived instead by `FileChangeTracker`: the `tool_call` event carries the wire tool name in `title` and the model's arguments in `rawInput`, so the target file is read when the call starts and again when it settles. Its tool vocabulary (`write`, `edit`, `str_replace_editor`) is deliberately ported from the kernel's own client so the two agree; keep them in step when the kernel adds a mutation tool.
- **Credentials are the kernel's business.** It resolves them itself, highest precedence first: inherited environment (`DEEPSEEK_API_KEY`) > `$DSH_HOME/.credentials.yaml` > `<workspace>/.env` > `$DSH_HOME/.env`. A `dsh` CLI or desktop install signs in through the managed store, so the panel must not claim "no API key" on the strength of an empty VS Code SecretStorage - `hasKernelCredential` mirrors that order. The extension only exports `DEEPSEEK_API_KEY` when the user actually stored one, because the environment layer *wins* and would otherwise shadow the shared key.
- **Two platform traps, both verified against upstream docs.** (1) `npm install --global --prefix <dir>` does not use one layout: npm documents the global location as `{prefix}/lib/node_modules` (macOS/Linux, e.g. Homebrew) but on Windows packages land in `{prefix}/node_modules`, so `managedBinPath()` checks both. (2) macOS reserves `⌘⌥D` for show/hide Dock, so the panel shortcut is `ctrl+alt+d` on every platform rather than a `mac` override - a macOS user can rebind it in their own keybindings.
- **The kernel home is `$DSH_HOME` or `~/.dsh`** (see `resolveKernelHome`); the `dsh.homeDir` setting is exported to the child as `DSH_HOME`.

- **The kernel ships no `acp` command.** The extension boots `dsh --profile acp` and creates the profile on demand with `dsh plugin --profile acp add @deepseek-ai/dsh-acp-app@<kernelVersion>`. The plugin's import surface must match the kernel version *exactly* — that is why `ensureAcpProfile` pins the plugin to the probed kernel version. If the first handshake times out, the profile is bootstrapped and retried once. Requires the 0.1.2+ kernel line.
- **Kernel discovery order** (`DshLocator`): `dsh.executablePath` setting → managed install in `globalStorage/dsh` (npm `--prefix`, run with `ELECTRON_RUN_AS_NODE=1` so no system Node is needed) → `dsh` on PATH.
- **Windows shims:** `.cmd`/`.bat`/`.ps1` cannot be spawned with `shell: false` (EINVAL since Node's CVE-2024-27980 fix) — route through `shell: true`. With `shell: true`, arguments containing spaces or shell metacharacters must be quoted by hand; several earlier bugs came from exactly this.
- **Plugin/kernel version mismatch fails with missing exports**, which surfaces as an opaque handshake timeout rather than a clear error.
- Verify a change against a real kernel with `pnpm --filter deepseek-harness run verify:kernel` (success output: `SUCCESS - the kernel speaks ACP`); the CI-shaped equivalent is the integration test against `packages/extension/test/mock-agent.mjs`, a real child process speaking ACP over stdio. Changing the mock agent is expected when the wire behavior changes.

## Before you ship

`packages/extension/deepseek-harness-0.1.0.vsix` is a stale, gitignored artifact from long ago (the extension is at 1.0.0). Do not treat its version as current, and do not ship it — build fresh with `pnpm package`.

- Pre-flight: `pnpm typecheck && pnpm lint && pnpm test`, then `pnpm package`.
- Manual matrix (see `docs/testing.md`): Windows/macOS/Linux, light/dark/high-contrast, kernel upgrade smoke, kill-the-kernel-process reconnect.
- Bump `version` in `packages/extension/package.json` and add a `CHANGELOG.md` entry (the changelog is prose in Chinese, grouped by theme, numbered items).
