import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import './styles/base.css';
// Dark fallback palette for standalone preview outside VS Code. Imported
// statically (never via `import()`): a dynamic import makes Vite emit
// `import.meta`, which the extension host cannot load as a classic script.
// The stylesheet scopes itself to `body.dsh-standalone`, so it stays inert
// inside the real webview.
import './styles/dev-theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root container missing');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
