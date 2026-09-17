import { useEffect, useMemo, useRef, useState } from 'react';
import type { ContextAttachment, FromWebview, SessionConfigOption, SessionStatus, SlashCommandInfo } from '@dsh-vscode/core';
import { SessionControls } from './SessionControls.js';
import { useCommandDescription, useT } from '../strings.js';
import { postToHost } from '../vscode.js';

interface ComposerProps {
  status: SessionStatus;
  statusDetail?: string;
  chips: ContextAttachment[];
  commands: SlashCommandInfo[];
  busy: boolean;
  /** Draft is owned by App so "edit and resend" can pre-fill it. */
  draft: string;
  onDraftChange(text: string): void;
  onSubmit(text: string): void;
  onCancel(): void;
  onRemoveChip(chipId: string): void;
  onPickFile(): void;  configOptions: SessionConfigOption[];
  usage?: { used: number; size: number };
  modes?: Array<{ id: string; name: string }>;
  modeId?: string;
}

export function Composer({
  status,
  statusDetail,
  chips,
  commands,
  busy,
  draft: text,
  onDraftChange: setText,
  onSubmit,
  onCancel,
  onRemoveChip,
  onPickFile,
  configOptions,
  usage,
  modes,
  modeId,
}: ComposerProps) {
  const t = useT();
  const describeCommand = useCommandDescription();
  const [dragOver, setDragOver] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);

  const showCommandMenu = text.startsWith('/') && !text.includes(' ');
  const filteredCommands = useMemo(
    () => (showCommandMenu ? commands.filter((c) => c.name.startsWith(text)) : []),
    [showCommandMenu, commands, text],
  );

  useEffect(() => {
    const el = textarea.current;
    if (!el) {
      return;
    }
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const submit = (): void => {
    if (busy) {
      return;
    }
    const value = text.trim();
    if (!value && chips.length === 0) {
      return;
    }
    onSubmit(value);
    setText('');
  };

  return (
    <div
      className={`composer${dragOver ? ' dragover' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        // VS Code drops carry text/uri-list (one file URI per line).
        const uriList = event.dataTransfer.getData('text/uri-list');
        const uris = uriList
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#'));
        if (uris.length > 0) {
          postToHost({ type: 'addContextByUris', uris });
        }
      }}
    >
      {dragOver && <div className="composer-drop-hint">{t('dropFiles')}</div>}
      {chips.length > 0 && (
        <div className="composer-chips">
          {chips.map((chip) => (
            <span key={chip.chipId} className="chip chip-removable chip-clickable">
              <i
                className={`codicon codicon-${
                  chip.kind === 'selection'
                    ? 'symbol-parameter'
                    : chip.kind === 'diagnostics'
                      ? 'error'
                      : 'file'
                }`}
                onClick={() =>
                  postToHost({
                    type: 'openFile',
                    path: chip.path,
                    absolutePath: chip.absolutePath,
                  })
                }
              />
              <span>{chip.label}</span>
              <button className="chip-remove" title="Remove" onClick={() => onRemoveChip(chip.chipId)}>
                <i className="codicon codicon-close" />
              </button>
            </span>
          ))}
        </div>
      )}

      {showCommandMenu && filteredCommands.length > 0 && (
        <ul className="command-menu" role="listbox">
          {filteredCommands.slice(0, 8).map((command) => (
            <li key={command.name}>
              <button
                className="command-item"
                onClick={() => {
                  setText(`${command.name} `);
                  textarea.current?.focus();
                }}
              >
                <code>{command.name}</code>
                <span className="command-description">{describeCommand(command.name, command.description)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="composer-box">
        <button className="icon-button composer-attach" title={t('attachFile')} onClick={onPickFile}>
          <i className="codicon codicon-add" />
        </button>
        <button
          className="icon-button composer-attach"
          title={t('attachDiagnostics')}
          onClick={() => postToHost({ type: 'attachDiagnostics' })}
        >
          <i className="codicon codicon-error" />
        </button>
        <textarea
          ref={textarea}
          className="composer-input"
          placeholder={t('composerPlaceholder')}
          aria-label={t('composerLabel')}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
              event.preventDefault();
              submit();
            }
            if (event.key === 'Tab' && showCommandMenu && filteredCommands.length > 0) {
              event.preventDefault();
              setText(`${filteredCommands[0]!.name} `);
            }
            if (event.key === 'Escape' && showCommandMenu) {
              event.preventDefault();
              setText('');
            }
            if (event.key === '@' && text.length === 0) {
              onPickFile();
            }
          }}
        />
        {busy ? (
          <button className="send-button stop" title={t('stop')} onClick={onCancel}>
            <i className="codicon codicon-debug-stop" />
          </button>
        ) : (
          <button
            className="send-button"
            title={t('send')}
            disabled={busy || status === 'connecting' || (!text.trim() && chips.length === 0)}
            onClick={submit}
          >
            <i className="codicon codicon-send" />
          </button>
        )}
      </div>

      <SessionControls
        configOptions={configOptions}
        usage={usage}
        modes={modes}
        modeId={modeId}
        send={postToHost as (message: FromWebview) => void}
      />

      <div className="composer-footer">
        <span className={`composer-status status-${status}`}>{statusDetail ?? status}</span>
        <span className="composer-hint">{t('footerHint')}</span>
      </div>
    </div>
  );
}
