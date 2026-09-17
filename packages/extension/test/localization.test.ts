/**
 * Guards the localization surface. VS Code resolves `%key%` placeholders in the
 * manifest and `l10n.t()` calls at runtime, and both fail *silently*: an
 * unregistered key just renders the Chinese source string, so English users see
 * mixed languages and nothing ever errors. These checks run in CI instead.
 */
import { readFileSync } from 'node:fs';
import { globSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkgDir = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(pkgDir, rel), 'utf8');
const readJson = <T>(rel: string): T => JSON.parse(read(rel)) as T;

const manifest = readJson<{
  activationEvents: string[];
  contributes: {
    views: Record<string, Array<{ id: string }>>;
  };
}>('package.json');
const nlsZh = readJson<Record<string, string>>('package.nls.json');
const nlsEn = readJson<Record<string, string>>('package.nls.en.json');
const bundleZh = readJson<Record<string, string>>('l10n/bundle.l10n.zh-cn.json');
const bundleEn = readJson<Record<string, string>>('l10n/bundle.l10n.en.json');

function l10nCalls(): string[] {
  const keys: string[] = [];
  const files = globSync('src/**/*.{ts,tsx}', { cwd: pkgDir });
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(/l10n\.t\(\s*'([^']*)'/g)) {
      keys.push(match[1]!);
    }
  }
  return keys;
}

describe('manifest localization', () => {
  it('resolves every %placeholder% in both languages', () => {
    const used = [...read('package.json').matchAll(/%([A-Za-z0-9_.]+)%/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((key) => !(key in nlsZh))).toEqual([]);
    expect(used.filter((key) => !(key in nlsEn))).toEqual([]);
  });

  it('leaves no defined-but-unused manifest strings behind', () => {
    const used = new Set([...read('package.json').matchAll(/%([A-Za-z0-9_.]+)%/g)].map((m) => m[1]!));
    expect(Object.keys(nlsZh).filter((key) => !used.has(key))).toEqual([]);
  });

  it('keeps the two manifest bundles in step', () => {
    expect(Object.keys(nlsEn).sort()).toEqual(Object.keys(nlsZh).sort());
  });
});

describe('runtime localization bundle', () => {
  it('registers every string passed to l10n.t()', () => {
    const missing = [...new Set(l10nCalls())].filter((key) => !(key in bundleZh));
    expect(missing).toEqual([]);
  });

  it('keeps both languages in step and actually translated', () => {
    expect(Object.keys(bundleEn).sort()).toEqual(Object.keys(bundleZh).sort());
    const untranslated = Object.keys(bundleZh).filter((key) => bundleZh[key] === bundleEn[key]);
    expect(untranslated).toEqual([]);
  });
});

describe('contributed views', () => {
  it('activates on every contributed view', () => {
    const viewIds = Object.values(manifest.contributes.views)
      .flat()
      .map((view) => view.id);
    const declared = new Set(manifest.activationEvents);
    expect(viewIds.filter((id) => !declared.has(`onView:${id}`))).toEqual([]);
  });
});

describe('bundle filenames', () => {
  it('uses the names VS Code actually loads', () => {
    // VS Code resolves extension strings from exactly
    // `<l10n>/bundle.l10n.<currentLanguage>.json` - there is no fallback to
    // `bundle.l10n.json`. A file named any other way is never read, so the
    // strings silently stay in the source language and every lookup logs
    // "no string found in i18n bundle".
    const files = readdirSync(join(pkgDir, 'l10n'));
    expect(files.length).toBeGreaterThan(0);
    const unexpected = files.filter((name) => !/^bundle\.l10n\.[a-z]{2}(-[a-z0-9]+)?\.json$/.test(name));
    expect(unexpected).toEqual([]);
  });

  it('ships a bundle for every language the sources are written for', () => {
    const files = readdirSync(join(pkgDir, 'l10n'));
    // Chinese is the source language, so zh-cn is an identity mapping; en is the
    // translation. Both must exist for either UI to resolve its strings.
    expect(files).toContain('bundle.l10n.zh-cn.json');
    expect(files).toContain('bundle.l10n.en.json');
  });
});
