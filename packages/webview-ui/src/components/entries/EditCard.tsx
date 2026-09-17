import { useMemo, useState, memo } from 'react';
import type { EditInfo } from '@dsh-vscode/core';
import { lineDiff } from '@dsh-vscode/core';
import type { FromWebview } from '@dsh-vscode/core';
import { useT } from '../../strings.js';

interface EditCardProps {
  edit: EditInfo;
  send: (message: FromWebview) => void;
}

export const EditCard = memo(function EditCard({ edit, send }: EditCardProps) {
  const t = useT();
  const [preview, setPreview] = useState(false);
  const stats = diffStats(edit);
  const diff = useMemo(
    () => (preview ? lineDiff(edit.oldText, edit.newText, 120) : undefined),
    [preview, edit.oldText, edit.newText],
  );

  return (
    <div className={`entry edit-card state-${edit.state}`}>
      <button
        className="edit-card-path"
        title={t('openDiffTitle', { path: edit.path })}
        onClick={() => send({ type: 'openDiff', editId: edit.editId })}
      >
        <i className="codicon codicon-diff-single" />
        <span className="file-basename">{base(edit.path)}</span>
        <span className="file-dirname">{dir(edit.path)}</span>
        <span className="diff-stats">
          <span className="diff-add">+{stats.added}</span>
          <span className="diff-del">-{stats.removed}</span>
        </span>
      </button>
      <div className="edit-card-actions">
        <button
          className="icon-button"
          title={t('previewChanges')}
          onClick={() => setPreview((value) => !value)}
        >
          <i className={`codicon codicon-chevron-${preview ? 'down' : 'right'}`} />
        </button>
        {edit.state !== 'accepted' && (
          <button className="link-button" onClick={() => send({ type: 'acceptEdit', editId: edit.editId })}>
            <i className="codicon codicon-check" /> {t('accept')}
          </button>
        )}
        {edit.state !== 'rejected' && (
          <button className="link-button" onClick={() => send({ type: 'rejectEdit', editId: edit.editId })}>
            <i className="codicon codicon-close" /> {t('reject')}
          </button>
        )}
      </div>
      {preview && diff && (
        <div className="edit-preview">
          <pre className="edit-preview-unified">
            {diff.lines.map((line, index) => (
              <span key={index} className={`diff-line diff-line-${line.side}`}>
                {line.side === 'add' ? '+ ' : line.side === 'del' ? '- ' : '  '}
                {line.text}
              </span>
            ))}
            {diff.truncated && <span className="diff-line diff-line-ctx">…</span>}
          </pre>
        </div>
      )}
    </div>
  );
});

function diffStats(edit: EditInfo): { added: number; removed: number } {
  if (edit.oldText === undefined) {
    return { added: edit.newText.split('\n').length, removed: 0 };
  }
  // Frequency-multiset comparison: plain Sets undercount duplicate lines
  // (braces, blank lines) that appear in both old and new text.
  const freq = (lines: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of lines) {
      map.set(line, (map.get(line) ?? 0) + 1);
    }
    return map;
  };
  const oldFreq = freq(edit.oldText.split('\n'));
  const newFreq = freq(edit.newText.split('\n'));
  let added = 0;
  let removed = 0;
  for (const [line, count] of newFreq) {
    added += Math.max(0, count - (oldFreq.get(line) ?? 0));
  }
  for (const [line, count] of oldFreq) {
    removed += Math.max(0, count - (newFreq.get(line) ?? 0));
  }
  return { added, removed };
}

function base(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function dir(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx > 0 ? p.slice(0, idx) : '';
}
