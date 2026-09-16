import { memo } from 'react';
import type { TimelineEntry } from '@dsh-vscode/core';
import type { FromWebview } from '@dsh-vscode/core';
import { useT } from '../../strings.js';

type UserEntryModel = Extract<TimelineEntry, { kind: 'user' }>;

interface UserEntryProps {
  entry: UserEntryModel;
  send: (message: FromWebview) => void;
  /** Host round-trip: put the text back into the composer for editing. */
  onEdit: (text: string) => void;
}

/**
 * Memoized: the message list re-renders on every streaming chunk, so each
 * entry must bail out unless its own object identity changed. The timeline
 * reducer mutates entries in place, but only the streaming assistant entry
 * gets a new object from the chunk reducer in useChat.
 */
export const UserEntry = memo(function UserEntry({ entry, send, onEdit }: UserEntryProps) {
  const t = useT();
  const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="entry entry-user" title={time}>
      <div className="entry-user-avatar" aria-hidden>
        <i className="codicon codicon-account" />
      </div>
      <div className="entry-user-body">
        {entry.attachments.length > 0 && (
          <div className="entry-attachments">
            {entry.attachments.map((attachment) => (
              <span key={attachment.chipId} className="chip">
                <i
                  className={`codicon codicon-${
                    attachment.kind === 'selection'
                      ? 'symbol-parameter'
                      : attachment.kind === 'diagnostics'
                        ? 'error'
                        : 'file'
                  }`}
                />
                {attachment.label}
              </span>
            ))}
          </div>
        )}
        <div className="entry-user-text">{entry.text}</div>
      </div>
      <div className="entry-tools">
        <button className="icon-button" title={t('editResend')} onClick={() => onEdit(entry.text)}>
          <i className="codicon codicon-edit" />
        </button>
        <button
          className="icon-button"
          title={t('resend')}
          onClick={() =>
            send({ type: 'resend', text: entry.text, attachments: entry.attachments })
          }
        >
          <i className="codicon codicon-redo" />
        </button>
      </div>
    </div>
  );
});
