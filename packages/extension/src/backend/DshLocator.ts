/**
 * Locates a runnable DeepSeek Harness kernel, in order of preference:
 *  1. `dsh.executablePath` setting
 *  2. A managed install inside the extension's global storage
 *     (`<globalStorage>/dsh/node_modules/@deepseek-ai/dsh`), driven by
 *     `installManaged()`
 *  3. `dsh` on the PATH (global npm install)
 *
 * JS entry points are executed with the running VS Code Electron binary in
 * node mode (ELECTRON_RUN_AS_NODE), which avoids requiring a system Node.
 */
import { l10n } from 'vscode';
import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DshSettings } from '../config/Settings.js';
import type { Logger } from '../util/log.js';

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

const MANAGED_DIR = 'dsh';
const KERNEL_PACKAGE = '@deepseek-ai/dsh';
const KERNEL_BIN = path.join('lib', 'bin.js');
const VERSION_TIMEOUT_MS = 15_000;
const SETUP_TIMEOUT_MS = 300_000;

export class DshLocator {
  constructor(
    private readonly globalStoragePath: string,
    settings: DshSettings,
    private readonly logger: Logger,
  ) {
    this.settingsRef = settings;
  }

  private settingsRef: DshSettings;

  private get settings(): DshSettings {
    return this.settingsRef;
  }

  /** Applies changed settings without a reload (R8). */
  updateSettings(settings: DshSettings): void {
    this.settingsRef = settings;
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

    throw new Error(
      l10n.t(
        '未找到 DeepSeek Harness（dsh）。请执行 `npm install -g @deepseek-ai/dsh` 安装，或在命令面板运行“DeepSeek Harness: 安装内核（dsh）”。',
      ),
    );
  }

  /** Installs (or updates) the kernel into global storage. */
  async installManaged(version: string | undefined, onProgress: (text: string) => void): Promise<DshLaunchSpec> {
    const dir = this.managedDir;
    await fs.mkdir(dir, { recursive: true });
    const pkgSpec = version?.trim() ? `${KERNEL_PACKAGE}@${version.trim()}` : `${KERNEL_PACKAGE}@latest`;
    onProgress(`Installing ${pkgSpec} ...`);
    await exec('npm', ['install', '--global', '--prefix', dir, pkgSpec], { shell: process.platform === 'win32' });
    onProgress('Install complete.');
    const spec = await this.fromManagedInstall();
    if (!spec) {
      throw new Error(`Kernel installed but the entry point was not found under ${dir}`);
    }
    return spec;
  }

  // -------------------------------------------------------------------------

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
        extraEnv: electronNodeEnv(),
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
      extraEnv: {},
      shell: needsShell,
      source: 'setting',
    };
  }

  private async fromManagedInstall(): Promise<DshLaunchSpec | undefined> {
    const bin = path.join(this.managedDir, 'node_modules', ...KERNEL_PACKAGE.split('/'), KERNEL_BIN);
    try {
      await assertFile(bin);
    } catch {
      return undefined;
    }
    return {
      command: process.execPath,
      args: [bin, ...this.settings.acpArgs],
      extraEnv: electronNodeEnv(),
      shell: false,
      source: 'managed',
    };
  }

  private async fromPath(): Promise<DshLaunchSpec | undefined> {
    const shell = process.platform === 'win32';
    const version = await tryVersion('dsh', ['--version'], shell);
    if (version === undefined) {
      return undefined;
    }
    return { command: 'dsh', args: [...this.settings.acpArgs], extraEnv: {}, shell, source: 'path', version };
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

function electronNodeEnv(): Record<string, string> {
  return { ELECTRON_RUN_AS_NODE: '1' };
}

async function assertFile(p: string): Promise<void> {
  const stat = await fs.stat(p).catch(() => undefined);
  if (!stat || !stat.isFile()) {
    throw new Error(`Not a file: ${p}`);
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
