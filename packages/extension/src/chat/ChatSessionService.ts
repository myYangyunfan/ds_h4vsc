/**
 * The chat orchestrator: owns the timeline reducer and the session state
 * machine (idle -> prompting -> awaitingApproval -> idle), funnels ACP updates
 * into the timeline, applies reducer effects to the working set, answers
 * permission requests via the approval bridge, and pushes coalesced snapshots
 * to the webview.
 */
import * as path from 'node:path';
import { l10n } from 'vscode';
import * as vscode from 'vscode';
import {
  TimelineReducer,
  contentBlockText,
  type AccountBalance,
  type AgentModeInfo,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpSessionUpdate,
  type ApprovalRequest,
  type ContextAttachment,
  type EditInfo,
  type KernelHandlers,
  type PromptContentBlock,
  type QuickActionId,
  type ContextUsage,
  type SessionConfigOption,
  type SessionMeta,
  type SessionStatus,
  type SlashCommandInfo,
  type TimelineEffect,
  type TimelineEntry,
  type ToWebview,
} from '@dsh-vscode/core';
import { buildSnapshot } from './EventMapper.js';
import type { AcpBackend } from '../backend/AcpBackend.js';
import type { SessionHandle } from '../backend/AcpClient.js';
import type { WorkingSet } from '../editor/WorkingSet.js';
import { FileChangeTracker, type DerivedEdit } from '../editor/FileChangeTracker.js';
import type { ContextService } from '../editor/ContextService.js';
import type { DiffService } from '../editor/DiffService.js';
import type { ApprovalBridge } from '../approval/ApprovalBridge.js';
import type { SessionStore, MementoLike } from './SessionStore.js';
import { TimelineStore } from './TimelineStore.js';
import type { DshSettings } from '../config/Settings.js';
import type { Logger } from '../util/log.js';

/** Model-facing prompts for the quick actions (Chinese-primary workspace). */
export const QUICK_PROMPTS: Record<QuickActionId, string> = {
  explainSelection: '请详细解释附件中的代码：作用、逻辑与潜在问题。',
  writeTests: '请为附件中的代码编写单元测试，说明所选测试框架并覆盖边界情况。',
  refactor: '请重构附件中的代码：保持行为不变，提升可读性与结构，并说明改动理由。',
  init: '/init',
};

/** Push channel consumed by the PanelController. */
export interface SnapshotSink {
  pushSnapshot(payload: ToWebview): void;
  pushChunk(entryId: string, textDelta: string, thoughtDelta?: string): void;
  pushError(message: string): void;
}

const SNAPSHOT_COALESCE_MS = 80;
/**
 * Streaming text already travels as `chunk` deltas, so a full snapshot is only
 * needed to refresh everything else. Each one is cloned whole on both sides, so
 * during a turn they are spaced out rather than sent at the idle cadence.
 */
const SNAPSHOT_COALESCE_STREAMING_MS = 250;
/** How long a timeline change may sit unpersisted while a turn streams. */
const PERSIST_COALESCE_MS = 1_500;
/** Don't hit the provider's balance endpoint more often than this. */
const BALANCE_REFRESH_MS = 60_000;

export class ChatSessionService implements vscode.Disposable {
  private readonly backend: AcpBackend;
  private readonly workingSet: WorkingSet;
  private readonly diffService: DiffService;
  private readonly approvals: ApprovalBridge;
  private readonly sessions: SessionStore;
  private readonly contexts: ContextService;
  private readonly logger: Logger;
  private status: SessionStatus = 'disconnected';
  private statusDetail: string | undefined;
  private sessionId: string | undefined;
  private modes: AgentModeInfo[] = [];
  private modeId: string | undefined;
  private kernelCommands: SlashCommandInfo[] = [];
  /** Session settings the kernel exposes (model, reasoning effort). */
  private configOptions: SessionConfigOption[] = [];
  /** Context occupancy reported by the kernel, if it reports any. */
  private usage: ContextUsage | undefined;
  /**
   * Choices made while no session existed yet, applied once one does.
   * Without this the picker would look settable and silently do nothing.
   */
  private readonly pendingConfig = new Map<string, string>();
  private unwatchWorkingSet: (() => void) | undefined;
  /** Account balance; ACP has no billing, so the host fetches it itself. */
  private balance: AccountBalance | undefined;
  /** Supplies the balance on demand; injected by the extension host. */
  private balanceProvider: (() => Promise<AccountBalance | undefined>) | undefined;
  private balanceRefreshing = false;
  private lastBalanceAt = 0;
  private history: SessionMeta[] = [];
  private readonly reducer: TimelineReducer;
  private readonly sink: SnapshotSink;
  private snapshotTimer: NodeJS.Timeout | undefined;
  private persistTimer: NodeJS.Timeout | undefined;
  /** Entry count at the last pushed snapshot, to spot structural changes. */
  private lastSnapshotEntries = 0;
  private handlers: KernelHandlers | undefined;
  private captures = new Map<string, { text: string }>();
  private autoReconnecting = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private settingsRef: DshSettings;
  private timelines: TimelineStore | undefined;
  private panelSink: ((message: ToWebview) => void) | undefined = undefined;
  /** Derives reviewable edits from the kernel's mutation calls. */
  private readonly fileChanges = new FileChangeTracker();
  /** Guards the once-per-turn auto-open of the diff review loop. */
  private reviewOpened = false;
  /**
   * The session the kernel currently has open, if any.
   *
   * The kernel activates a session on `session/new` and on `session/resume`,
   * and rejects resuming one that is already active ("session is already
   * active"). Tracking it here is what keeps the extension from asking twice,
   * and `sessionId` alone cannot tell the two apart: it is also restored from
   * workspaceState after a window reload, when the fresh kernel has nothing
   * active at all.
   */
  private activeSessionId: string | undefined;

