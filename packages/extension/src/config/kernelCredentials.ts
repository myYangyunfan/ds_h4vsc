/**
 * Where the kernel keeps its state, and whether it can already authenticate.
 *
 * The extension deliberately does not own authentication: the kernel resolves
 * credentials itself, and its documented precedence is
 *
 *   inherited environment      (wins, read-only)
 *   > $DSH_HOME/.credentials.yaml   (managed store, written by the CLI / desktop app)
 *   > <workspace>/.env              (read-only fallback)
 *   > $DSH_HOME/.env                (read-only fallback)
 *
 * So a `dsh` CLI or the desktop app signs the kernel in through that managed
 * store. The panel must not claim "no API key" merely because VS Code's
 * SecretStorage happens to be empty - that is exactly the shared-credential
 * case this mirrors.
 */
import { homedir } from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** The kernel's directory name under the user's home. */
const DSH_HOME_DIR_NAME = '.dsh';
/** Credential the kernel expects for DeepSeek, and the env var it reads for it. */
export const DEEPSEEK_KEY_ENV = 'DEEPSEEK_API_KEY';
const CREDENTIALS_FILENAME = '.credentials.yaml';
const DOTENV_FILENAME = '.env';

/**
 * Mirrors the kernel's own precedence: an explicitly configured path, then
 * `$DSH_HOME`, then `~/.dsh`. A blank override counts as unset.
 */
export function resolveKernelHome(configured?: string): string {
  const explicit = configured?.trim();
  if (explicit) {
    return explicit;
  }
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return path.join(homedir(), DSH_HOME_DIR_NAME);
}

/**
 * True when the kernel can authenticate without the extension supplying a key,
 * checked in the kernel's own precedence order. Only the presence of a
 * non-empty value matters; no credential is ever read into memory here.
 */
export async function hasKernelCredential(
  home: string,
  workspaceRoot?: string,
): Promise<boolean> {
  if (process.env[DEEPSEEK_KEY_ENV]?.trim()) {
    return true;
  }
  // Managed store: a strict `refs:`-to-string mapping.
  if (await fileHasDeepSeekKey(path.join(home, CREDENTIALS_FILENAME))) {
    return true;
  }
  if (workspaceRoot && (await fileHasDeepSeekKey(path.join(workspaceRoot, DOTENV_FILENAME)))) {
    return true;
  }
  return fileHasDeepSeekKey(path.join(home, DOTENV_FILENAME));
}

async function fileHasDeepSeekKey(file: string): Promise<boolean> {
  let document: string;
  try {
    document = await fs.readFile(file, 'utf8');
  } catch {
    return false;
  }
  // Matches `DEEPSEEK_API_KEY: <value>` inside the credentials document as well
  // as `DEEPSEEK_API_KEY=<value>` in a dotenv file. Horizontal whitespace only:
  // a `\s*` here would let an entry with no value borrow the next line's text and
  // read as "signed in". The kernel rejects empty values too.
  const pattern = new RegExp(
    `^[ \\t]*(?:export[ \\t]+)?${DEEPSEEK_KEY_ENV}[ \\t]*[:=][ \\t]*\\S+`,
    'm',
  );
  return pattern.test(document);
}
