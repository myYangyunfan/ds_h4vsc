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
- **Localization:** user-facing extension strings go through `vscode.l10n.t()` with **Chinese source text** as the key, registered in `l10n/bundle.l10n.json` (zh, identity mapping) and `l10n/bundle.en.l10n.json` (English). Manifest strings live in `package.nls.json` / `package.nls.en.json`. Chinese is the default language — do not "fix" source strings to English.
- **Webview UI:** zero hardcoded chrome colors. Everything must come from `--vscode-*` custom properties; theme-specific palettes are scoped to `vscode-light` / `vscode-dark` / `vscode-high-contrast` body classes. The panel HTML sets a nonce-based CSP (`script-src 'nonce-...'`) and `localResourceRoots` limited to `dist/webview` — new assets must load through `asWebviewUri`.
- **Never `import()` from webview code.** A dynamic import makes Vite emit an `import.meta` reference; the panel HTML loads the bundle as a module so it parses, but the invariant is easy to break and a violation silently kills the whole panel. Dev-only styling belongs in `packages/webview-ui/index.html`, not in application code.
- **View placement is fixed by VS Code, not by us.** The chat container lives in `secondarySidebar` (right). A container contributed to `activitybar` *always* renders in the primary (left) side bar — an extension cannot make a left icon open the right side bar, and there is no public command to relocate a container between side bars. Reach the panel with `dsh.chat.openPanel` (editor title button, `Ctrl+Alt+D`, command palette); `revealChat()` in `extension.ts` also shows the secondary side bar when the user has collapsed it.

## Architecture boundaries

- **`packages/core/src/protocol.ts` is the single contract** between host and panel (`ToWebview` / `FromWebview`). Adding a message kind means touching the union, the `isFromWebview` guard, and the `TimelineReducer` — otherwise it is silently dropped. Unknown kinds are ignored *by design* so host and webview can ship independently.
- **All state transitions go through `TimelineReducer`** in core (pure, no dependencies, fully unit tested); it emits timeline entries plus effects. The webview receives coalesced `snapshot` messages plus `chunk` deltas for streaming. Never mutate panel state anywhere else, and extend the reducer's tests (`packages/core/src/timeline.test.ts`) with behavior changes.
- **The webview never imports from `packages/extension`.** It shares contracts only via `@dsh-vscode/core` (types + the pure reducer).
- **Two edit origins, one working set:** `toolDiff` (kernel already applied; *Reject* reverts from the recorded `oldText`) vs `fsWrite` (client applies on approval, so *Reject* = revert). Preserve the "approve = apply" semantics.
- **Inbound webview messages are untrusted.** `PanelController` validates with `isFromWebview` and keeps a runtime `HOST_COMMAND_WHITELIST` plus quick-action key checks — any new host command must be added to that whitelist.
- **Secrets:** the API key lives only in VS Code SecretStorage (`dsh.apiKey` in `src/config/Settings.ts`) and reaches the kernel via environment variables. It must never appear in the settings schema or on disk. Timeline/session persistence uses `workspaceState` (`SessionStore`), not global state.
- **ACP surface is the intended adjustment point.** `packages/core/src/acp.ts` intentionally re-declares a minimal subset of the ACP SDK schema so the reducer stays dependency-free; `AcpClient` maps SDK objects into it. When the real kernel changes, adjust `AcpClient` and the `dsh.acpArgs` setting rather than reaching for the SDK types everywhere.

## Kernel and platform gotchas

- **The kernel ships no `acp` command.** The extension boots `dsh --profile acp` and creates the profile on demand with `dsh plugin --profile acp add @deepseek-ai/dsh-acp-app@<kernelVersion>`. The plugin's import surface must match the kernel version *exactly* — that is why `ensureAcpProfile` pins the plugin to the probed kernel version. If the first handshake times out, the profile is bootstrapped and retried once. Requires the 0.1.2+ kernel line.
- **Kernel discovery order** (`DshLocator`): `dsh.executablePath` setting → managed install in `globalStorage/dsh` (npm `--prefix`, run with `ELECTRON_RUN_AS_NODE=1` so no system Node is needed) → `dsh` on PATH.
- **Windows shims:** `.cmd`/`.bat`/`.ps1` cannot be spawned with `shell: false` (EINVAL since Node's CVE-2024-27980 fix) — route through `shell: true`. With `shell: true`, arguments containing spaces or shell metacharacters must be quoted by hand; several earlier bugs came from exactly this.
- **Plugin/kernel version mismatch fails with missing exports**, which surfaces as an opaque handshake timeout rather than a clear error.
- Verify a change against a real kernel with `pnpm --filter deepseek-harness run verify:kernel` (success output: `SUCCESS - the kernel speaks ACP`); the CI-shaped equivalent is the integration test against `packages/extension/test/mock-agent.mjs`, a real child process speaking ACP over stdio. Changing the mock agent is expected when the wire behavior changes.

## Before you ship

`packages/extension/deepseek-harness-0.1.0.vsix` is a stale, gitignored artifact from long ago (the extension is at 0.8.0). Do not treat its version as current, and do not ship it — build fresh with `pnpm package`.

- Pre-flight: `pnpm typecheck && pnpm lint && pnpm test`, then `pnpm package`.
- Manual matrix (see `docs/testing.md`): Windows/macOS/Linux, light/dark/high-contrast, kernel upgrade smoke, kill-the-kernel-process reconnect.
- Bump `version` in `packages/extension/package.json` and add a `CHANGELOG.md` entry (the changelog is prose in Chinese, grouped by theme, numbered items).
