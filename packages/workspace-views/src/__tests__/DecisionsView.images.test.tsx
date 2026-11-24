/**
 * #1938: images in decision items. A workspace path is loaded through the host's `image` and shown
 * as an object URL, revoked on cleanup; an http(s) URL is left to the browser; anything else, and
 * any refusal, shows a note in place of the image. The browser itself never requests a workspace
 * path. Clicking a loaded image hands it to the host's `showImage`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import type { DecisionItem, DecisionsDocument } from '@cluesmith/codev-types';
import type { DecisionImageResult } from '../host.js';
import type { DecisionsState } from '../hooks/useDecisions.js';

const mockUseDecisions = vi.fn<(isActive: boolean) => { state: DecisionsState; applyDocument: () => void }>();
vi.mock('../hooks/useDecisions.js', () => ({
  useDecisions: (_read: unknown, isActive: boolean) => mockUseDecisions(isActive),
}));

import { DecisionsView } from '../components/DecisionsView.js';
import { fakeDecisionsHost } from './fakeHost.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function makeDocument(item: Partial<DecisionItem>, ruledMarkdown = ''): DecisionsDocument {
  return {
    path: 'codev/state/pending-decisions.md',
    version: 'v1',
    items: [{
      id: 'web-4',
      stamp: null,
      question: 'Compact or stacked?',
      bodyMarkdown: '',
      options: [],
      currentRuling: '',
      qa: [],
      fingerprint: 'fp-web-4',
      problems: [],
      writable: true,
      ...item,
    }],
    ruledMarkdown,
    problems: [],
  };
}

let host = fakeDecisionsHost();

function show(item: Partial<DecisionItem>, ruledMarkdown = '') {
  mockUseDecisions.mockReturnValue({ state: { status: 'ready', document: makeDocument(item, ruledMarkdown) }, applyDocument: () => {} });
  return render(<DecisionsView host={host} isActive />);
}

function imageResult(): DecisionImageResult {
  return { kind: 'image', blob: new Blob([PNG], { type: 'image/png' }) };
}

/** The `path` each image load asked the host for, in order. */
function requestedPaths(): string[] {
  return host.image.mock.calls.map(([path]) => path);
}

let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;
let nextUrl: number;

beforeEach(() => {
  host = fakeDecisionsHost();
  host.image.mockImplementation(async () => imageResult());
  nextUrl = 0;
  createObjectURL = vi.fn(() => `blob:http://dashboard.test/${++nextUrl}`);
  revokeObjectURL = vi.fn();
  // jsdom has no object URLs.
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  cleanup();
  mockUseDecisions.mockReset();
  vi.restoreAllMocks();
});

