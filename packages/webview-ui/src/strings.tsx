/**
 * Webview string table. Chinese is the primary language (matches the
 * extension's zh-source l10n); English is provided as the switchable
 * alternative. The active language follows the VS Code display language
 * delivered through the init payload (falls back to Chinese).
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

export type Lang = 'zh' | 'en';

const zh = {
  history: '历史会话…',
  newChat: '新对话',
  settings: '设置',
  agentMode: '代理模式',
  model: '模型',
  reasoningEffort: '推理档位',
  contextUsage: '上下文占用',
  contextUsageDetail: '已用 {used} / {size} tokens',
  balanceDetail: '余额 {total}（赠送 {granted}，充值 {toppedUp}）',
  signInRequired: '需要登录',
  signIn: '登录',
  emptyIntro:
    '在这个工作区里随便问点什么。代理可以读写文件、执行命令并维护计划——每一处变更都会用原生 diff 供你审查。',
  tipFilesPre: '输入 ',
  tipFilesPost: ' 附加文件',
  tipCommandsPre: '输入 ',
  tipCommandsPost: ' 使用 /init 等命令',
  connecting: '正在连接 dsh 内核…',
  working: '正在工作…',
  waitingApproval: '等待你的批准',
  plan: '计划',
  accept: '接受',
  reject: '拒绝',
  openDiffTitle: '打开 {path} 的 diff',
  changedFiles: '已变更文件（{n}）',
  keepAll: '全部保留',
  stateKept: '已保留',
  stateReverted: '已还原',
  stateRejected: '已拒绝',
  stateApplied: '已生效',
  stateProposed: '待审查',
  pendingNote: '{n} 项变更待处理 — 打开 diff 进行审查。',
  cancelled: '已取消',
  cancel: '取消',
  composerPlaceholder: '让 DeepSeek Harness 在这个工作区里干活…（@ 附加文件，/ 命令）',
  attachFile: '附加文件（@）',
  stop: '停止',
  send: '发送（Enter）',
  footerHint: 'Enter 发送 · Shift+Enter 换行',
  thinking: '思考中',
  quickStart: '快速开始',
  qaExplain: '解释选中代码',
  qaTests: '编写单元测试',
  qaRefactor: '重构这段代码',
  qaInit: '初始化项目上下文 (/init)',
  qaHint: '选中代码后点击即可发送（也可直接输入提问）',
  backToBottom: '回到底部',
  connectionLost: '连接已断开或出错',
  retryConnection: '重试连接',
  reviewNext: '逐个审查',
  copy: '复制',
  copied: '已复制',
  moreActions: '更多操作',
  exportChat: '导出对话',
  renameSession: '重命名会话',
  deleteSession: '删除会话',
  attachDiagnostics: '附加问题诊断',
  gitCommit: '生成提交信息',
  dropFiles: '松开以附加文件',
  previewChanges: '预览变更',
  resend: '重新发送',
  editResend: '编辑后重发',
  searchMessages: '搜索对话…',
  searchClear: '清除搜索',
  rejectAll: '拒绝全部',
  followups: '接着可以问：',
  fuExplainChanges: '解释这些变更',
  fuAddTests: '为变更补充测试',
  fuRisks: '这些改动有什么风险？',
  fuContinue: '继续',
  fuSummary: '总结本次对话',
  fuAnother: '换个思路再试一次',
  relNow: '刚刚',
  relMin: '{n} 分钟前',
  relHour: '{n} 小时前',
  relDay: '{n} 天前',
  toolRead: '读取',
  toolEdit: '编辑',
  toolDelete: '删除',
  toolMove: '移动',
  toolSearch: '搜索',
  toolExecute: '执行',
  toolThink: '思考',
  toolFetch: '抓取',
  toolOther: '工具',
  needApiKey: '尚未设置 API Key',
  setApiKey: '去设置',
  toastCopied: '已复制到剪贴板',
  toastAccepted: '已接受变更',
  toastRejected: '已拒绝变更',
  today: '今天',
  yesterday: '昨天',
  chatLabel: 'DeepSeek Harness 对话面板',
  messagesLabel: '消息列表',
  composerLabel: '消息输入框',
  pressTabToComplete: '按 Tab 补全',
} as const;

type Strings = Record<keyof typeof zh, string>;

const en: Strings = {
  history: 'History…',
  newChat: 'New chat',
  settings: 'Settings',
  agentMode: 'Agent mode',
  model: 'Model',
  reasoningEffort: 'Reasoning effort',
  contextUsage: 'Context usage',
  contextUsageDetail: '{used} of {size} tokens used',
  balanceDetail: 'Balance {total} (granted {granted}, topped up {toppedUp})',
  signInRequired: 'Sign in required',
  signIn: 'Sign in',
  emptyIntro:
    'Ask anything about this workspace. The agent can read and edit files, run commands, and keep a plan - every change is yours to review with native diffs.',
  tipFilesPre: 'Type ',
  tipFilesPost: ' to attach files',
  tipCommandsPre: 'Type ',
  tipCommandsPost: ' for commands like /init',
  connecting: 'Connecting to the dsh kernel…',
  working: 'Working…',
  waitingApproval: 'Waiting for your approval',
  plan: 'Plan',
  accept: 'Accept',
  reject: 'Reject',
  openDiffTitle: 'Open diff for {path}',
  changedFiles: 'Changed files ({n})',
  keepAll: 'Keep all',
  stateKept: 'kept',
  stateReverted: 'reverted',
  stateRejected: 'rejected',
  stateApplied: 'applied',
  stateProposed: 'proposed',
  pendingNote: '{n} pending change(s) - open the diff to review.',
  cancelled: 'cancelled',
  cancel: 'Cancel',
  composerPlaceholder: 'Ask DeepSeek Harness to work on this workspace…  (@ for files, / for commands)',
  attachFile: 'Attach file (@)',
  stop: 'Stop',
  send: 'Send (Enter)',
  footerHint: 'Enter to send · Shift+Enter for newline',
  thinking: 'Thinking',
  quickStart: 'Quick start',
  qaExplain: 'Explain selection',
  qaTests: 'Write unit tests',
  qaRefactor: 'Refactor selection',
  qaInit: 'Initialize project context (/init)',
  qaHint: 'Select code, then click to send (or just type a question)',
  backToBottom: 'Back to bottom',
  connectionLost: 'Connection lost or error',
  retryConnection: 'Retry connection',
  reviewNext: 'Review one by one',
  copy: 'Copy',
  copied: 'Copied',
  moreActions: 'More actions',
  exportChat: 'Export chat',
  renameSession: 'Rename session',
  deleteSession: 'Delete session',
  attachDiagnostics: 'Attach diagnostics',
  gitCommit: 'Generate commit message',
  dropFiles: 'Drop to attach files',
  previewChanges: 'Preview changes',
  resend: 'Resend',
  editResend: 'Edit and resend',
  searchMessages: 'Search chat…',
  searchClear: 'Clear search',
  rejectAll: 'Reject all',
  followups: 'Try asking:',
  fuExplainChanges: 'Explain these changes',
  fuAddTests: 'Add tests for the changes',
  fuRisks: 'Any risks in these edits?',
  fuContinue: 'Continue',
  fuSummary: 'Summarize this chat',
  fuAnother: 'Try a different approach',
  relNow: 'just now',
  relMin: '{n} min ago',
  relHour: '{n} h ago',
  relDay: '{n} d ago',
  toolRead: 'read',
  toolEdit: 'edit',
  toolDelete: 'delete',
  toolMove: 'move',
  toolSearch: 'search',
  toolExecute: 'execute',
  toolThink: 'think',
  toolFetch: 'fetch',
  toolOther: 'tool',
  needApiKey: 'No API key set yet',
  setApiKey: 'Set it up',
  toastCopied: 'Copied to clipboard',
  toastAccepted: 'Change accepted',
  toastRejected: 'Change rejected',
  today: 'Today',
  yesterday: 'Yesterday',
  chatLabel: 'DeepSeek Harness chat panel',
  messagesLabel: 'Message list',
  composerLabel: 'Message input',
  pressTabToComplete: 'Press Tab to complete',
};

export type StringKey = keyof typeof zh;

export type T = (key: StringKey, vars?: Record<string, string | number>) => string;

/** Kernel slash-command descriptions, localized; falls back to the kernel text. */
const commandDescriptions: Record<Lang, Record<string, string>> = {
  zh: {
    '/init': '扫描项目并生成 AGENTS.md 上下文',
    '/compact': '压缩会话上下文以释放 token',
    '/login': '登录或配置提供商凭据',
    '/help': '显示内核帮助',
  },
  en: {
    '/init': 'Scan the project and generate AGENTS.md context',
    '/compact': 'Compact the conversation context to free tokens',
    '/login': 'Sign in or configure provider credentials',
    '/help': 'Show harness help',
  },
};

function makeT(lang: Lang): T {
  const dict: Strings = lang === 'en' ? en : zh;
  return (key, vars) => {
    let text: string = dict[key] ?? zh[key];
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}

/** Maps a VS Code display locale to the panel language; Chinese is primary. */
export function langFromLocale(locale: string | undefined): Lang {
  return locale && /^en/i.test(locale) ? 'en' : 'zh';
}

const LangContext = createContext<Lang>('zh');
const StringsContext = createContext<T>(makeT('zh'));

export function StringsProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const t = useMemo(() => makeT(lang), [lang]);
  return (
    <LangContext.Provider value={lang}>
      <StringsContext.Provider value={t}>{children}</StringsContext.Provider>
    </LangContext.Provider>
  );
}

export function useT(): T {
  return useContext(StringsContext);
}

export function useLang(): Lang {
  return useContext(LangContext);
}

/** Resolves a localized description for a kernel slash command. */
export function useCommandDescription(): (name: string, fallback: string) => string {
  const lang = useLang();
  return useMemo(() => {
    const table = commandDescriptions[lang];
    return (name, fallback) => table[name] ?? fallback;
  }, [lang]);
}
