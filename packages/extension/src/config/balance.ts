/**
 * The DeepSeek account balance.
 *
 * The kernel does not expose billing over ACP (its bridge has no balance
 * support at all), so this is the one thing the panel has to fetch for itself.
 * The key comes from VS Code SecretStorage when the user stored one, otherwise
 * from the kernel's own credential store - the same shared credential the
 * kernel authenticates with, which is why a `dsh` CLI or desktop install does
 * not have to be repeated here.
 *
 * The key is never logged, echoed into a snapshot, or written anywhere.
 */
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AccountBalance } from '@dsh-vscode/core';

const BALANCE_ENDPOINT = 'https://api.deepseek.com/user/balance';
const TIMEOUT_MS = 10_000;
const CREDENTIALS_FILENAME = '.credentials.yaml';
const DOTENV_FILENAME = '.env';
const KEY_NAME = 'DEEPSEEK_API_KEY';

/** The provider's response, re-exported under the wire-contract name. */
export type BalanceInfo = AccountBalance;

/**
 * Reads the DeepSeek API key the kernel would use, from its credential store.
 *
 * Both files are plain `NAME: value` / `NAME=value` text; only the one key is
 * extracted and the rest of the file is never parsed or retained.
 */
export async function readStoredApiKey(home: string): Promise<string | undefined> {
  const fromEnv = process.env[KEY_NAME]?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  for (const file of [path.join(home, CREDENTIALS_FILENAME), path.join(home, DOTENV_FILENAME)]) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const match = text.match(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${KEY_NAME}[ \\t]*[:=][ \\t]*(\\S+)`, 'm'));
    if (match?.[1]) {
      return match[1];
    }
  }
  return undefined;
}

/** Fetches the balance, or undefined when it cannot be determined. */
export async function fetchBalance(apiKey: string): Promise<BalanceInfo | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(BALANCE_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    return parseBalance(await response.json());
  } catch {
    // Offline, blocked, or the endpoint moved: the panel simply shows no
    // balance rather than an error the user cannot act on.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Narrows the API response, tolerating a shape the docs do not pin down. */
export function parseBalance(raw: unknown): BalanceInfo | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const infos = (raw as { balance_infos?: unknown }).balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    return undefined;
  }
  const first = infos[0] as Record<string, unknown>;
  const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
  const currency = asText(first['currency']);
  const totalBalance = asText(first['total_balance']);
  if (!currency || !totalBalance) {
    return undefined;
  }
  return {
    currency,
    totalBalance,
    grantedBalance: asText(first['granted_balance']),
    toppedUpBalance: asText(first['topped_up_balance']),
  };
}
