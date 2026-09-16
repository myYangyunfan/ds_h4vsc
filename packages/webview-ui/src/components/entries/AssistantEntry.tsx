import { memo, useEffect, useState } from 'react';
import type { TimelineEntry } from '@dsh-vscode/core';
import { renderMarkdown, getCodeBlock } from '../MarkdownRenderer.js';
import { postToHost } from '../../vscode.js';
import { useT } from '../../strings.js';
import { useToast } from '../Toast.js';

type AssistantEntryModel = Extract<TimelineEntry, { kind: 'assistant' }>;

interface AssistantEntryProps {
  entry: AssistantEntryModel;
  /** True while this entry is the one currently being streamed. */
  streaming: boolean;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Markdown re-render debounce during streaming (ms). */
const STREAM_RENDER_DEBOUNCE_MS = 120;

/**
 * Memoized: only the streaming entry gets a new object per chunk. While
 * streaming, the expensive markdown render is debounced so a burst of
 * chunks doesn't re-parse the full text every 10ms.
 */
export const AssistantEntry = memo(function AssistantEntry({ entry, streaming }: AssistantEntryProps) {
  const t = useT();
  const { toast } = useToast();
  const [renderedText, setRenderedText] = useState(entry.text);

  useEffect(() => {
    if (!streaming) {
      // Final render: always show the complete text.
      setRenderedText(entry.text);
      return;
    }
    const timer = setTimeout(() => setRenderedText(entry.text), STREAM_RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [entry.text, streaming]);

  const html = renderMarkdown(renderedText);

  // Event delegation for code-block action buttons rendered by MarkdownRenderer.
  const onBodyClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('.code-action');
    if (!target) {
      return;
    }
    const codeId = target.dataset.codeId;
    const code = codeId ? getCodeBlock(codeId) : undefined;
    if (code === undefined) {
      return;
    }
    if (target.dataset.action === 'copy') {
      void navigator.clipboard?.writeText(code);
      target.classList.add('done');
      setTimeout(() => target.classList.remove('done'), 1_200);
    } else if (target.dataset.action === 'insert') {
      postToHost({ type: 'insertCode', code });
    }
  };

  const copyMessage = (): void => {
    void navigator.clipboard?.writeText(entry.text);
    toast('toastCopied', 'success');
  };

  return (
    // The HTML was sanitized with DOMPurify inside renderMarkdown().
    <div className="entry entry-assistant" title={formatTime(entry.timestamp)}>
      <div className="entry-assistant-avatar" aria-hidden>
        <i className="codicon codicon-sparkle" />
      </div>
      <div className="entry-assistant-body">
        {entry.thought && (
          <details className="thought-block">
            <summary>
              <i className="codicon codicon-lightbulb" />
              {t('thinking')}
            </summary>
            <div className="thought-content">{entry.thought}</div>
          </details>
        )}
        {entry.text ? (
          <div
            className={`markdown-body${streaming ? ' is-streaming' : ''}`}
            onClick={onBodyClick}
            // Safe: sanitized by DOMPurify in renderMarkdown().
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="markdown-body streaming-placeholder">
            <span className="typing-dot" />
          </div>
        )}
      </div>
      {entry.text && !streaming && (
        <div className="entry-tools">
          <button className="icon-button" title={t('copy')} onClick={copyMessage}>
            <i className="codicon codicon-copy" />
          </button>
        </div>
      )}
    </div>
  );
});