  private get settings(): DshSettings {
    return this.settingsRef;
  }

  constructor(
    backend: AcpBackend,
    workingSet: WorkingSet,
    diffService: DiffService,
    approvals: ApprovalBridge,
    sessions: SessionStore,
    contexts: ContextService,
    settings: DshSettings,
    logger: Logger,
  ) {
    this.backend = backend;
    this.workingSet = workingSet;
    this.diffService = diffService;
    this.approvals = approvals;
    this.sessions = sessions;
    this.contexts = contexts;
    this.settingsRef = settings;
    this.logger = logger;
    this.watchWorkingSet();
    this.sink = {
      pushSnapshot: (payload) => this.postToPanel(payload),
      pushChunk: (entryId, textDelta, thoughtDelta) => {
        this.postToPanel({ type: 'chunk', entryId, textDelta, thoughtDelta });
      },
      pushError: (message) => {
        this.postToPanel({ type: 'error', message });
      },
    };
    this.reducer = new TimelineReducer(undefined, {
      onChunkAppended: (entryId, _role, delta) => this.sink.pushChunk(entryId, delta),
      onThoughtAppended: (entryId, delta) => this.sink.pushChunk(entryId, '', delta),
    });

    this.backend.onCrash((err) => {
      // The panel shows this too, but the output channel is what survives a
      // window reload and what a bug report can quote - and without a line here
      // a real crash was indistinguishable from an intentional shutdown.
      this.logger.error('Kernel crashed', err);
      this.status = 'disconnected';
      this.statusDetail = err.message;
      this.sessionId = undefined;
      // The kernel process is gone, so nothing is active in it any more; a
      // replacement process starts with an empty session table.
      this.activeSessionId = undefined;
      this.handlers = undefined;
      this.reducer.addError(l10n.t('内核已退出：{0}', err.message));
      this.flushSnapshot();
      // R13: one silent auto-reconnect so brief kernel crashes self-heal;
      // repeated failures surface through the banner instead.
      if (!this.autoReconnecting) {
        this.autoReconnecting = true;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          void this.reconnect().finally(() => {
            this.autoReconnecting = false;
          });
        }, 2_000);
      }
    });
  }

  /** R8: apply changed settings without reloading the window. */
  updateSettings(settings: DshSettings): void {
    this.settingsRef = settings;
  }

  /**
   * Opens the restored session in the kernel without waiting for a prompt.
   *
   * The kernel reports its session settings - the model picker, the reasoning
   * level - only from `session/new` or `session/resume`. A panel that merely
   * restored a transcript therefore had nothing to show, and the controls read
   * as missing until the user happened to send a message.
   */
  async primeSession(): Promise<void> {
    if (!this.sessionId || this.activeSessionId === this.sessionId) {
      return;
    }
    try {
      const handlers = await this.ensureKernel();
      await this.ensureSessionActive(handlers);
      // Logged because "the controls are missing" was invisible otherwise: the
      // panel looked the same whether the kernel reported no options or was
      // never contacted at all.
      this.logger.info(
        `Prepared session ${this.sessionId} with ${this.configOptions.length} config option(s)`,
      );
      this.flushSnapshot();
    } catch (err) {
      // Best-effort: an unreachable kernel is retried when the user sends.
      this.logger.warn(`Could not prepare the restored session: ${String(err)}`);
    }
  }

  /** Supplies the balance the panel displays; the host owns the credentials. */
  setBalanceProvider(provider: () => Promise<AccountBalance | undefined>): void {
    this.balanceProvider = provider;
  }

  /**
   * Makes sure a session with content is present in the history list.
   *
   * Only sessions the panel created used to be registered, so a conversation
   * held in an adopted session - one reopened from the kernel's history, or
   * restored from workspaceState after a reload - never appeared in the list and
   * looked unsaved. An existing entry is left alone so a user's rename or an
   * AI-generated title survives.
   */
  private async ensureSessionListed(sessionId: string, fallbackTitle: string): Promise<void> {
    const existing = (await this.sessions.list()).find((meta) => meta.sessionId === sessionId);
    if (existing) {
      return;
    }
    await this.sessions.upsert(sessionId, fallbackTitle);
    await this.reloadHistory();
  }

  /**
   * Refreshes the account balance. Throttled because it is a network call to the
   * provider, and silent on failure: a balance the panel could not fetch is not
   * something the user can act on.
   */
  async refreshBalance(force = false): Promise<void> {
    if (!this.balanceProvider || this.balanceRefreshing) {
      return;
    }
    if (!force && Date.now() - this.lastBalanceAt < BALANCE_REFRESH_MS) {
      return;
    }
    this.balanceRefreshing = true;
    try {
      const balance = await this.balanceProvider();
      this.lastBalanceAt = Date.now();
      if (balance !== undefined) {
        this.balance = balance;
        this.flushSnapshot();
      }
    } finally {
      this.balanceRefreshing = false;
    }
  }

  /**
   * Keeps the panel in step with the working set.
   *
   * Accepting or rejecting an edit changes the working set, and the panel renders
   * it from snapshots - without this the bar kept showing the old states, so the
   * review buttons looked like they did nothing even though the file on disk had
   * already changed.
   */
  private watchWorkingSet(): void {
    this.unwatchWorkingSet = this.workingSet.onChange(() => this.scheduleSnapshot());
  }

  /** Wires workspaceState-backed timeline persistence. */
  setMemento(memento: MementoLike): void {
    this.timelines = new TimelineStore(memento);
  }

  /** Installed by the PanelController; the only webview coupling point. */
  setPanelSink(sink: (message: ToWebview) => void): void {
    this.panelSink = sink;
  }

  /** Refreshed by the PanelController from the SessionStore. */
  async reloadHistory(): Promise<void> {
    this.history = await this.sessions.list();
    this.scheduleSnapshot();
  }

  /**
   * Persists the current transcript so it survives a window reload and can be
   * reopened later. See TimelineStore for why this is keyed by session.
   */
  async persistTimeline(): Promise<void> {
    if (!this.timelines || !this.sessionId) {
      return;
    }
    await this.timelines.save(this.sessionId, this.reducer.entries, this.workingSet.list());
    this.logger.debug(`Persisted ${this.reducer.entries.length} entries for ${this.sessionId}`);
  }

  /** Restores the most recently used conversation (called once on activation). */
  async restoreTimeline(): Promise<void> {
    const latest = this.timelines?.latest();
    if (!latest) {
      return;
    }
    this.sessionId = latest.sessionId;
    this.reducer.restore(latest.timeline.entries);
    for (const edit of latest.timeline.workingSet) {
      this.workingSet.registerEdit(edit);
    }
    this.setStatus('disconnected');
    this.logger.info(
      `Restored timeline for ${latest.sessionId}: ${latest.timeline.entries.length} entries`,
    );
    // A conversation restored from storage must be listed as well: it may have
    // been held in a session the panel never created, and an unlisted
    // conversation is indistinguishable from an unsaved one.
    await this.ensureSessionListed(latest.sessionId, titleFromEntries(latest.timeline.entries));
  }

  /**
   * Loads a stored transcript into the panel.
   *
   * The kernel resumes a session without replaying its messages, so a stored
   * transcript is the only way an older conversation can actually be read.
   * Returns false when nothing was kept for it.
   */
  private restoreSessionTimeline(sessionId: string): boolean {
    const stored = this.timelines?.load(sessionId);
    if (!stored) {
      return false;
    }
    this.reducer.restore(stored.entries);
    for (const edit of stored.workingSet) {
      this.workingSet.registerEdit(edit);
    }
    return true;
  }

  /** Drops the stored transcript of a session the user deleted. */
  async forgetTimeline(sessionId: string): Promise<void> {
    await this.timelines?.forget(sessionId);
  }

  // -------------------------------------------------------------------------
  // Public API (invoked from PanelController and commands)
  // -------------------------------------------------------------------------

  async submitPrompt(text: string, attachments: ContextAttachment[]): Promise<void> {
    // Guard against double-fire while the kernel is still connecting: the
    // composer Enter path can race the synchronous status change.
    if (
      this.status === 'connecting' ||
      this.status === 'prompting' ||
      this.status === 'awaitingApproval'
    ) {
      return;
    }
    const trimmed = text.trim();
    const merged = this.mergeActiveSelection(attachments);
    if (!trimmed && merged.length === 0) {
      return;
    }

    try {
      this.setStatus('connecting');
      const handlers = await this.ensureKernel();

      if (!this.sessionId) {
        const handle = await this.backend.newSession(this.workspaceRoot(), handlers);
        this.sessionId = handle.sessionId;
        this.activeSessionId = handle.sessionId;
        this.applySessionState(handle);
        const defaultTitle = trimmed.slice(0, 60);
        await this.ensureSessionListed(handle.sessionId, defaultTitle);
        // R9: replace the truncated-default title with an AI-generated one.
        void this.autoTitle(handle.sessionId, defaultTitle);
      } else {
        // A session restored from workspaceState is not open in a fresh kernel.
        await this.ensureSessionActive(handlers);
        // A session the panel did not create - restored after a reload, or
        // adopted from the kernel's own history - must still be listed, or the
        // conversation the user just had looks unsaved.
        await this.ensureSessionListed(this.sessionId, trimmed.slice(0, 60));
      }

      await this.applyPendingConfig(handlers);
      this.reducer.addUserMessage(trimmed, merged);
      this.setStatus('prompting');
      this.reviewOpened = false;

      const blocks = this.buildPromptBlocks(trimmed, merged);
      const stop = await this.backend.prompt(this.sessionId, blocks, handlers);
      this.logger.info(`Prompt finished: ${stop}`);
      this.setStatus('idle');
      // Copilot agent-mode nicety: jump straight into the review loop when the
      // turn produced pending edits. Wait for the file reads that derive them
      // from the kernel's mutation calls, which settle just after the last tool.
      await this.fileChanges.drain();
      this.maybeAutoOpenReview();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('Prompt failed', err instanceof Error ? err : undefined);
      this.reducer.addError(message);
      this.setStatus('error', message);
    }
  }

  /**
   * One-shot generation on an ephemeral session (git commit messages, etc).
   * The capture is keyed to the ephemeral session id, so updates from the
   * user's main chat session are never intercepted.
   */
  async oneShot(prompt: string): Promise<string> {
    const capture: { text: string } = { text: '' };
    let sessionId: string | undefined;
    try {
      const handlers = await this.ensureKernel();
      const session = await this.backend.newSession(this.workspaceRoot(), handlers);
      sessionId = session.sessionId;
      this.captures.set(sessionId, capture);
      await this.backend.prompt(sessionId, [{ type: 'text', text: prompt }], handlers);
      return capture.text.trim();
    } finally {
      if (sessionId !== undefined) {
        this.captures.delete(sessionId);
      }
    }
  }

  cancel(): void {
    if (this.sessionId) {
      this.backend.cancel(this.sessionId);
    }
  }

  /** Re-establishes the kernel connection after a crash or error. */
  async reconnect(): Promise<void> {
    if (this.status === 'prompting' || this.status === 'awaitingApproval') {
      return;
    }
    try {
      this.setStatus('connecting');
      await this.ensureKernel();
      await this.reloadHistory();
      this.setStatus('idle');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.reducer.addError(message);
      this.setStatus('error', message);
    }
  }

  async newChat(): Promise<void> {
    // Leave the session in the kernel before starting a new one: it stays
    // active until closed, and an active session cannot be resumed later.
    // Keep the conversation before leaving it: it stays reopenable from the
    // sessions list, and the kernel will not replay it for us.
    await this.persistTimeline();
    await this.releaseActiveSession();
    this.sessionId = undefined;
    this.activeSessionId = undefined;
    this.modes = [];
    this.modeId = undefined;
    this.kernelCommands = [];
    // The options are deliberately kept: the model list is account-wide, and
    // clearing it made the controls disappear until the first message created a
    // session. Only the context meter is session-specific.
    this.usage = undefined;
    this.reducer.reset();
    this.workingSet.clear();
    this.setStatus('idle');
  }

  async loadSession(sessionId: string): Promise<void> {
    // Already the session the kernel has open: resuming it again is rejected,
    // and the panel is showing it anyway.
    if (sessionId === this.activeSessionId) {
      this.sessionId = sessionId;
      this.setStatus('idle');
      this.scheduleSnapshot();
      return;
    }
    try {
      this.setStatus('connecting');
      this.reducer.reset();
      this.workingSet.clear();
      const handlers = await this.ensureKernel();
      // Free the current one first: the kernel holds a session active until it
      // is closed, and closing is not destructive - the session can be resumed
      // again later.
      await this.releaseActiveSession();
      const handle = await this.backend.loadSession(this.workspaceRoot(), sessionId, handlers);
      this.sessionId = handle.sessionId;
      this.activeSessionId = handle.sessionId;
      this.applySessionState(handle);
      // The kernel resumes the session but does not replay its messages, so the
      // transcript comes from what was stored while it was live.
      const restored = this.restoreSessionTimeline(handle.sessionId);
      this.logger.info(
        restored
          ? `Opened session ${handle.sessionId} with a stored transcript`
          : `Opened session ${handle.sessionId} with no stored transcript`,
      );
      if (!restored) {
        // Say so rather than presenting an empty panel: the session is open and
        // usable, it just has no text to show.
        void vscode.window.showInformationMessage(
          l10n.t('此会话没有保存的对话内容，面板会是空的；从此版本起新对话都会保留，可从左侧会话列表重新打开。'),
        );
      }
      this.setStatus('idle');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAlreadyActive(message)) {
        // The kernel is telling us the session is open, which is exactly the
        // state we wanted. Adopt it instead of reporting a failure.
        this.sessionId = sessionId;
        this.activeSessionId = sessionId;
        this.setStatus('idle');
        return;
      }
      this.logger.warn(`Could not open session ${sessionId}: ${message}`);
      this.reducer.addError(message);
      this.setStatus('error', message);
    }
  }

  /**
   * Makes sure the kernel has `sessionId` open before it is used.
   *
   * Needed after a window reload: the timeline - and with it the session id -
   * is restored from workspaceState, but the kernel process is new and has
   * nothing active, so the first prompt in a restored chat would otherwise
   * address a session it does not know.
   */
  private async ensureSessionActive(handlers: KernelHandlers): Promise<void> {
    const target = this.sessionId;
    if (!target || this.activeSessionId === target) {
      return;
    }
    await this.releaseActiveSession();
    try {
      const handle = await this.backend.loadSession(this.workspaceRoot(), target, handlers);
      this.activeSessionId = handle.sessionId;
      // Apply what the resume reported. Discarding it left the session
      // configuration empty, so the model and reasoning pickers had nothing to
      // show even though the kernel had just handed them over.
      this.applySessionState(handle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAlreadyActive(message)) {
        this.activeSessionId = target;
        return;
      }
      throw err;
    }
  }

  /** Applies choices made before a session existed, once one does. */
  private async applyPendingConfig(handlers: KernelHandlers): Promise<void> {
    if (this.pendingConfig.size === 0 || !this.sessionId) {
      return;
    }
    const queued = [...this.pendingConfig];
    this.pendingConfig.clear();
    for (const [optionId, value] of queued) {
      try {
        await this.backend.setConfigOption(this.sessionId, optionId, value, handlers);
        this.logger.info(`Applied queued ${optionId}`);
      } catch (err) {
        this.logger.warn(`Queued ${optionId} could not be applied: ${String(err)}`);
      }
    }
    this.flushSnapshot();
  }

  /** Copies the session state the kernel reported onto the live snapshot. */
  private applySessionState(handle: SessionHandle): void {
    if (handle.modes.length > 0) {
      this.modes = handle.modes;
      this.modeId = handle.modeId;
    }
    if (handle.configOptions.length > 0) {
      this.configOptions = handle.configOptions;
    }
  }

  /** Closes the kernel's active session, if it has one. Best-effort. */
  private async releaseActiveSession(): Promise<void> {
    const current = this.activeSessionId;
    if (!current) {
      return;
    }
    this.activeSessionId = undefined;
    try {
      const handlers = await this.ensureKernel();
      await this.backend.closeSession(current, handlers);
    } catch (err) {
      // Losing the close only costs the ability to resume that session again in
      // this kernel process; it must never fail the user's action.
      this.logger.warn(`Could not close session ${current}: ${String(err)}`);
    }
  }

  /** Called by the PanelController when the user picks an approval option. */
  async approve(approvalId: string, optionId: string): Promise<void> {
    await this.approvals.resolve(approvalId, optionId);
    this.scheduleSnapshot();
  }

  /**
   * Changes a session configuration option (the model picker, the reasoning
   * level). The kernel echoes the new state back as a `config_option_update`, so
   * the local list is only updated optimistically to keep the picker responsive.
   */
  async setConfigOption(optionId: string, value: string): Promise<void> {
    // Shown immediately so the picker responds; the kernel confirms it back.
    this.configOptions = this.configOptions.map((option) =>
      option.id === optionId ? { ...option, currentValue: value } : option,
    );
    if (!this.sessionId) {
      // No session to change yet (a fresh "new chat"). Remember the choice and
      // apply it as soon as one exists.
      this.pendingConfig.set(optionId, value);
      this.logger.info(`Queued ${optionId} until a session exists`);
      this.flushSnapshot();
      return;
    }
    try {
      const handlers = await this.ensureKernel();
      await this.backend.setConfigOption(this.sessionId, optionId, value, handlers);
      this.flushSnapshot();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`setConfigOption(${optionId}) failed: ${message}`);
      void vscode.window.showWarningMessage(l10n.t('无法切换设置：{0}', message));
    }
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    try {
      await this.backend.setMode(this.sessionId, modeId);
      this.modeId = modeId;
      this.flushSnapshot();
    } catch (err) {
      this.logger.warn(`setMode failed: ${String(err)}`);
    }
  }

  async authenticate(methodId: string): Promise<void> {
    try {
      await this.ensureKernel();
      await this.backend.authenticate(methodId);
      void vscode.window.showInformationMessage(l10n.t('DeepSeek Harness：认证完成。'));
      this.flushSnapshot();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(l10n.t('认证失败：{0}', message));
    }
  }

  getSnapshot() {
    const caps = this.backend.capabilities;
    return buildSnapshot({
      status: this.status,
      statusDetail: this.statusDetail,
      sessionId: this.sessionId,
      entries: this.reducer.entries,
      history: this.history,
      workingSet: this.workingSet.list(),
      kernelCommands: this.kernelCommands,
      modes: this.modes,
      modeId: this.modeId,
      configOptions: this.configOptions,
      usage: this.usage,
      balance: this.balance,
      authMethods: caps.authMethods,
      canLoadSession: caps.canLoadSession,
    });
  }

  dispose(): void {
    this.unwatchWorkingSet?.();
    if (this.snapshotTimer) {
      clearTimeout(this.snapshotTimer);
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      void this.persistTimeline().catch(() => undefined);
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
  }

  // -------------------------------------------------------------------------
  // Kernel handlers (the only place where ACP meets the domain model)
  // -------------------------------------------------------------------------

  private async ensureKernel(): Promise<KernelHandlers> {
    if (!this.handlers) {
      this.handlers = {
        onSessionUpdate: (_sessionId, update) => this.onSessionUpdate(_sessionId, update),
        onPermissionRequest: (req) => this.onPermissionRequest(req),
        onReadTextFile: async (req) => ({ content: await this.readWorkspaceFile(req.path) }),
        onWriteTextFile: async (req) => this.onKernelWrite(req.path, req.content),
        onExit: () => undefined, // Crash handling goes through backend.onCrash.
      };
    }
    await this.backend.ensureConnected(this.handlers);
    return this.handlers;
  }

  private onSessionUpdate(sessionId: string, update: AcpSessionUpdate): void {
    // Only intercept updates from one-shot ephemeral sessions themselves.
    const capture = this.captures.get(sessionId);
    if (capture) {
      if (update.sessionUpdate === 'agent_message_chunk') {
        capture.text += contentBlockText(update.content);
      }
      return;
    }
    this.observeMutations(update);
    const effects: TimelineEffect[] = this.reducer.apply(update);
    for (const effect of effects) {
      if (effect.type === 'editProposed') {
        // Never overwrite an edit the user already decided on: kernels may
        // re-emit diffs for the same toolCallId (corrections, retries).
        const existing = this.workingSet.get(effect.edit.editId);
        if (!existing || existing.state === 'pending') {
          this.workingSet.registerEdit(effect.edit);
        }
      }
    }
    if (update.sessionUpdate === 'available_commands_update') {
      this.kernelCommands = update.commands;
    } else if (update.sessionUpdate === 'current_mode_update') {
      this.modeId = update.currentModeId;
    } else if (update.sessionUpdate === 'config_options') {
      // Re-sent wholesale on every change, so it replaces rather than patches.
      this.configOptions = update.options;
    } else if (update.sessionUpdate === 'usage') {
      this.usage = update.usage;
    }
    this.scheduleSnapshot();
  }

  /**
   * Turns the kernel's mutation calls into reviewable edits.
   *
   * The kernel sends no `diff` tool-call content, so nothing else would ever
   * populate the changes list. Its `tool_call` event names the tool and carries
   * the model's arguments, so the file can be read before the tool runs and
   * again when it settles. See FileChangeTracker for the tool vocabulary.
   */
  private observeMutations(update: AcpSessionUpdate): void {
    if (update.sessionUpdate === 'tool_call') {
      if (update.status !== 'pending' && update.status !== 'in_progress') {
        return;
      }
      // Logged so a kernel that mutates files through a tool this build does not
      // recognise is diagnosable from the output channel, instead of silently
      // producing no diff at all.
      const tracked = this.fileChanges.begin(
        update.toolCallId,
        update.title,
        update.rawInput,
        this.workspaceRoot(),
      );
      this.logger.debug(
        tracked
          ? `Tracking mutation tool call "${update.title ?? ''}"`
          : `Tool call "${update.title ?? ''}" is not a recognised file mutation`,
      );
      return;
    }
    if (update.sessionUpdate !== 'tool_call_update') {
      return;
    }
    const { status } = update;
    if (status !== 'completed' && status !== 'failed') {
      return;
    }
    void this.fileChanges.settle(update.toolCallId, status === 'completed').then((edit) => {
      if (edit) {
        this.logger.info(`Derived edit from tool call ${update.toolCallId}: ${edit.path}`);
        this.registerDerivedEdit(update.toolCallId, edit);
      }
    });
  }

  /** Registers a derived change, respecting any decision already made. */
  private registerDerivedEdit(toolCallId: string, edit: DerivedEdit): void {
    const editId = `edit-${toolCallId}`;
    const existing = this.workingSet.get(editId);
    if (existing && existing.state !== 'pending') {
      return;
    }
    this.workingSet.registerEdit({
      editId,
      path: edit.path,
      oldText: edit.oldText,
      newText: edit.newText,
      // The kernel wrote the file itself, so the change is already on disk and
      // Reject means "revert to oldText".
      applied: true,
      origin: 'toolDiff',
      state: 'pending',
    });
    this.scheduleSnapshot();
    // A change derived from the last tool call can land just after the turn
    // ended, so the turn-end hook may already have run.
    if (this.status === 'idle') {
      this.maybeAutoOpenReview();
    }
  }

  /** Jumps into the review loop when a finished turn left pending edits. */
  private maybeAutoOpenReview(): void {
    if (!this.settings.autoOpenReview || this.reviewOpened) {
      return;
    }
    if (this.workingSet.pendingCount() === 0) {
      return;
    }
    this.reviewOpened = true;
    void this.diffService.openNextPending();
  }

  /** Generates a concise session title on an ephemeral session (R9). */
  private async autoTitle(sessionId: string, defaultTitle: string): Promise<void> {
    try {
      const generated = await this.oneShot(
        `用不超过12个字概括这个开发请求的主题，只输出标题本身，不要标点结尾：${defaultTitle}`,
      );
      const title = generated.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
      if (title && title.length <= 20) {
        await this.sessions.rename(sessionId, title);
        await this.reloadHistory();
      }
    } catch {
      // Title generation is best-effort; keep the default title.
    }
  }

  private async onPermissionRequest(req: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const toolTitle = req.toolCall.title ?? l10n.t('代理');
    const request: ApprovalRequest = {
      approvalId: `appr-${req.toolCall.toolCallId}`,
      toolCallId: req.toolCall.toolCallId,
      title: l10n.t('{0} 需要权限', toolTitle),
      options: req.options.map((option) => ({
        optionId: option.optionId,
        label: option.name,
        kind: option.kind,
      })),
      state: 'pending',
    };
    this.reducer.addApproval(request);
    this.status = 'awaitingApproval';
    this.flushSnapshot();

    const chosen = await this.approvals.awaitChoice(request);
    this.reducer.resolveApproval(request.approvalId, chosen ?? '');
    // Judge by the CURRENT status, not the snapshot from when the request
    // arrived: the turn may have been cancelled while we were waiting.
    if (this.status === 'awaitingApproval') {
      this.status = 'prompting';
    }
    this.scheduleSnapshot();

    if (!chosen) {
      return { outcome: 'cancelled' };
    }
    return { outcome: 'selected', optionId: chosen };
  }

  /**
   * The kernel asked us to persist a file. Apply it immediately (the actual
   * permission was granted through request_permission) and register the edit
   * in the working set so the user can review or revert it.
   */
  private async onKernelWrite(absolutePath: string, content: string): Promise<void> {
    const previous = await this.diffService.readCurrent(absolutePath);
    await this.diffService.writeFile(absolutePath, content);
    const edit: EditInfo = this.diffService.buildFsWriteEdit(
      `edit-fs-${Math.random().toString(36).slice(2)}`,
      absolutePath,
      content,
      previous,
    );
    this.workingSet.registerEdit(edit);
    this.reducer.registerEdit(edit);
    this.scheduleSnapshot();
  }

  private async readWorkspaceFile(absolutePath: string): Promise<string> {
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(absolutePath));
    return new TextDecoder().decode(data);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /**
   * Copilot-style behavior: silently attach the active editor selection
   * unless the user already attached context. Opt out via settings.
   */
  private mergeActiveSelection(attachments: ContextAttachment[]): ContextAttachment[] {
    if (!this.settings.attachActiveSelection) {
      return attachments;
    }
    if (attachments.some((a) => a.kind === 'selection')) {
      return attachments;
    }
    const active = this.contexts.fromActiveEditor(true);
    if (!active || !active.selectionText) {
      return attachments;
    }
    return [...attachments, active];
  }

  private setStatus(status: SessionStatus, detail?: string): void {
    this.status = status;
    this.statusDetail = detail;
    this.flushSnapshot();
    // A finished turn is the cheapest safe point to write the timeline out;
    // while one is streaming the deferred write is what keeps disk I/O off the
    // hot path.
    if (status === 'idle' || status === 'error') {
      this.persistNow();
      // A finished turn is what changes the balance.
      void this.refreshBalance();
    }
  }

  private flushSnapshot(): void {
    const payload: ToWebview = { type: 'snapshot', payload: this.getSnapshot() };
    this.lastSnapshotEntries = this.reducer.entries.length;
    this.postToPanel(payload);
    // Persisting is deliberately NOT part of this path: it serializes the whole
    // timeline into workspaceState, so doing it per flush wrote the entire
    // conversation to disk many times a second while streaming.
    this.schedulePersist();
  }

  /** Writes the timeline to workspaceState at most once per persist window. */
  private schedulePersist(): void {
    if (!this.timelines || this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, PERSIST_COALESCE_MS);
  }

  /** Persists immediately, cancelling any pending deferred write. */
  private persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    void this.persistTimeline().catch((err) => {
      this.logger.warn(`Timeline persist failed: ${String(err)}`);
    });
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) {
      return;
    }
    // A change in the entry count means something appeared or vanished (a new
    // message, a tool card, a plan), which the user should see at once.
    // Otherwise this is content growing inside an existing entry, and that text
    // already streams through `chunk` deltas - so the full snapshot, which both
    // sides clone in its entirety, can wait.
    const structural = this.reducer.entries.length !== this.lastSnapshotEntries;
    const window = structural
      ? 0
      : this.status === 'prompting'
        ? SNAPSHOT_COALESCE_STREAMING_MS
        : SNAPSHOT_COALESCE_MS;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.flushSnapshot();
    }, window);
  }

  private postToPanel(message: ToWebview): void {
    this.panelSink?.(message);
  }

  private buildPromptBlocks(text: string, attachments: ContextAttachment[]): PromptContentBlock[] {
    const blocks: PromptContentBlock[] = [];
    for (const attachment of attachments) {
      blocks.push({
        type: 'resource_link',
        uri: attachment.absolutePath ?? attachment.path,
        name: attachment.label,
      });
    }
    const parts: string[] = [];
    for (const attachment of attachments) {
      if (attachment.selectionText) {
        const lines = attachment.range
          ? ` (lines ${attachment.range.startLine}-${attachment.range.endLine})`
          : '';
        const lang = path.extname(attachment.path).replace('.', '') || '';
        parts.push(
          `Attached context: ${attachment.path}${lines}\n\`\`\`${lang}\n${attachment.selectionText}\n\`\`\``,
        );
      } else {
        parts.push(`Attached context: ${attachment.path}`);
      }
    }
    parts.push(text);
    blocks.push({ type: 'text', text: parts.join('\n\n') });
    return blocks;
  }

  private workspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      throw new Error(l10n.t('请先打开一个文件夹再与代理对话'));
    }
    if (folders.length === 1) {
      return folders[0]!.uri.fsPath;
    }
    // Multi-root: prefer the folder containing the active editor, else the first.
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri) {
      const containing = vscode.workspace.getWorkspaceFolder(activeUri);
      if (containing) {
        return containing.uri.fsPath;
      }
    }
    return folders[0]!.uri.fsPath;
  }
}

/**
 * The kernel rejects resuming a session it already holds open. That is the
 * desired end state rather than a failure, so callers adopt the session instead
 * of reporting an error.
 */
function isAlreadyActive(message: string): boolean {
  return /already active/i.test(message);
}

/** A readable fallback title for a conversation: its first user message. */
function titleFromEntries(entries: readonly TimelineEntry[]): string {
  for (const entry of entries) {
    if (entry.kind === 'user' && entry.text.trim()) {
      return entry.text.trim().slice(0, 60);
    }
  }
  return l10n.t('新对话');
}
