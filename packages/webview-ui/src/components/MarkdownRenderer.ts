import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';

/**
 * Markdown rendering with sanitization and highlight.js. Code fences are
 * rendered by a custom fence rule (NOT the highlight option - markdown-it
 * double-wraps non-<pre highlight results) producing a wrapper with
 * copy / insert-to-editor actions handled via event delegation.
 */

// Content-addressed registry: the same code block reuses the same id across
// re-renders during streaming, so the map stays bounded by distinct blocks.
const codeRegistry = new Map<string, string>();

/** FNV-1a - compact, deterministic, adequate for dedup keys. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const md: MarkdownIt = MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

function renderFence(code: string, lang: string): string {
  const id = `code-${fnv1a(`${lang}\u0000${code}`)}`;
  codeRegistry.set(id, code);
  const language = lang && hljs.getLanguage(lang) ? lang : undefined;
  const highlighted = language
    ? hljs.highlight(code, { language }).value
    : md.utils.escapeHtml(code);
  return (
    `<div class="code-block" data-code-id="${id}">` +
    `<div class="code-block-bar">` +
    `<span class="code-block-lang">${escapeHtml(lang || 'text')}</span>` +
    `<span class="code-block-actions">` +
    `<button class="code-action" data-action="copy" data-code-id="${id}" title="Copy">` +
    `<i class="codicon codicon-copy"></i></button>` +
    `<button class="code-action" data-action="insert" data-code-id="${id}" title="Insert into editor">` +
    `<i class="codicon codicon-insert"></i></button>` +
    `</span></div>` +
    `<pre><code class="hljs">${highlighted}</code></pre>` +
    `</div>`
  );
}

// Overriding the fence rule (not the highlight option) means the return
// value is used verbatim - no extra <pre><code> wrapping.
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]!;
  const lang = (token.info || '').trim().split(/\s+/)[0] ?? '';
  return renderFence(token.content, lang);
};

export function renderMarkdown(source: string): string {
  const raw = md.render(source);
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['data-code-id', 'data-action', 'target'],
    ADD_TAGS: ['button'],
  });
}

/** Returns the raw code registered for a rendered block id. */
export function getCodeBlock(id: string): string | undefined {
  return codeRegistry.get(id);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