describe('DecisionsView images (#1938)', () => {
  it('loads a workspace image through the host and shows it from an object URL', async () => {
    let respond!: (result: DecisionImageResult) => void;
    host.image.mockReturnValueOnce(new Promise(resolve => { respond = resolve; }));
    show({ bodyMarkdown: '![Compact layout](decision-assets/web-4-compact.png)' });

    // Until it loads, the browser has no source to request against the page's URL.
    const image = screen.getByRole('img', { name: 'Compact layout' });
    expect(image).not.toHaveAttribute('src');
    expect(requestedPaths()).toEqual(['decision-assets/web-4-compact.png']);

    respond(imageResult());
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:http://dashboard.test/1'));
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it('sends a `/`-rooted path as written, and a percent-encoded name decoded', async () => {
    show({ bodyMarkdown: '![one](/docs/stacked.svg) ![two](<decision-assets/my shot.png>)' });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(requestedPaths()).toEqual(['/docs/stacked.svg', 'decision-assets/my shot.png']);
  });

  it('fetches the file a source names, without its ?query or #fragment', async () => {
    show({ bodyMarkdown: '![cached](shot.png?v=2) ![anchored](diagram.svg#part)' });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(requestedPaths()).toEqual(['shot.png', 'diagram.svg']);
  });

  it('drops srcset, which would make the browser load a candidate itself', async () => {
    const { container } = show({
      bodyMarkdown: '<img alt="raw" src="a.png" srcset="a.png 1x, a@2x.png 2x"> <img alt="web" src="https://example.com/x.png" srcset="local.png 2x">',
    });
    expect(container.querySelectorAll('img[srcset]')).toHaveLength(0);
    expect(screen.getByRole('img', { name: 'web' })).toHaveAttribute('src', 'https://example.com/x.png');
    await waitFor(() => expect(screen.getByRole('img', { name: 'raw' })).toHaveAttribute('src', 'blob:http://dashboard.test/1'));
    expect(requestedPaths()).toEqual(['a.png']);
  });

  it('loads images in the body, the question-and-answer thread and the ruled section', async () => {
    show(
      {
        bodyMarkdown: '![body](a.png)',
        qa: [{ kind: 'answer', name: 'Web', time: '7:00 am', markdown: 'Like this: ![answer](b.png)' }],
      },
      '- **web-3** · ruled `keep` ![ruled](c.png)',
    );
    await waitFor(() => expect(requestedPaths()).toEqual(['a.png', 'b.png', 'c.png']));
  });

  it('shows a refused image as not loaded: its alt text and its path, with the reason', async () => {
    const reason = 'The image ../../outside.png is outside the workspace, so it was not read.';
    host.image.mockResolvedValueOnce({ kind: 'not-loaded', message: reason });
    const { container } = show({ bodyMarkdown: '![Escape](../../outside.png)' });

    const note = await screen.findByText('Image not loaded');
    expect(note.parentElement).toHaveTextContent('Image not loaded Escape ../../outside.png');
    expect(note.parentElement).toHaveAttribute('title', reason);
    expect(container.querySelector('img')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('shows the reason the host gives for an image it could not load', async () => {
    host.image.mockResolvedValueOnce({ kind: 'not-loaded', message: 'Could not reach Tower: Failed to fetch' });
    show({ bodyMarkdown: '![Shot](shot.png)' });
    const note = await screen.findByText('Image not loaded');
    expect(note.parentElement).toHaveAttribute('title', 'Could not reach Tower: Failed to fetch');
  });

  it('shows a file the browser cannot decode as not loaded, not as a broken image', async () => {
    show({ bodyMarkdown: '![Corrupt](corrupt.png)' });
    const image = screen.getByRole('img', { name: 'Corrupt' });
    await waitFor(() => expect(image).toHaveAttribute('src'));
    fireEvent.error(image);
    expect(screen.getByText('Image not loaded').parentElement).toHaveTextContent('Corrupt corrupt.png');
    expect(screen.queryByRole('img', { name: 'Corrupt' })).toBeNull();
  });

  it('never loads a data: URL, another scheme or a protocol-relative URL', () => {
    const { container } = show({
      bodyMarkdown: '![inline](data:image/png;base64,iVBORw0KGgo=) ![ftp](ftp://example.com/x.png) ![relative](//example.com/x.png)',
    });
    expect(host.image).not.toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    const notes = screen.getAllByText('Image not loaded').map(label => label.parentElement?.textContent);
    expect(notes).toEqual([
      'Image not loaded inline data:image/png;base64,iVBORw0KGgo=',
      'Image not loaded ftp ftp://example.com/x.png',
      'Image not loaded relative //example.com/x.png',
    ]);
  });

  it('leaves an http(s) image to the browser, as before', () => {
    show({ bodyMarkdown: '![remote](https://example.com/shot.png)' });
    expect(screen.getByRole('img', { name: 'remote' })).toHaveAttribute('src', 'https://example.com/shot.png');
    expect(host.image).not.toHaveBeenCalled();
  });

  it('revokes the object URL when the markdown changes and when the card goes', async () => {
    const { rerender, unmount } = show({ bodyMarkdown: '![first](first.png)' });
    await waitFor(() => expect(screen.getByRole('img', { name: 'first' })).toHaveAttribute('src', 'blob:http://dashboard.test/1'));

    mockUseDecisions.mockReturnValue({ state: { status: 'ready', document: makeDocument({ bodyMarkdown: '![second](second.png)' }) }, applyDocument: () => {} });
    rerender(<DecisionsView host={host} isActive />);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:http://dashboard.test/1');
    await waitFor(() => expect(screen.getByRole('img', { name: 'second' })).toHaveAttribute('src', 'blob:http://dashboard.test/2'));

    unmount();
    expect(revokeObjectURL).toHaveBeenLastCalledWith('blob:http://dashboard.test/2');
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('keeps the loaded image, and the link rule, through a re-render with the same markdown', async () => {
    const bodyMarkdown = '![same](same.png) [guide](codev/guide.md)';
    const { rerender } = show({ bodyMarkdown });
    const image = screen.getByRole('img', { name: 'same' });
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:http://dashboard.test/1'));

    // A fresh document with the same item, as each poll or a draft keystroke re-renders the card.
    mockUseDecisions.mockReturnValue({ state: { status: 'ready', document: makeDocument({ bodyMarkdown }) }, applyDocument: () => {} });
    rerender(<DecisionsView host={host} isActive />);
    expect(screen.getByRole('img', { name: 'same' })).toHaveAttribute('src', 'blob:http://dashboard.test/1');
    expect(screen.getByText('guide').closest('a')).not.toHaveAttribute('href');
    expect(host.image).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('abandons a load still in flight when the card goes, and ignores its late reply', async () => {
    let respond!: (result: DecisionImageResult) => void;
    host.image.mockReturnValueOnce(new Promise(resolve => { respond = resolve; }));
    const { unmount } = show({ bodyMarkdown: '![slow](slow.png)' });
    const signal = host.image.mock.calls[0][1];
    unmount();
    expect(signal.aborted).toBe(true);
    respond(imageResult());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  describe('clicking an image', () => {
    it('hands a loaded workspace image to the host to show full size', async () => {
      show({ bodyMarkdown: '![Stacked](stacked.svg)' });
      const image = screen.getByRole('img', { name: 'Stacked' });
      await waitFor(() => expect(image).toHaveAttribute('src', 'blob:http://dashboard.test/1'));

      fireEvent.click(image);
      expect(host.showImage).toHaveBeenCalledExactlyOnceWith({ src: 'blob:http://dashboard.test/1', alt: 'Stacked' });
    });

    it('hands an http(s) image to the host as it is', () => {
      show({ bodyMarkdown: '![remote](https://example.com/shot.png)' });
      fireEvent.click(screen.getByRole('img', { name: 'remote' }));
      expect(host.showImage).toHaveBeenCalledExactlyOnceWith({ src: 'https://example.com/shot.png', alt: 'remote' });
    });

    it('follows the link around an image instead', () => {
      show({ bodyMarkdown: '[![remote](https://example.com/shot.png)](https://example.com/page)' });
      fireEvent.click(screen.getByRole('img', { name: 'remote' }));
      expect(host.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/page');
      expect(host.showImage).not.toHaveBeenCalled();
    });

    it('does nothing for an image still loading', () => {
      host.image.mockReturnValueOnce(new Promise(() => {}));
      show({ bodyMarkdown: '![pending](pending.png)' });
      fireEvent.click(screen.getByRole('img', { name: 'pending' }));
      expect(host.showImage).not.toHaveBeenCalled();
    });
  });
});
