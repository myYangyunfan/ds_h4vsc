import { useEffect, useRef, useState } from 'react';
import type { QuickActionId, SessionStatus, TimelineEntry } from '@dsh-vscode/core';
import type { FromWebview } from '@dsh-vscode/core';
import { useT, type T } from '../strings.js';
import { UserEntry } from './entries/UserEntry.js';
import { AssistantEntry } from './entries/AssistantEntry.js';
import { ToolCallCard } from './entries/ToolCallCard.js';
import { PlanCard } from './entries/PlanCard.js';
import { EditCard } from './entries/EditCard.js';
import { ApprovalCard } from './entries/ApprovalCard.js';
import { ErrorEntry } from './entries/ErrorEntry.js';

interface MessageListProps {
  entries: TimelineEntry[];
  status: SessionStatus;
  send: (message: FromWebview) => void;
  onEdit: (text: string) => void;
}

function statusHint(status: SessionStatus, t: T): string | undefined {
  switch (status) {
    case 'connecting':
      return t('connecting');
    case 'prompting':
      return t('working');
    case 'awaitingApproval':
      return t('waitingApproval');
    default:
      return undefined;
  }
}

const QUICK_ACTIONS: Array<{ id: QuickActionId; icon: string; labelKey: 'qaExplain' | 'qaTests' | 'qaRefactor' | 'qaInit' }> = [
  { id: 'explainSelection', icon: 'codicon-book', labelKey: 'qaExplain' },
  { id: 'writeTests', icon: 'codicon-beaker', labelKey: 'qaTests' },
  { id: 'refactor', icon: 'codicon-wand', labelKey: 'qaRefactor' },
  { id: 'init', icon: 'codicon-terminal', labelKey: 'qaInit' },
];

export function MessageList({ entries, status, send, onEdit }: MessageListProps) {
  const t = useT();
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [query, setQuery] = useState('');
  const lastAssistantId = findLastAssistantId(entries);
  const showSearch = entries.length > 8;
  const filtered = query.trim()
    ? entries.filter((entry) => entryText(entry).toLowerCase().includes(query.trim().toLowerCase()))
    : entries;

  useEffect(() => {
    const el = scroller.current;
    if (!el || !nearBottom.current) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  const hint = statusHint(status, t);

  if (entries.length === 0) {
    return (
      <div className="message-list empty-state">
        <div className="empty-icon codicon codicon-sparkle" />
        <h2>DeepSeek Harness</h2>
        <p>{t('emptyIntro')}</p>
        <div className="quick-actions">
          <div className="quick-actions-title">{t('quickStart')}</div>
          <div className="quick-actions-grid">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.id}
                className="quick-action"
                onClick={() => send({ type: 'quickAction', action: action.id })}
              >
                <i className={`codicon ${action.icon}`} />
                <span>{t(action.labelKey)}</span>
              </button>
            ))}
          </div>
          <div className="quick-actions-hint">{t('qaHint')}</div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="message-list"
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        nearBottom.current = atBottom;
        setShowJump(!atBottom);
      }}
    >
      {showSearch && (
        <div className="chat-search">
          <i className="codicon codicon-search" />
          <input
            className="chat-search-input"
            value={query}
            placeholder={t('searchMessages')}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button className="icon-button" title={t('searchClear')} onClick={() => setQuery('')}>
              <i className="codicon codicon-close" />
            </button>
          )}
        </div>
      )}
      {filtered.map((entry, index) => {
        const prev = index > 0 ? filtered[index - 1] : undefined;
        const separator = dateSeparatorLabel(
          entryTimestamp(entry),
          prev ? entryTimestamp(prev) : undefined,
          t,
        );
        let node: React.ReactNode;
        switch (entry.kind) {
          case 'user':
            node = <UserEntry entry={entry} send={send} onEdit={onEdit} />;
            break;
          case 'assistant':
            node = (
              <AssistantEntry
                entry={entry}
                streaming={status === 'prompting' && entry.entryId === lastAssistantId}
              />
            );
            break;
          case 'toolCall':
            node = <ToolCallCard toolCall={entry.toolCall} />;
            break;
          case 'plan':
            node = <PlanCard entries={entry.entries} />;
            break;
          case 'edit':
            node = <EditCard edit={entry.edit} send={send} />;
            break;
          case 'approval':
            node = <ApprovalCard approval={entry.approval} send={send} />;
            break;
          case 'error':
            node = <ErrorEntry text={entry.text} />;
            break;
          default:
            node = null;
        }
        return (
          <div key={entry.entryId} className="entry-group">
            {separator && <div className="date-separator" role="separator">{separator}</div>}
            {node}
          </div>
        );
      })}
      {hint && (
        <div className="status-hint">
          <i className="codicon codicon-loading codicon-modifier-spin" />
          <span>{hint}</span>
        </div>
      )}
      {status === 'idle' && !query && entries.some((entry) => entry.kind === 'assistant') && (
        <Followups send={send} hasPending={hasPendingEdits(entries)} />
      )}
      {showJump && (
        <button
          className="jump-to-bottom"
          title={t('backToBottom')}
          onClick={() => {
            const el = scroller.current;
            if (el) {
              el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            }
          }}
        >
          <i className="codicon codicon-chevron-down" />
        </button>
      )}
    </div>
  );
}

function findLastAssistantId(entries: TimelineEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.kind === 'assistant') {
      return entry.entryId;
    }
  }
  return undefined;
}

/** Searchable text of an entry for the in-chat filter. */
function entryText(entry: TimelineEntry): string {
  switch (entry.kind) {
    case 'user':
    case 'assistant':
    case 'error':
      return entry.text;
    case 'toolCall':
      return entry.toolCall.title;
    case 'edit':
      return entry.edit.path;
    case 'plan':
      return entry.entries.map((item) => item.content).join(' ');
    default:
      return '';
  }
}

function hasPendingEdits(entries: TimelineEntry[]): boolean {
  return entries.some((entry) => entry.kind === 'edit' && entry.edit.state === 'pending');
}

/** Returns a date label for the separator, or undefined if same day as previous. */
function dateSeparatorLabel(timestamp: number | undefined, prevTimestamp: number | undefined, t: T): string | undefined {
  if (timestamp === undefined) {
    return undefined;
  }
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (prevTimestamp !== undefined && sameDay(new Date(prevTimestamp), date)) {
    return undefined;
  }
  if (sameDay(today, date)) {
    return t('today');
  }
  if (sameDay(yesterday, date)) {
    return t('yesterday');
  }
  return date.toLocaleDateString();
}

function entryTimestamp(entry: TimelineEntry): number | undefined {
  if (entry.kind === 'user' || entry.kind === 'assistant') {
    return entry.timestamp;
  }
  return undefined;
}

/** Heuristic follow-up suggestions shown after a finished turn (R3). */
function Followups({ send, hasPending }: { send: (message: FromWebview) => void; hasPending: boolean }) {
  const t = useT();
  const suggestions: string[] = hasPending
    ? [t('fuExplainChanges'), t('fuAddTests'), t('fuRisks')]
    : [t('fuContinue'), t('fuSummary'), t('fuAnother')];
  return (
    <div className="followups">
      <span className="followups-title">{t('followups')}</span>
      {suggestions.map((text) => (
        <button key={text} className="followup-chip" onClick={() => send({ type: 'submitPrompt', text, attachments: [] })}>
          {text}
        </button>
      ))}
    </div>
  );
}
