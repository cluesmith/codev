/**
 * Spec 1819 Phases 4 and 6: fetchDecisions and postDecisionRuling never throw — they map
 * every response the decisions routes (or anything in front of them) can give to a
 * document, a refusal or an error.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DecisionsDocument } from '@cluesmith/codev-types';
import { fetchDecisions, postDecisionRuling } from '../src/lib/api.js';

// localStorage mock for jsdom (same pattern as the other web tests); the key lookup reads it.
const storageMap = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => storageMap.set(key, value),
    removeItem: (key: string) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    get length() { return storageMap.size; },
    key: (index: number) => [...storageMap.keys()][index] ?? null,
  },
  writable: true,
});

const DOC: DecisionsDocument = {
  path: 'codev/state/pending-decisions.md',
  version: 'abc',
  items: [],
  ruledMarkdown: '',
  problems: [],
};

function respond(status: number, body: string, contentType = 'application/json') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDecisions', () => {
  it('reads the decisions route relative to the workspace', async () => {
    respond(200, JSON.stringify({ ok: true, document: DOC }));
    await fetchDecisions();
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('./api/decisions');
  });

  it('returns the document from a 200', async () => {
    respond(200, JSON.stringify({ ok: true, document: DOC }));
    expect(await fetchDecisions()).toEqual({ kind: 'document', document: DOC });
  });

  it('returns not-found, with the server message, for the not-found refusal', async () => {
    respond(404, JSON.stringify({ ok: false, code: 'not-found', message: 'There is no decisions file at x.md.' }));
    expect(await fetchDecisions()).toEqual({ kind: 'not-found', message: 'There is no decisions file at x.md.' });
  });

  it('returns other refusals as errors carrying the server message', async () => {
    respond(400, JSON.stringify({ ok: false, code: 'outside-workspace', message: 'outside the workspace' }));
    expect(await fetchDecisions()).toEqual({ kind: 'error', message: 'outside the workspace' });
  });

  it('treats a non-JSON body (the 401 "Unauthorized" text) as an error', async () => {
    respond(401, 'Unauthorized', 'text/plain');
    expect(await fetchDecisions()).toEqual({ kind: 'error', message: 'Unexpected response from Tower (HTTP 401)' });
  });

  it('treats a JSON body without `ok` (a dispatcher { error }) as an error', async () => {
    respond(500, JSON.stringify({ error: 'boom' }));
    expect(await fetchDecisions()).toEqual({ kind: 'error', message: 'Unexpected response from Tower (HTTP 500)' });
  });

  it('treats an `ok: true` body without a well-formed document as an error', async () => {
    respond(200, JSON.stringify({ ok: true, document: { path: 'x.md' } }));
    expect(await fetchDecisions()).toEqual({ kind: 'error', message: 'Unexpected response from Tower (HTTP 200)' });
  });

  it('returns a network failure as an error instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await fetchDecisions()).toEqual({ kind: 'error', message: 'Could not reach Tower: Failed to fetch' });
  });
});

describe('postDecisionRuling', () => {
  const REQUEST = { id: 'main-12', fingerprint: 'fp', word: 'accept', comment: 'ship it' };

  it('posts the request as JSON to the rule route relative to the workspace', async () => {
    respond(200, JSON.stringify({ ok: true, document: DOC }));
    await postDecisionRuling(REQUEST);
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('./api/decisions/rule');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual(REQUEST);
  });

  it('leaves an absent word or comment out of the body', async () => {
    respond(200, JSON.stringify({ ok: true, document: DOC }));
    await postDecisionRuling({ id: 'main-12', fingerprint: 'fp', word: undefined, comment: 'why?' });
    expect(vi.mocked(fetch).mock.calls[0][1]?.body).toBe('{"id":"main-12","fingerprint":"fp","comment":"why?"}');
  });

  it('returns the re-parsed document from a 200', async () => {
    respond(200, JSON.stringify({ ok: true, document: DOC }));
    expect(await postDecisionRuling(REQUEST)).toEqual({ kind: 'document', document: DOC });
  });

  it.each([
    [409, 'item-changed', 'main-12 changed after you last saw it.'],
    [400, 'comment-heading', 'The comment contains a heading line.'],
    [404, 'not-found', 'There is no decisions file at x.md.'],
    [500, 'write-failed', 'x.md could not be written; the file is unchanged.'],
  ])('returns an HTTP %i refusal with its code and message', async (status, code, message) => {
    respond(status, JSON.stringify({ ok: false, code, message }));
    expect(await postDecisionRuling(REQUEST)).toEqual({ kind: 'refused', code, message });
  });

  it('treats a non-JSON body (the 401 "Unauthorized" text) as an error', async () => {
    respond(401, 'Unauthorized', 'text/plain');
    expect(await postDecisionRuling(REQUEST)).toEqual({ kind: 'error', message: 'Unexpected response from Tower (HTTP 401)' });
  });

  it('treats a JSON body without `ok` (a dispatcher { error }) as an error', async () => {
    respond(500, JSON.stringify({ error: 'boom' }));
    expect(await postDecisionRuling(REQUEST)).toEqual({ kind: 'error', message: 'Unexpected response from Tower (HTTP 500)' });
  });

  it('returns a network failure as an error instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await postDecisionRuling(REQUEST)).toEqual({ kind: 'error', message: 'Could not reach Tower: Failed to fetch' });
  });
});
