import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './components/App.js';
// Spec 1819: MarkdownView's theme (selectors scoped to .codev-artifact-canvas*), imported
// from the entry rather than a component so component tests don't need the built CSS.
import '@cluesmith/codev-artifact-canvas/default-theme.css';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
