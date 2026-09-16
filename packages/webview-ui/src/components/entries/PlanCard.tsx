import type { PlanEntry } from '@dsh-vscode/core';
import { useT } from '../../strings.js';

const STATUS_ICONS: Record<PlanEntry['status'], string> = {
  pending: 'codicon-circle-large-outline',
  in_progress: 'codicon-loading codicon-modifier-spin',
  completed: 'codicon-pass-filled',
};

const PRIORITY_LABEL: Record<PlanEntry['priority'], string> = {
  high: 'P1',
  medium: 'P2',
  low: 'P3',
};

export function PlanCard({ entries }: { entries: PlanEntry[] }) {
  const t = useT();
  if (entries.length === 0) {
    return null;
  }
  return (
    <div className="entry plan-card">
      <div className="plan-card-header">
        <i className="codicon codicon-checklist" />
        <span>{t('plan')}</span>
      </div>
      <ul className="plan-list">
        {entries.map((entry, index) => (
          <li key={index} className={`plan-item status-${entry.status}`}>
            <i className={`codicon ${STATUS_ICONS[entry.status]}`} aria-hidden />
            <span className="plan-content">{entry.content}</span>
            <span className="plan-priority">{PRIORITY_LABEL[entry.priority]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
