/**
 * Public API for @cluesmith/codev-artifact-canvas.
 *
 * Phase 1: locked adapter interfaces + data types + component props, and a placeholder
 * `ArtifactCanvas` component.
 * Phase 2: the markdown renderer (`renderMarkdown`) + standalone `MarkdownView`.
 *
 * The default theme stylesheet is a separate export:
 *   import '@cluesmith/codev-artifact-canvas/default-theme.css';
 */

export type { FileAdapter } from './adapters/FileAdapter.js';
export type { MarkerAdapter } from './adapters/MarkerAdapter.js';
export type { ThemeAdapter } from './adapters/ThemeAdapter.js';
export type { Disposable, ReviewMarker, ArtifactCanvasProps } from './types.js';

export { ArtifactCanvas } from './components/ArtifactCanvas.js';

export { renderMarkdown } from './renderer/renderer.js';
export { MarkdownView, type MarkdownViewProps } from './renderer/MarkdownView.js';
