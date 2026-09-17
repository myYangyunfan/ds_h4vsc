/**
 * Locates a runnable DeepSeek Harness kernel, in order of preference:
 *  1. `dsh.executablePath` setting
 *  2. A managed install inside the extension's global storage
 *     (`<globalStorage>/dsh/node_modules/@deepseek-ai/dsh`), driven by
 *     `installManaged()`
 *  3. `dsh` on the inherited PATH, then - when that fails - in the places a
 *     global install actually lands (Homebrew, npm's prefix, nvm/fnm/Volta/Bun,
 *     and whatever the user's login shell puts on `PATH`). A GUI-launched
 *     editor on macOS does not inherit the terminal's PATH, so the second half
 *     of step 3 is what makes an installed kernel discoverable there; see
 *     `kernelPaths.ts`.
 *
 * JS entry points are executed with the running VS Code Electron binary in
 * node mode (ELECTRON_RUN_AS_NODE), which avoids requiring a system Node.
 */
import { l10n } from 'vscode';
import * as cp from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DshSettings } from '../config/Settings.js';
import { DEEPSEEK_KEY_ENV } from '../config/kernelCredentials.js';
import type { Logger } from '../util/log.js';
import {
  binaryFileNames,
  candidateBinDirs,
  dedupeDirs,
  parseShellPathOutput,
  SHELL_PATH_MARKER,
} from './kernelPaths.js';

export type DshSource = 'setting' | 'managed' | 'path';

export interface DshLaunchSpec {
  /** Executable to spawn (absolute path, `node`, or a PATH command). */
  command: string;
  /** Full argument vector, starting with the ACP subcommand args. */
  args: string[];
  /** Extra environment variables merged over `process.env`. */
  extraEnv: Record<string, string>;
  /** Spawn with a shell (needed for npm `.cmd` shims on Windows). */
  shell: boolean;
  source: DshSource;
  version?: string;
}

/** A command we can spawn, and whether it needs a shell shim to run. */
interface ResolvedRunner {
  command: string;
  shell: boolean;
  version?: string;
}

const MANAGED_DIR = 'dsh';
const KERNEL_PACKAGE = '@deepseek-ai/dsh';
const KERNEL_BIN = path.join('lib', 'bin.js');
const VERSION_TIMEOUT_MS = 15_000;
const SETUP_TIMEOUT_MS = 300_000;
/** A `-i` login shell runs the user's rc files; do not wait forever for it. */
const SHELL_PATH_TIMEOUT_MS = 5_000;

export class DshLocator {
  constructor(
    private readonly globalStoragePath: string,
    settings: DshSettings,
    private readonly logger: Logger,
  ) {
    this.settingsRef = settings;
  }

  private settingsRef: DshSettings;

  /** SecretStorage key to hand the kernel, when the user stored one. */
  private apiKey: string | undefined;

  /**
   * Directories reported by the user's login shell, resolved at most once per
   * session - the lookup has to spawn an interactive shell, which costs a few
   * hundred milliseconds.
   */
  private loginShellDirsCache: string[] | undefined;

  /** What the last lookup actually did, so "copy diagnostics" can report it. */
  private readonly trail: string[] = [];

  private get settings(): DshSettings {
    return this.settingsRef;
  }

  /** Applies changed settings without a reload (R8). */
  updateSettings(settings: DshSettings): void {
    this.settingsRef = settings;
  }

  /**
   * Supplies (or clears) the key read from SecretStorage. It is exported to the
   * kernel as `DEEPSEEK_API_KEY`, which its credential chain ranks above the
   * managed store - an explicit key for this run wins. Leaving it unset is what
   * lets a `dsh` CLI or desktop install authenticate the kernel instead.
   */
  setApiKey(key: string | undefined): void {
    this.apiKey = key?.trim() ? key.trim() : undefined;
  }

  /** Directory that holds the managed kernel install. */
  get managedDir(): string {
    return path.join(this.globalStoragePath, MANAGED_DIR);
  }

