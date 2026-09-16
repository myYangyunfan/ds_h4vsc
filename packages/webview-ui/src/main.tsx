import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import './styles/base.css';

// Standalone preview outside VS Code has no injected --vscode-* variables;
// load the dark fallback theme so the panel still looks like itself.
if (!('acquireVsCodeApi' in window)) {
  void import('./styles/dev-theme.css');
}

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
