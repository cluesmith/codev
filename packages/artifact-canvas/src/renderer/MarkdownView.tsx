import * as React from 'react';
import { renderMarkdown } from './renderer.js';

export interface MarkdownViewProps {
  /** Raw markdown source (supplied by the host via a FileAdapter in real use). */
  source: string;
}

/**
 * Renders sanitized markdown HTML (with `data-line` attributes) into the DOM.
 *
 * Phase 2 standalone view; Phase 3 composes it into `ArtifactCanvas` with the comment overlay
 * and adapters. The HTML is already sanitized by `renderMarkdown` (DOMPurify, D7) before it
 * reaches `dangerouslySetInnerHTML`.
 */
export function MarkdownView({ source }: MarkdownViewProps): React.ReactElement {
  const html = React.useMemo(() => renderMarkdown(source), [source]);
  return React.createElement('div', {
    className: 'codev-artifact-canvas-rendered',
    dangerouslySetInnerHTML: { __html: html },
  });
}