  /** Resolves the best available launch spec, or throws with guidance. */
  async resolve(): Promise<DshLaunchSpec> {
    const attempts: Array<() => Promise<DshLaunchSpec | undefined>> = [
      () => this.fromSetting(),
      () => this.fromManagedInstall(),
      () => this.fromPath(),
    ];

    for (const attempt of attempts) {
      try {
        const spec = await attempt();
        if (spec) {
          this.logger.info(`dsh resolved via ${spec.source}: ${spec.command} ${spec.args.join(' ')}`);
          return spec;
        }
      } catch (err) {
        this.logger.warn(`dsh resolution attempt failed: ${String(err)}`);
      }
    }

    this.logger.warn(`dsh not found. Lookup trail:\n${(await this.probeReport()).join('\n')}`);
    throw new Error(
      l10n.t(
        '未找到 DeepSeek Harness（dsh）。请执行 `npm install -g @deepseek-ai/dsh` 安装，或在命令面板运行“DeepSeek Harness: 安装内核（dsh）”。若你在终端里能用 dsh 而这里找不到，是编辑器没有继承终端的 PATH——在设置 dsh.executablePath 填入 `which dsh` 的结果即可。',
      ),
    );
  }

  /**
   * Where the kernel was looked for and what happened, as report lines. Both
   * the failure path (it goes into the log) and the "copy diagnostics" command
   * use it: on macOS the answer is almost always "the kernel is installed, the
   * editor's PATH just cannot see it", and that is only debuggable if the
   * searched directories and the inherited PATH are visible.
   */
  async probeReport(): Promise<string[]> {
    const dirs = await this.candidateDirs();
    const lines = [
      `- 宿主 PATH: ${process.env.PATH ?? '(空)'}`,
      `- SHELL: ${process.env.SHELL ?? '(未设置)'}`,
      `- 候选目录: ${dirs.length} 个`,
      ...dirs.slice(0, 10).map((dir) => `  - ${dir}`),
    ];
    lines.push(`- dsh: ${(await this.findBinary('dsh')) ?? '未找到'}`);
    lines.push(`- npm: ${(await this.findBinary('npm')) ?? '未找到'}`);
    lines.push(...this.trail.slice(-12).map((entry) => `  · ${entry}`));
    return lines;
  }

  /** Installs (or updates) the kernel into global storage. */
  async installManaged(version: string | undefined, onProgress: (text: string) => void): Promise<DshLaunchSpec> {
    const dir = this.managedDir;
    await fs.mkdir(dir, { recursive: true });
    const pkgSpec = version?.trim() ? `${KERNEL_PACKAGE}@${version.trim()}` : `${KERNEL_PACKAGE}@latest`;
    // `npm` has the same discovery problem as `dsh`: a GUI-launched editor on
    // macOS sees neither Homebrew's nor a version manager's npm, so a bare
    // `execFile('npm')` fails with ENOENT and "Install kernel" looks like it
    // silently did nothing.
    const npm = await this.resolveRunner('npm');
    if (!npm) {
      this.logger.warn(`npm not found. Lookup trail:\n${(await this.probeReport()).join('\n')}`);
      throw new Error(
        l10n.t(
          '未找到 npm，无法安装内核。请先安装 Node.js（含 npm），或在设置 dsh.executablePath 里填入已有的 dsh 绝对路径。',
        ),
      );
    }
    this.logger.info(`Installing ${pkgSpec} with ${npm.command}`);
    onProgress(`Installing ${pkgSpec} ...`);
    await exec(npm.command, ['install', '--global', '--prefix', dir, pkgSpec], {
      shell: npm.shell,
      timeout: SETUP_TIMEOUT_MS,
    });
    onProgress('Install complete.');
    const spec = await this.fromManagedInstall();
    if (!spec) {
      throw new Error(`Kernel installed but the entry point was not found under ${dir}`);
    }
    return spec;
  }

  // -------------------------------------------------------------------------

  /**
   * Environment additions shared by every launch path: the home override, plus
   * the Electron-as-Node flag when the kernel entry point is run by the VS Code
   * runtime instead of a system Node.
   */
  private launchEnv(runner: 'node' | 'direct'): Record<string, string> {
    const env: Record<string, string> = {};
    if (runner === 'node') {
      env.ELECTRON_RUN_AS_NODE = '1';
    }
    const home = this.settings.homeDir;
    if (home) {
      // The kernel resolves its home as `process.env.DSH_HOME || <platform
      // default>`, so this is the supported override. It relocates credentials,
      // sessions, attachments and the user patch layer together.
      env.DSH_HOME = home;
    }
    if (this.apiKey) {
      env[DEEPSEEK_KEY_ENV] = this.apiKey;
    }
    return env;
  }

