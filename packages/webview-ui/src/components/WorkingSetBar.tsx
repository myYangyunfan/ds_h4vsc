import type { EditInfo } from '@dsh-vscode/core';
import type { FromWebview } from '@dsh-vscode/core';
import { useT } from '../strings.js';
import { useToast } from './Toast.js';

interface WorkingSetBarProps {
  workingSet: EditInfo[];
  send: (message: FromWebview) => void;
}

export function WorkingSetBar({ workingSet, send }: WorkingSetBarProps) {
  const t = useT();
  const { toast } = useToast();
  const onAccept = (editId: string): void => {
    send({ type: 'acceptEdit', editId });
    toast('toastAccepted', 'success');
  };
  const onReject = (editId: string): void => {
    send({ type: 'rejectEdit', editId });
    toast('toastRejected', 'info');
  };

  if (workingSet.length === 0) {
    return null;
  }
  const pending = workingSet.filter((edit) => edit.state === 'pending').length;

  return (
    <div className="working-set" role="region" aria-label={t('changedFiles', { n: workingSet.length })}>
      <div className="working-set-header">
        <i className="codicon codicon-diff-multiple" />
        <span>{t('changedFiles', { n: workingSet.length })}</span>
        <div className="working-set-header-actions">
          {pending > 0 && (
            <button
              className="link-button"
              title={t('reviewNext')}
              onClick={() => send({ type: 'reviewNext' })}
            >
              <i className="codicon codicon-eye" /> {t('reviewNext')}
            </button>
          )}
          <button className="link-button" onClick={() => send({ type: 'acceptAllEdits' })}>
            {t('keepAll')}
          </button>
          <button className="link-button danger" onClick={() => send({ type: 'rejectAllEdits' })}>
            {t('rejectAll')}
          </button>
        </div>
      </div>
      <ul className="working-set-files">
        {workingSet.map((edit) => (
          <li key={edit.editId} className={`working-set-file state-${edit.state}`}>
            <button
              className="working-set-file-name"
              title={edit.path}
              onClick={() => send({ type: 'openDiff', editId: edit.editId })}
            >
              <i className="codicon codicon-file" />
              <span className="file-basename">{baseName(edit.path)}</span>
              <span className="file-dirname">{dirName(edit.path)}</span>
            </button>
            <span className={`edit-state state-${edit.state}`}>{stateLabel(edit, t)}</span>
            {edit.state === 'pending' && (
              <span className="working-set-file-actions">
                <button
                  className="icon-button"
                  title={t('accept')}
                  onClick={() => onAccept(edit.editId)}
                >
                  <i className="codicon codicon-check" />
                </button>
                <button
                  className="icon-button"
                  title={t('reject')}
                  onClick={() => onReject(edit.editId)}
                >
                  <i className="codicon codicon-close" />
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {pending > 0 && (
        <div className="working-set-note">{t('pendingNote', { n: pending })}</div>
      )}
    </div>
  );
}

function stateLabel(edit: EditInfo, t: ReturnType<typeof useT>): string {
  switch (edit.state) {
    case 'accepted':
      return t('stateKept');
    case 'rejected':
      return edit.applied ? t('stateReverted') : t('stateRejected');
    default:
      return edit.applied ? t('stateApplied') : t('stateProposed');
  }
}

function baseName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function dirName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : '';
}
