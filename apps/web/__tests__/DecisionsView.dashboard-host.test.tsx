/**
 * Spec 1963: the dashboard's Decisions tab is the shared view with the dashboard as its host. This
 * renders the dashboard's own wrapper, its host and the real polling hook, with only `fetch` and
 * `window.open` faked, so it checks what the dashboard did before the view moved into
 * @cluesmith/codev-workspace-views: images fetched with the key (#1938), refusals and failures
 * shown as not loaded, links and full-size images in a new tab without an opener, and a ruling
 * POSTed with the key. (The view's own behaviour is tested in the package against a fake host.)
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import type { DecisionItem, DecisionsDocument } from '@cluesmith/codev-types';
import { DecisionsView } from '../src/components/DecisionsView.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function makeDocument(item: Partial<DecisionItem>): DecisionsDocument {
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
    ruledMarkdown: '',
    problems: [],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function imageResponse(): Response {
  return new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } });
}

/** What the image route answers; the decisions route always answers with `document`. */
let imageReply: () => Promise<Response>;
let document_: DecisionsDocument;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let createObjectURL: ReturnType<typeof vi.fn<(blob: Blob) => string>>;
let nextUrl: number;

type KeyedWindow = Window & { __CODEV_TOWER_KEY__?: string };

function imageCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('api/decisions/image'));
}

async function show(item: Partial<DecisionItem>) {
  document_ = makeDocument(item);
  render(<DecisionsView isActive />);
  await screen.findByRole('heading', { name: 'Compact or stacked?' });
}

beforeEach(() => {
  // The key as Tower injects it into the dashboard shell.
  (window as KeyedWindow).__CODEV_TOWER_KEY__ = 'the-key';
  imageReply = async () => imageResponse();
  fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url);
    if (path.includes('api/decisions/image')) return imageReply();
    if (path.endsWith('api/decisions/rule') && init?.method === 'POST') {
      return json(200, { ok: true, document: { ...document_, version: 'v2' } });
    }
    if (path.endsWith('api/decisions')) return json(200, { ok: true, document: document_ });
    throw new Error(`unexpected request: ${path}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  nextUrl = 0;
  createObjectURL = vi.fn(() => `blob:http://dashboard.test/${++nextUrl}`);
  // jsdom has no object URLs.
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as KeyedWindow).__CODEV_TOWER_KEY__;
});

describe('the dashboard as the Decisions view\'s host', () => {
  it('reads the decisions file with the key', async () => {
    await show({});
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('./api/decisions');
    expect(init?.headers).toEqual({ [TOWER_KEY_HEADER]: 'the-key' });
  });

  it('fetches a workspace image with the key and shows it from an object URL', async () => {
    await show({ bodyMarkdown: '![Compact layout](decision-assets/web-4-compact.png)' });
    const image = screen.getByRole('img', { name: 'Compact layout' });
    await waitFor(() => expect(image).toHaveAttribute('src', 'blob:http://dashboard.test/1'));
    const [[url, init]] = imageCalls();
    expect(String(url)).toBe('./api/decisions/image?path=decision-assets%2Fweb-4-compact.png');
    expect(init?.headers).toEqual({ [TOWER_KEY_HEADER]: 'the-key' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a refusal, with the server\'s reason', async () => json(400, { ok: false, code: 'outside-workspace', message: 'The image is outside the workspace, so it was not read.' }),
      'The image is outside the workspace, so it was not read.'],
    ['a network failure', async () => { throw new TypeError('Failed to fetch'); }, 'Could not reach Tower: Failed to fetch'],
    ['a response that is not an image', async () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
      'Unexpected response from Tower (HTTP 200)'],
  ])('shows %s as not loaded', async (_what, reply, reason) => {
    imageReply = reply;
    await show({ bodyMarkdown: '![Shot](shot.png)' });
    const note = await screen.findByText('Image not loaded');
    expect(note.parentElement).toHaveAttribute('title', reason);
  });

  it('opens an http(s) link in a new tab without an opener', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await show({ bodyMarkdown: 'See https://example.com/pr/42' });
    fireEvent.click(screen.getByRole('link', { name: 'https://example.com/pr/42' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/pr/42', '_blank', 'noopener');
  });

  it('opens a loaded workspace image full size on a page that shows it through <img>', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await show({ bodyMarkdown: '![Stacked](stacked.svg)' });
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

  it('opens an http(s) image itself', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await show({ bodyMarkdown: '![remote](https://example.com/shot.png)' });
    fireEvent.click(screen.getByRole('img', { name: 'remote' }));
    expect(open).toHaveBeenCalledExactlyOnceWith('https://example.com/shot.png', '_blank', 'noopener');
  });

  it('POSTs a ruling with the key and shows the document Tower answers with', async () => {
    await show({ options: [{ word: 'accept', description: 'merge as is', recommended: true }] });
    fireEvent.click(screen.getByRole('radio', { name: /accept/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('api/decisions/rule'))).toBe(true));
    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith('api/decisions/rule'))!;
    expect(String(url)).toBe('./api/decisions/rule');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', [TOWER_KEY_HEADER]: 'the-key' });
    expect(JSON.parse(String(init?.body))).toEqual({ id: 'web-4', fingerprint: 'fp-web-4', word: 'accept' });
  });
});