  private async fromSetting(): Promise<DshLaunchSpec | undefined> {
    const p = this.settings.executablePath;
    if (!p) {
      return undefined;
    }
    await assertFile(p);
    if (p.endsWith('.js') || p.endsWith('.mjs')) {
      return {
        command: process.execPath,
        args: [p, ...this.settings.acpArgs],
        extraEnv: this.launchEnv('node'),
        shell: false,
        source: 'setting',
      };
    }
    // Windows .cmd/.bat shims cannot be spawned directly with shell:false
    // since Node's CVE-2024-27980 fix (EINVAL) - route them through a shell.
    const needsShell = /\.(cmd|bat|ps1)$/i.test(p);
    return {
      command: p,
      args: [...this.settings.acpArgs],
      extraEnv: this.launchEnv('direct'),
      shell: needsShell,
      source: 'setting',
    };
  }

  /**
   * The kernel entry point inside a managed install, under either layout.
   *
   * `npm install --global --prefix <dir>` does not put packages in the same
   * place on every platform: npm documents the global location as
   * `{prefix}/lib/node_modules` (what macOS and Linux use, e.g. Homebrew's
   * `/opt/homebrew/lib/node_modules`), while on Windows it lands directly in
   * `{prefix}/node_modules`. Checking only the Windows shape made "Install
   * kernel" report success and then fail to find what it had just installed.
   */
  private async managedBinPath(): Promise<string | undefined> {
    const candidates = [
      path.join(this.managedDir, 'lib', 'node_modules', ...KERNEL_PACKAGE.split('/'), KERNEL_BIN),
      path.join(this.managedDir, 'node_modules', ...KERNEL_PACKAGE.split('/'), KERNEL_BIN),
    ];
    for (const bin of candidates) {
      try {
        await assertFile(bin);
        return bin;
      } catch {
        // Try the next layout.
      }
    }
    this.logger.warn(
      `Managed kernel entry point not found under ${this.managedDir} (looked for ${candidates.length} layouts)`,
    );
    return undefined;
  }

  private async fromManagedInstall(): Promise<DshLaunchSpec | undefined> {
    const bin = await this.managedBinPath();
    if (!bin) {
      return undefined;
    }
    return {
      command: process.execPath,
      args: [bin, ...this.settings.acpArgs],
      extraEnv: this.launchEnv('node'),
      shell: false,
      source: 'managed',
    };
  }

  private async fromPath(): Promise<DshLaunchSpec | undefined> {
    const runner = await this.resolveRunner('dsh');
    if (!runner) {
      return undefined;
    }
    return {
      command: runner.command,
      args: [...this.settings.acpArgs],
      extraEnv: this.launchEnv('direct'),
      shell: runner.shell,
      source: 'path',
      version: runner.version,
    };
  }

  /**
   * A runnable `dsh`/`npm`: the bare name when the inherited PATH already has
   * it, otherwise an absolute path found without trusting that PATH. Windows is
   * the case where the bare name normally wins (npm writes `.cmd` shims into a
   * directory that is on PATH); macOS launched from the Dock is the case where
   * it normally loses.
   */
  private async resolveRunner(base: string): Promise<ResolvedRunner | undefined> {
    const shim = process.platform === 'win32';
    const onPath = await tryVersion(base, ['--version'], shim);
    if (onPath !== undefined) {
      this.trail.push(`${base}: 走继承的 PATH`);
      return { command: base, shell: shim, version: onPath };
    }
    this.trail.push(`${base}: 不在继承的 PATH 上`);

    const bin = await this.findBinary(base);
    if (!bin) {
      return undefined;
    }
    const shell = /\.(cmd|bat|ps1)$/i.test(bin);
    const version = await tryVersion(bin, ['--version'], shell);
    if (version === undefined) {
      this.trail.push(`${base}: 找到 ${bin} 但无法执行`);
      this.logger.warn(`Found ${bin} but running it failed`);
      return undefined;
    }
    return { command: bin, shell, version };
  }

  /**
   * First executable named `base` among the off-PATH candidate directories.
   * Pure directory math lives in `kernelPaths.ts`; this only touches the disk.
   */
  private async findBinary(base: string): Promise<string | undefined> {
    const dirs = await this.candidateDirs();
    for (const dir of dirs) {
      for (const name of binaryFileNames(base, process.platform)) {
        const candidate = path.join(dir, name);
        if (await isExecutableFile(candidate)) {
          this.trail.push(`${base}: ${candidate}`);
          return candidate;
        }
      }
    }
    this.trail.push(`${base}: 不在 ${dirs.length} 个候选目录中`);
    return undefined;
  }

  /** Candidate directories, with version-manager globs expanded. */
  private async candidateDirs(): Promise<string[]> {
    const sources = { home: os.homedir(), platform: process.platform, env: process.env };
    const expanded: string[] = [];
    for (const dir of candidateBinDirs(sources)) {
      if (dir.includes('*')) {
        expanded.push(...(await expandOneLevel(dir)));
      } else {
        expanded.push(dir);
      }
    }
    return dedupeDirs(expanded, await this.loginShellDirs());
  }

