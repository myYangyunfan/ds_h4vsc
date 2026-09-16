/**
 * Bridges process management and the ACP client: ensures a kernel is running,
 * performs the handshake, and applies a bounded auto-restart policy when the
 * kernel crashes. The rest of the extension talks to `AcpBackend` only.
 */
import { l10n } from 'vscode';
import type {
  AcpAuthenticateMethod,
  KernelHandlers,
  PromptContentBlock,
  PromptStopReason,
} from '@dsh-vscode/core';
import { AcpClient, type SessionHandle } from './AcpClient.js';
import type { DshLocator, DshLaunchSpec } from './DshLocator.js';
import { DshProcess } from './DshProcess.js';
import type { Logger } from '../util/log.js';

export interface BackendCapabilities {
  authMethods: AcpAuthenticateMethod[];
  canLoadSession: boolean;
}

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;
const CONNECT_TIMEOUT_MS = 20_000;

export class AcpBackend {
  private client: AcpClient | undefined;
  private connecting: Promise<AcpClient> | undefined;
  private readonly process: DshProcess;
  private readonly restartTimes: number[] = [];
  private crashHandler: ((err: Error) => void) | undefined;
  /** Incremented per spawn; stale exit callbacks check it and stay silent. */
  private generation = 0;
  /** True while the current child is being stopped intentionally. */
  private stopping = false;

  constructor(
    private readonly locator: DshLocator,
    private readonly logger: Logger,
  ) {
    this.process = new DshProcess(logger);
  }

  /** Registers a callback invoked when the kernel dies unexpectedly. */
  onCrash(handler: (err: Error) => void): void {
    this.crashHandler = handler;
  }

  get capabilities(): BackendCapabilities {
    return {
      authMethods: this.client?.authMethods ?? [],
      canLoadSession: this.client?.canLoadSession ?? false,
    };
  }

  get connected(): boolean {
    return this.client !== undefined && !this.client.closed;
  }

  /** Returns a connected client, spawning + handshaking if necessary. */
  async ensureConnected(handlers: KernelHandlers): Promise<AcpClient> {
    if (this.connected) {
      return this.client!;
    }
    this.client = undefined;
    this.connecting ??= this.spawnAndConnect(handlers).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async newSession(cwd: string, handlers: KernelHandlers): Promise<SessionHandle> {
    const client = await this.ensureConnected(handlers);
    return client.newSession(cwd);
  }

  async loadSession(cwd: string, sessionId: string, handlers: KernelHandlers): Promise<SessionHandle> {
    const client = await this.ensureConnected(handlers);
    return client.loadSession(cwd, sessionId);
  }

  async prompt(
    sessionId: string,
    blocks: PromptContentBlock[],
    handlers: KernelHandlers,
  ): Promise<PromptStopReason> {
    const client = await this.ensureConnected(handlers);
    return client.prompt(sessionId, blocks);
  }

  cancel(sessionId: string): void {
    this.client?.cancel(sessionId);
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.client?.setMode(sessionId, modeId);
  }

  async authenticate(methodId: string): Promise<void> {
    if (!this.client) {
      throw new Error('The kernel is not connected yet');
    }
    await this.client.authenticate(methodId);
  }

  async installKernel(onProgress: (text: string) => void): Promise<DshLaunchSpec> {
    return this.locator.installManaged(undefined, onProgress);
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    this.generation += 1;
    await this.client?.dispose();
    await this.process.stop();
  }

  // -------------------------------------------------------------------------

  private async spawnAndConnect(handlers: KernelHandlers): Promise<AcpClient> {
    if (this.restartTimes.length >= MAX_RESTARTS) {
      const windowStart = Date.now() - RESTART_WINDOW_MS;
      while (this.restartTimes.length > 0 && this.restartTimes[0]! < windowStart) {
        this.restartTimes.shift();
      }
      if (this.restartTimes.length >= MAX_RESTARTS) {
        throw new Error(
          l10n.t(
            '内核在 {0} 秒内崩溃了 {1} 次。详情见 DeepSeek Harness 输出通道。',
            String(MAX_RESTARTS),
            String(RESTART_WINDOW_MS / 1000),
          ),
        );
      }
    }

    const spec = await this.locator.resolve();
    try {
      const client = await this.spawnOnce(spec, handlers);
      this.client = client;
      return client;
    } catch (firstErr) {
      // A missing/unbootable ACP profile is the common first-run gap: the
      // kernel starts but the ACP app never mounts, so initialize never
      // answers. Bootstrap the version-paired profile once and retry.
      this.logger.warn(`First connect attempt failed (${String(firstErr)}); bootstrapping ACP profile`);
      await this.locator.ensureAcpProfile(spec, (text) => this.logger.info(text));
      const client = await this.spawnOnce(spec, handlers);
      this.client = client;
      return client;
    }
  }

  private async spawnOnce(spec: DshLaunchSpec, handlers: KernelHandlers): Promise<AcpClient> {
    return new Promise<AcpClient>((resolve, reject) => {
      let settled = false;
      const myGeneration = ++this.generation;
      this.stopping = false;
      const kernel = this.process.spawn(spec, (code) => {
        // Stale child (superseded by a retry) or intentional stop: this exit
        // is not a crash - do not clear the healthy client or pollute stats.
        if (myGeneration !== this.generation || this.stopping) {
          return;
        }
        this.client = undefined;
        if (!settled) {
          settled = true;
          reject(new Error(l10n.t('内核启动期间退出（code {0}）', String(code))));
          return;
        }
        this.restartTimes.push(Date.now());
        this.crashHandler?.(new Error(l10n.t('内核意外退出（code {0}）', String(code))));
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.stopping = true;
          void this.process.stop().finally(() => {
            this.stopping = false;
          });
          reject(new Error(l10n.t('内核未在 {0} 秒内响应 ACP 握手', String(CONNECT_TIMEOUT_MS / 1000))));
          return;
        }
      }, CONNECT_TIMEOUT_MS);

      AcpClient.connect(kernel.child, handlers).then(
        (c) => {
          if (settled) {
            void c.dispose();
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(c);
        },
        (err) => {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.stopping = true;
          void this.process.stop().finally(() => {
            this.stopping = false;
          });
        },
      );
    });
  }
}
