import { useState } from 'react';
import type { ToolCallInfo } from '@dsh-vscode/core';
import { useT } from '../../strings.js';

const KIND_ICONS: Record<string, string> = {
  read: 'codicon-file',
  edit: 'codicon-edit',
  delete: 'codicon-trash',
  move: 'codicon-arrow-right',
  search: 'codicon-search',
  execute: 'codicon-terminal',
  think: 'codicon-lightbulb',
  fetch: 'codicon-globe',
  other: 'codicon-tools',
};

const KIND_LABEL_KEYS: Record<string, 'toolRead' | 'toolEdit' | 'toolDelete' | 'toolMove' | 'toolSearch' | 'toolExecute' | 'toolThink' | 'toolFetch' | 'toolOther'> = {
  read: 'toolRead',
  edit: 'toolEdit',
  delete: 'toolDelete',
  move: 'toolMove',
  search: 'toolSearch',
  execute: 'toolExecute',
  think: 'toolThink',
  fetch: 'toolFetch',
  other: 'toolOther',
};

const STATUS_ICONS: Record<string, string> = {
  pending: 'codicon-circle-large-outline',
  in_progress: 'codicon-loading codicon-modifier-spin',
  completed: 'codicon-check',
  failed: 'codicon-error',
};

export function ToolCallCard({ toolCall }: { toolCall: ToolCallInfo }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(toolCall.detailText) || Boolean(toolCall.diff);
  const duration = toolCall.endedAt
    ? Math.max(0.1, Math.round((toolCall.endedAt - toolCall.startedAt) / 100) / 10)
    : undefined;

  return (
    <div className={`entry tool-call status-${toolCall.status}`}>
      <button className="tool-call-row" onClick={() => hasDetail && setOpen((v) => !v)}>
        <i className={`codicon ${KIND_ICONS[toolCall.kind] ?? KIND_ICONS.other}`} aria-hidden />
        <span className="tool-call-kind">{t(KIND_LABEL_KEYS[toolCall.kind] ?? 'toolOther')}</span>
        <span className="tool-call-title">{toolCall.title}</span>
        {toolCall.diff && <span className="tool-call-file">{base(toolCall.diff.path)}</span>}
        {duration !== undefined && <span className="tool-call-duration">{duration}s</span>}
        <i className={`codicon tool-call-status ${STATUS_ICONS[toolCall.status] ?? ''}`} aria-hidden />
        {hasDetail && <i className={`codicon codicon-chevron-${open ? 'down' : 'right'}`} aria-hidden />}
      </button>
      {open && hasDetail && (
        <div className="tool-call-detail">
          {toolCall.diff && (
            <div className="tool-call-diff">
              <code className="diff-path">{toolCall.diff.path}</code>
              <pre className="diff-new">{toolCall.diff.newText}</pre>
            </div>
          )}
          {toolCall.detailText && <pre className="tool-call-output">{toolCall.detailText}</pre>}
        </div>
      )}
    </div>
  );
}

function base(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}