  /**
   * `PATH` as the user's own shell sees it. Only consulted when the cheaper
   * probes failed, and cached: spawning an interactive login shell is the most
   * expensive thing here and its answer cannot change mid-session.
   */
  private async loginShellDirs(): Promise<string[]> {
    if (process.platform === 'win32') {
      return [];
    }
    if (this.loginShellDirsCache) {
      return this.loginShellDirsCache;
    }
    const shell = process.env.SHELL?.trim() || '/bin/sh';
    try {
      const { stdout } = await exec(shell, ['-ilc', `printf '${SHELL_PATH_MARKER}%s\\n' "$PATH"`], {
        timeout: SHELL_PATH_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
      });
      const dirs = parseShellPathOutput(stdout);
      this.trail.push(`login shell ${shell}: ${dirs.length} 个 PATH 目录`);
      this.loginShellDirsCache = dirs;
    } catch (err) {
      this.trail.push(`login shell ${shell}: 读取 PATH 失败`);
      this.logger.warn(`Could not read PATH from ${shell}: ${String(err)}`);
      this.loginShellDirsCache = [];
    }
    return this.loginShellDirsCache;
  }

  /**
   * Installs the version-paired ACP plugin into the configured profile:
   * `dsh plugin --profile <profile> add @deepseek-ai/dsh-acp-app@<kernelVersion>`.
   * The ACP server only exists as a profile plugin (0.1.2+ kernel line) and
   * its import surface must match the kernel version exactly.
   */
  async ensureAcpProfile(spec: DshLaunchSpec, onProgress: (text: string) => void): Promise<void> {
    const version = (await this.probeVersion(spec)) ?? this.settings.preferredVersion ?? 'latest';
    const plugin = `${this.settings.acpPluginPackage}@${version}`;
    const profile = this.settings.acpProfile;
    onProgress(`Installing ${plugin} into profile "${profile}" ...`);
    this.logger.info(`Bootstrapping ACP profile: plugin add ${plugin}`);
    // For node-runner specs the first arg is the kernel entry point; the ACP
    // boot args must not leak into the `plugin add` invocation.
    const base = spec.command === process.execPath && spec.args.length > 0 ? [spec.args[0]!] : [];
    await exec(spec.command, [...base, 'plugin', '--profile', profile, 'add', plugin], {
      shell: spec.shell,
      timeout: SETUP_TIMEOUT_MS,
      env: { ...process.env, ...spec.extraEnv },
    });
    onProgress('ACP profile ready.');
  }

  /** Best-effort version probe used for logging and diagnostics. */
  async probeVersion(spec: DshLaunchSpec): Promise<string | undefined> {
    const versionArgs = spec.command === process.execPath ? [spec.args[0] ?? '', '--version'] : ['--version'];
    return tryVersion(spec.command, versionArgs, spec.shell, spec.extraEnv);
  }
}

async function assertFile(p: string): Promise<void> {
  const stat = await fs.stat(p).catch(() => undefined);
  if (!stat || !stat.isFile()) {
    throw new Error(`Not a file: ${p}`);
  }
}

/** `X_OK` on POSIX; on Windows an existing regular file is enough. */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      await fs.access(p, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Expands a one-level glob, the shape every Node version manager uses to keep
 * one directory per installed version. A hand-rolled expander rather than a glob
 * dependency: every pattern in `kernelPaths.ts` has exactly one wildcard, which
 * stands for a single directory entry.
 */
async function expandOneLevel(pattern: string): Promise<string[]> {
  const star = pattern.indexOf('*');
  if (star < 0) {
    return [pattern];
  }
  const parent = pattern.slice(0, star).replace(/[\\/]+$/, '');
  const rest = pattern.slice(star + 1).replace(/^[\\/]+/, '');
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name, rest));
  } catch {
    return [];
  }
}

async function tryVersion(
  command: string,
  args: string[],
  shell: boolean,
  extraEnv: Record<string, string> = {},
): Promise<string | undefined> {
  try {
    const { stdout } = await exec(command, args, {
      shell,
      timeout: VERSION_TIMEOUT_MS,
      env: { ...process.env, ...extraEnv },
    });
    const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);
    return firstLine?.trim();
  } catch {
    return undefined;
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function exec(
  command: string,
  args: string[],
  options: cp.ExecFileOptions & { timeout?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    cp.execFile(command, args, options, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${String(err.message)} ${stderr}`.trim()));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
