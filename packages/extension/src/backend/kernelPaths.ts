/**
 * Where a globally installed `dsh` kernel - or the `npm` that installs one - can
 * hide from the extension host.
 *
 * macOS is the reason this module exists. An app launched from the Dock inherits
 * launchd's minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one your
 * shell assembles from `~/.zprofile` / `~/.zshrc`. A kernel installed by
 * Homebrew, by npm's global prefix, or by nvm/fnm/Volta/Bun is therefore
 * invisible to a bare `execFile('dsh')`, and the panel reports "kernel not
 * found" on a machine where `dsh --version` works perfectly in a terminal. The
 * same applies to `npm`, which is why "Install kernel" can appear to do nothing.
 *
 * Everything here is pure so the search order can be unit tested; the file
 * system and process work lives in `DshLocator`.
 */

export interface PathSources {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** Marker the login shell prints, so rc-file noise cannot be mistaken for a PATH. */
export const SHELL_PATH_MARKER = '__DSH_PATH__';

/**
 * Places a global `dsh`/`npm` binary is normally written to, most likely first.
 * Deliberately absolute: the whole point is to not depend on the inherited PATH.
 */
export function candidateBinDirs({ home, platform, env }: PathSources): string[] {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    const localAppData = env.LOCALAPPDATA;
    const programFiles = env.ProgramFiles;
    return [
      // npm's global shims live here; it is normally on PATH already, but a
      // non-default prefix (or a stripped PATH) makes this worth checking.
      ...(appData ? [joinWin(appData, 'npm')] : []),
      ...(localAppData ? [joinWin(localAppData, 'pnpm')] : []),
      ...(programFiles ? [joinWin(programFiles, 'nodejs')] : []),
    ];
  }

  return [
    // A kernel that manages its own launcher keeps it beside its home dir.
    `${home}/.dsh/bin`,
    // Homebrew: Apple Silicon first, then the Intel prefix.
    '/opt/homebrew/bin',
    '/usr/local/bin',
    // MacPorts.
    '/opt/local/bin',
    // Per-user installs that are frequently absent from a GUI PATH.
    `${home}/.local/bin`,
    `${home}/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.yarn/bin`,
    `${home}/.bun/bin`,
    `${home}/.volta/bin`,
    `${home}/.asdf/shims`,
    // pnpm's global bin dir differs per platform.
    `${home}/Library/pnpm`,
    `${home}/.local/share/pnpm`,
    // Node version managers keep a private bin directory per version; these are
    // single glob patterns rather than directories, so they are expanded by the
    // caller that has file-system access.
    ...nodeVersionManagerGlobs(home),
  ];
}

/**
 * Node-version-manager layouts, as single-level globs. `nvm` and `fnm` install
 * one directory per Node version, so the binary lives at a versioned path that
 * cannot be written down in advance.
 */
export function nodeVersionManagerGlobs(home: string): string[] {
  return [
    `${home}/.nvm/versions/node/*/bin`,
    `${home}/Library/Application Support/fnm/node-versions/*/installation/bin`,
    `${home}/.local/share/fnm/node-versions/*/installation/bin`,
    `${home}/.nodenv/versions/*/bin`,
  ];
}

/** Binary file names to try inside a directory, in order. */
export function binaryFileNames(base: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [`${base}.cmd`, `${base}.exe`, base] : [base];
}

/**
 * Directory list from a login shell's `$PATH` output.
 *
 * A `-i` shell runs the user's rc files, which may print banners ("nvm is not
 * compatible with...") or take a while; only the marker line counts, and only
 * its last occurrence, so earlier noise is ignored rather than parsed.
 */
export function parseShellPathOutput(stdout: string, delimiter = ':'): string[] {
  const marked = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(SHELL_PATH_MARKER))
    .pop();
  if (marked === undefined) {
    return [];
  }
  const value = marked.slice(SHELL_PATH_MARKER.length).trim();
  if (!value) {
    return [];
  }
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const dir of value.split(delimiter)) {
    const trimmed = dir.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      dirs.push(trimmed);
    }
  }
  return dirs;
}

/** Deduplicates directory lists while preserving order. */
export function dedupeDirs(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const dir of list) {
      if (!seen.has(dir)) {
        seen.add(dir);
        out.push(dir);
      }
    }
  }
  return out;
}

function joinWin(dir: string, child: string): string {
  return `${dir.replace(/[\\/]+$/, '')}\\${child}`;
}
