/**
 * Owns the dsh kernel child process: spawn from a launch spec, stream stderr
 * into the log, and terminate reliably (including the full process tree on
 * Windows, where `child.kill()` only reaches the direct child).
 */
import * as cp from 'node:child_process';
import type { DshLaunchSpec } from './DshLocator.js';
import type { Logger } from '../util/log.js';

export interface SpawnedKernel {
  child: cp.ChildProcess;
  spec: DshLaunchSpec;
}

/** Quotes an argument for cmd.exe when needed (spaces or metacharacters). */
function shellQuote(arg: string): string {
  if (/^[\w./:-]+$/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export class DshProcess {
  private current: SpawnedKernel | undefined;

  constructor(private readonly logger: Logger) {}

  spawn(spec: DshLaunchSpec, onExit: (code: number | null) => void): SpawnedKernel {
    this.logger.info(`Spawning kernel: ${spec.command} ${spec.args.join(' ')}`);
    // With shell:true Node concatenates args into one command line without
    // quoting; explicit quoting prevents whitespace/metachar breakage.
    const commandLine = spec.shell
      ? [spec.command, ...spec.args.map(shellQuote)].join(' ')
      : undefined;
    const child = cp.spawn(commandLine ?? spec.command, commandLine ? [] : spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: spec.shell,
      env: { ...process.env, ...spec.extraEnv },
      windowsHide: true,
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.logger.debug(`[dsh stderr] ${chunk.trimEnd()}`);
    });

    child.on('exit', (code) => {
      this.logger.warn(`Kernel exited with code ${code}`);
      if (this.current?.child === child) {
        this.current = undefined;
      }
      onExit(code);
    });
    child.on('error', (err) => {
      this.logger.error(`Kernel process error: ${err.message}`);
    });

    this.current = { child, spec };
    return this.current;
  }

  get running(): SpawnedKernel | undefined {
    return this.current;
  }

  async stop(): Promise<void> {
    const kernel = this.current;
    if (!kernel) {
      return;
    }
    this.current = undefined;
    const { child } = kernel;
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // Force-kill the tree; required on Windows for npm shims.
        if (process.platform === 'win32' && child.pid) {
          cp.execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
        } else {
          child.kill('SIGKILL');
        }
        resolve();
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
