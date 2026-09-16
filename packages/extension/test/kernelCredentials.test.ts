/**
 * The kernel owns authentication: it resolves credentials from the inherited
 * environment, its managed `.credentials.yaml`, and `.env` fallbacks. These
 * tests pin the detection the panel uses so it stops claiming "no API key" when
 * a dsh CLI or the desktop app has already signed the kernel in.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasKernelCredential, resolveKernelHome } from '../src/config/kernelCredentials.js';

const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-home-'));
}

function writeCredentials(home: string, body: string): void {
  writeFileSync(join(home, '.credentials.yaml'), body, 'utf8');
}

const originalEnv = process.env[DEEPSEEK_KEY_ENV];

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[DEEPSEEK_KEY_ENV];
  } else {
    process.env[DEEPSEEK_KEY_ENV] = originalEnv;
  }
});

describe('resolveKernelHome', () => {
  it('prefers the configured path, then $DSH_HOME, then ~/.dsh', () => {
    expect(resolveKernelHome('/custom/home')).toBe('/custom/home');
    expect(resolveKernelHome('   ')).toMatch(/[\\/]\.dsh$/);
    expect(resolveKernelHome()).toMatch(/[\\/]\.dsh$/);
  });
});

describe('hasKernelCredential', () => {
  it('is false for an empty home with nothing in the environment', async () => {
    delete process.env[DEEPSEEK_KEY_ENV];
    expect(await hasKernelCredential(tempHome())).toBe(false);
  });

  it('is true when the inherited environment carries a key', async () => {
    process.env[DEEPSEEK_KEY_ENV] = 'sk-from-environment';
    expect(await hasKernelCredential(tempHome())).toBe(true);
  });

  it('reads the managed credentials document the CLI and desktop app write', async () => {
    delete process.env[DEEPSEEK_KEY_ENV];
    const home = tempHome();
    writeCredentials(
      home,
      ['version: 1', 'refs:', '  DEEPSEEK_API_KEY: sk-managed-store', 'records: {}'].join('\n'),
    );
    expect(await hasKernelCredential(home)).toBe(true);
  });

  it('does not count an entry with no value, matching the kernel', async () => {
    delete process.env[DEEPSEEK_KEY_ENV];
    const home = tempHome();
    writeCredentials(home, ['version: 1', 'refs:', '  DEEPSEEK_API_KEY:', 'records: {}'].join('\n'));
    expect(await hasKernelCredential(home)).toBe(false);
  });

  it('ignores an unrelated provider entry', async () => {
    delete process.env[DEEPSEEK_KEY_ENV];
    const home = tempHome();
    writeCredentials(home, ['version: 1', 'refs:', '  QWEN_TOKEN_PLAN_CN_API_KEY: qwen-key'].join('\n'));
    expect(await hasKernelCredential(home)).toBe(false);
  });

  it('falls back to the workspace .env, then the home .env', async () => {
    delete process.env[DEEPSEEK_KEY_ENV];
    const home = tempHome();
    const workspace = tempHome();
    writeFileSync(join(workspace, '.env'), `${DEEPSEEK_KEY_ENV}=sk-from-workspace\n`, 'utf8');
    expect(await hasKernelCredential(home, workspace)).toBe(true);

    const otherWorkspace = tempHome();
    writeFileSync(join(home, '.env'), `export ${DEEPSEEK_KEY_ENV}=sk-from-home\n`, 'utf8');
    expect(await hasKernelCredential(home, otherWorkspace)).toBe(true);
  });
});
