/**
 * The account balance. ACP has no billing, so unlike everything else the panel
 * shows this is fetched client-side, with the key taken from the same places the
 * kernel itself looks.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBalance, readStoredApiKey } from '../src/config/balance.js';

const KEY_ENV = 'DEEPSEEK_API_KEY';
const originalEnv = process.env[KEY_ENV];

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env[KEY_ENV];
  } else {
    process.env[KEY_ENV] = originalEnv;
  }
});

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-balance-'));
}

describe('parseBalance', () => {
  it('reads the first balance entry', () => {
    expect(
      parseBalance({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '848.97', granted_balance: '0.00', topped_up_balance: '848.97' },
        ],
      }),
    ).toEqual({
      currency: 'CNY',
      totalBalance: '848.97',
      grantedBalance: '0.00',
      toppedUpBalance: '848.97',
    });
  });

  it('reports nothing rather than a wrong number', () => {
    expect(parseBalance(null)).toBeUndefined();
    expect(parseBalance({ balance_infos: [] })).toBeUndefined();
    // A renamed or reshaped response must not render as "0".
    expect(parseBalance({ balance_infos: [{ currency: 'CNY' }] })).toBeUndefined();
    expect(parseBalance({ balance_infos: [{ total_balance: '1.00' }] })).toBeUndefined();
  });
});

describe('readStoredApiKey', () => {
  it('prefers the inherited environment, as the kernel does', async () => {
    process.env[KEY_ENV] = 'sk-from-env';
    const home = tempHome();
    writeFileSync(join(home, '.credentials.yaml'), 'refs:\n  DEEPSEEK_API_KEY: sk-from-file\n', 'utf8');
    expect(await readStoredApiKey(home)).toBe('sk-from-env');
  });

  it('reads the managed credentials document', async () => {
    delete process.env[KEY_ENV];
    const home = tempHome();
    writeFileSync(
      join(home, '.credentials.yaml'),
      ['version: 1', 'refs:', '  QWEN_TOKEN_PLAN_CN_API_KEY: other', '  DEEPSEEK_API_KEY: sk-managed', 'records: {}'].join('\n'),
      'utf8',
    );
    expect(await readStoredApiKey(home)).toBe('sk-managed');
  });

  it('falls back to a dotenv file and tolerates export', async () => {
    delete process.env[KEY_ENV];
    const home = tempHome();
    writeFileSync(join(home, '.env'), `# comment\nexport ${KEY_ENV}=sk-dotenv\n`, 'utf8');
    expect(await readStoredApiKey(home)).toBe('sk-dotenv');
  });

  it('does not treat an empty value as a key', async () => {
    delete process.env[KEY_ENV];
    const home = tempHome();
    writeFileSync(join(home, '.credentials.yaml'), 'refs:\n  DEEPSEEK_API_KEY:\n', 'utf8');
    expect(await readStoredApiKey(home)).toBeUndefined();
  });

  it('returns nothing when there is no store at all', async () => {
    delete process.env[KEY_ENV];
    expect(await readStoredApiKey(tempHome())).toBeUndefined();
  });
});
