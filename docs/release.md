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
- [ ] No startup-time network calls; activation only via `onView:dsh.chat`
- [ ] Secrets only via SecretStorage (verified: no `apiKey` in settings schema)
- [ ] License file + license field present

## Publish

```bash
# local
cd packages/extension
npx vsce publish --no-dependencies

# or push a tag; GitHub Actions release.yml publishes with VSCE_PAT
git tag v0.1.1 && git push origin v0.1.1
```

## Post-publish

- Verify the marketplace listing renders (icons, README tables)
- Smoke-test the installed VSIX on a clean profile (see docs/testing.md)
- Monitor issues; keep `dsh.preferredVersion` guidance current with kernel releases
