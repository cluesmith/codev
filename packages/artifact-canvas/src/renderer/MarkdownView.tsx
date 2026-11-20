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
  // The object itself is memoized: React 19 compares `dangerouslySetInnerHTML` by identity and
  // re-sets the HTML whenever it changes, which would undo any host's changes to the rendered DOM
  // (and the reader's selection) on every render, not only when the source changes.
  const markup = React.useMemo(() => ({ __html: renderMarkdown(source) }), [source]);
  return <div className="codev-artifact-canvas-rendered" dangerouslySetInnerHTML={markup} />;
}
