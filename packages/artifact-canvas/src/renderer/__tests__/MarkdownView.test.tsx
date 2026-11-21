/**
 * MarkdownView keeps its rendered DOM across a re-render with the same source (#1938): React 19
 * re-sets `dangerouslySetInnerHTML` whenever the prop object changes, so the object is memoized.
 */
import { it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import * as React from 'react';
import { MarkdownView } from '../MarkdownView.js';

afterEach(cleanup);

it('leaves the rendered DOM alone when re-rendered with the same source, and replaces it when the source changes', () => {
  const { container, rerender } = render(<MarkdownView source="[guide](docs/guide.md)" />);
  const anchor = container.querySelector('a')!;
  anchor.removeAttribute('href');
  rerender(<MarkdownView source="[guide](docs/guide.md)" />);
  expect(container.querySelector('a')).toBe(anchor);
  expect(anchor.hasAttribute('href')).toBe(false);
  rerender(<MarkdownView source="[other](docs/other.md)" />);
  expect(container.querySelector('a')!.getAttribute('href')).toBe('docs/other.md');
});
