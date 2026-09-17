# Release Handbook (marketplace publishing)

## One-time setup

1. Create a publisher at https://marketplace.visualstudio.com/manage (e.g. `dsh-tools`)
2. Replace `publisher` in `packages/extension/package.json` with your publisher ID
3. Update `repository.url` / `bugs.url` to your GitHub repo (required for marketplace trust)
4. Generate a Personal Access Token (Azure DevOps → User settings → Personal access tokens, scope **Marketplace → Manage**) and add it as the `VSCE_PAT` repository secret

## Pre-flight checklist

- [ ] `pnpm typecheck && pnpm lint && pnpm test` green
- [ ] `pnpm package` produces `packages/extension/dist/deepseek-harness.vsix` (< 20 MB)
- [ ] `media/icon.png` (128x128+) present; Activity Bar SVG renders in both themes
- [ ] `packages/extension/README.md` has screenshots/GIF
- [ ] `CHANGELOG.md` updated; version bumped (semver)
- [ ] No startup-time network calls; activation only via `onView:dsh.chat` / `onView:dsh.sessions`
- [ ] Secrets only via SecretStorage (verified: no `apiKey` in settings schema)
- [ ] License file + license field present — `packages/extension/LICENSE` is a **copy** of the root `LICENSE`, because `vsce` only looks inside the extension directory (packaging an extension without one prints `WARNING LICENSE, LICENSE.md, or LICENSE.txt not found`). Change the root file → re-copy it here, they cannot drift apart silently

## Publish

The publisher ID and extension name are **permanent** once the first version is live: `dsh-tools.deepseek-harness` can never be renamed (only the display name can change). Verify `publisher` in `packages/extension/package.json` matches a publisher that actually exists at https://marketplace.visualstudio.com/manage before the first publish — publishing against a non-existent publisher fails with `Publisher 'dsh-tools' not found`.

```bash
# local, token in the environment
cd packages/extension
VSCE_PAT=<token> npx vsce publish --no-dependencies

# local, token stored once (never passes through a shell argument)
npx vsce login dsh-tools   # paste the PAT when prompted -> ~/.vsce
cd packages/extension && npx vsce publish --no-dependencies

# or push a tag; GitHub Actions release.yml publishes with VSCE_PAT
# (requires a git remote and the VSCE_PAT repository secret)
git tag v1.0.0 && git push origin v1.0.0
```

A published version is immutable — bump `version` before re-uploading; `--skip-duplicate` makes a re-run a no-op instead of an error.

## Post-publish

- Verify the marketplace listing renders (icons, README tables)
- Smoke-test the installed VSIX on a clean profile (see docs/testing.md)
- Monitor issues; keep `dsh.preferredVersion` guidance current with kernel releases
