/**
 * #1938: images in decision items. A workspace path is fetched with the key and shown as an object
 * URL, revoked on cleanup; an http(s) URL is left to the browser; anything else, and any refusal,
 * shows a note in place of the image. The browser itself never requests a workspace path.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import type { DecisionItem, DecisionsDocument } from '@cluesmith/codev-types';
import type { DecisionsState } from '../src/hooks/useDecisions.js';

const mockUseDecisions = vi.fn<(isActive: boolean) => { state: DecisionsState; applyDocument: () => void }>();
vi.mock('../src/hooks/useDecisions.js', () => ({
  useDecisions: (isActive: boolean) => mockUseDecisions(isActive),
}));

import { DecisionsView } from '../src/components/DecisionsView.js';

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

function show(item: Partial<DecisionItem>, ruledMarkdown = '') {
  mockUseDecisions.mockReturnValue({ state: { status: 'ready', document: makeDocument(item, ruledMarkdown) }, applyDocument: () => {} });
  return render(<DecisionsView isActive />);
}

function imageResponse(): Response {
  return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
}

function refusalResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message }), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The `path` each image request asked for, in order. */
function requestedPaths(): string[] {
  return fetchMock.mock.calls.map(([url]) => new URL(String(url), 'http://dashboard.test/').searchParams.get('path') ?? '');
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;
let nextUrl: number;

type KeyedWindow = Window & { __CODEV_TOWER_KEY__?: string };

beforeEach(() => {
  // The key as Tower injects it into the dashboard shell.
  (window as KeyedWindow).__CODEV_TOWER_KEY__ = 'the-key';
  fetchMock = vi.fn<typeof fetch>(async () => imageResponse());
  vi.stubGlobal('fetch', fetchMock);
  nextUrl = 0;
  createObjectURL = vi.fn(() => `blob:http://dashboard.test/${++nextUrl}`);
  revokeObjectURL = vi.fn();
  // jsdom has no object URLs.
  Object.assign(URL, { createObjectURL, revokeObjectURL });
});

afterEach(() => {
  cleanup();
  mockUseDecisions.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as KeyedWindow).__CODEV_TOWER_KEY__;
});

describe('DecisionsView images (#1938)', () => {
  it('fetches a workspace image with the key and shows it from an object URL', async () => {
    let respond!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { respond = resolve; }));
    show({ bodyMarkdown: '![Compact layout](decision-assets/web-4-compact.png)' });

    // Until it loads, the browser has no source to request against the dashboard URL.
    const image = screen.getByRole('img', { name: 'Compact layout' });
    expect(image).not.toHaveAttribute('src');
    expect(requestedPaths()).toEqual(['decision-assets/web-4-compact.png']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/api\/decisions\/image\?path=decision-assets%2Fweb-4-compact\.png$/);
    expect(init?.headers).toEqual({ [TOWER_KEY_HEADER]: 'the-key' });

    respond(imageResponse());
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:http://dashboard.test/1'));
    expect(createObjectURL).toHaveBeenCalledOnce();
  });

  it('sends a `/`-rooted path as written, and a percent-encoded name decoded', async () => {
    show({ bodyMarkdown: '![one](/docs/stacked.svg) ![two](<decision-assets/my shot.png>)' });
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(requestedPaths()).toEqual(['/docs/stacked.svg', 'decision-assets/my shot.png']);
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
    fetchMock.mockResolvedValueOnce(refusalResponse(400, 'outside-workspace', reason));
    const { container } = show({ bodyMarkdown: '![Escape](../../outside.png)' });

    const note = await screen.findByText('Image not loaded');
    expect(note.parentElement).toHaveTextContent('Image not loaded Escape ../../outside.png');
    expect(note.parentElement).toHaveAttribute('title', reason);
    expect(container.querySelector('img')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'Could not reach Tower: Failed to fetch'],
    ['a response that is not an image', () => Promise.resolve(new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } })), 'Unexpected response from Tower (HTTP 200)'],
  ])('shows %s as not loaded', async (_what, respond, reason) => {
    fetchMock.mockImplementationOnce(respond);
    show({ bodyMarkdown: '![Shot](shot.png)' });
    const note = await screen.findByText('Image not loaded');
    expect(note.parentElement).toHaveAttribute('title', reason);
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
    expect(fetchMock).not.toHaveBeenCalled();
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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('revokes the object URL when the markdown changes and when the card goes', async () => {
    const { rerender, unmount } = show({ bodyMarkdown: '![first](first.png)' });
    await waitFor(() => expect(screen.getByRole('img', { name: 'first' })).toHaveAttribute('src', 'blob:http://dashboard.test/1'));

    mockUseDecisions.mockReturnValue({ state: { status: 'ready', document: makeDocument({ bodyMarkdown: '![second](second.png)' }) }, applyDocument: () => {} });
    rerender(<DecisionsView isActive />);
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
    rerender(<DecisionsView isActive />);
    expect(screen.getByRole('img', { name: 'same' })).toHaveAttribute('src', 'blob:http://dashboard.test/1');
    expect(screen.getByText('guide').closest('a')).not.toHaveAttribute('href');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('abandons a load still in flight when the card goes', async () => {
    let respond!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise(resolve => { respond = resolve; }));
    const { unmount } = show({ bodyMarkdown: '![slow](slow.png)' });
    const signal = fetchMock.mock.calls[0][1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    respond(imageResponse());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  describe('clicking an image', () => {
    it('opens a loaded workspace image full size on a page that shows it through <img>', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      show({ bodyMarkdown: '![Stacked](stacked.svg)' });
      const image = screen.getByRole('img', { name: 'Stacked' });
      await waitFor(() => expect(image).toHaveAttribute('src', 'blob:http://dashboard.test/1'));

      fireEvent.click(image);
      expect(open).toHaveBeenCalledExactlyOnceWith('blob:http://dashboard.test/2', '_blank', 'noopener');
      const page = createObjectURL.mock.calls[1][0];
      expect(page.type).toBe('text/html');
      // jsdom's Blob has no text().
      const html = await new Promise<string>(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsText(page);
      });
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).toContain('<img alt="Stacked" src="blob:http://dashboard.test/1">');
    });

    it('opens an http(s) image itself', () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      show({ bodyMarkdown: '![remote](https://example.com/shot.png)' });
      fireEvent.click(screen.getByRole('img', { name: 'remote' }));
      expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/shot.png', '_blank', 'noopener');
    });

    it('follows the link around an image instead', () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      show({ bodyMarkdown: '[![remote](https://example.com/shot.png)](https://example.com/page)' });
      fireEvent.click(screen.getByRole('img', { name: 'remote' }));
      expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/page', '_blank', 'noopener');
    });

    it('does nothing for an image still loading', () => {
      fetchMock.mockReturnValueOnce(new Promise(() => {}));
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      show({ bodyMarkdown: '![pending](pending.png)' });
      fireEvent.click(screen.getByRole('img', { name: 'pending' }));
      expect(open).not.toHaveBeenCalled();
    });
  });
});
