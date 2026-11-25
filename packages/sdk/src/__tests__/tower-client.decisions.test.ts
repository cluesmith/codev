/**
 * The decisions routes (Spec 1819, #1938) through the client (Spec 1963). The VS Code extension
 * serves its Decisions panel through these, so the contract under test is that nothing the
 * dashboard shows is lost on the way: a refusal keeps its `code` and `message` whatever its HTTP
 * status, an image keeps its bytes and type, and "Tower answered with something else" stays
 * distinct from "Tower was not reached". None of the three ever rejects.
 */

import { describe, it, expect, vi } from 'vitest';
import { TowerClient } from '../tower-client.js';
import { encodeWorkspacePath } from '../workspace.js';

interface Scripted {
  status: number;
  /** A JSON body; or `text` for a raw one; or `bytes` for a binary one. */
  body?: unknown;
  text?: string;
  bytes?: Uint8Array;
  contentType?: string;
}

/** A client whose transport answers with `response`, capturing what it sent. */
function clientWith(response: Scripted | Error, key: string | null = 'secret-key') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    const text = response.text ?? (response.body === undefined ? '' : JSON.stringify(response.body));
    const bytes = response.bytes ?? new TextEncoder().encode(text);
    const headers = new Headers();
    if (response.contentType) headers.set('Content-Type', response.contentType);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers,
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    } as unknown as Response;
  });
  const client = new TowerClient({ port: 4100, getAuthKey: () => key, fetchFn: fetchFn as unknown as typeof fetch });
  return { client, calls };
}

const WS = '/Users/me/project';
const BASE = `http://localhost:4100/workspace/${encodeWorkspacePath(WS)}/api/decisions`;

const DOCUMENT = { path: 'codev/decisions.md', version: 'v1', items: [], ruledMarkdown: '', problems: [] };

function refusedConnection(): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('getDecisions', () => {
  it("reads the workspace's decisions route with the key and returns the document", async () => {
    const { client, calls } = clientWith({ status: 200, body: { ok: true, document: DOCUMENT } });

    const result = await client.getDecisions(WS);

    expect(result).toEqual({ kind: 'verdict', status: 200, verdict: { ok: true, document: DOCUMENT } });
    expect(calls[0].url).toBe(BASE);
    expect(headersOf(calls[0].init)['codev-tower-key']).toBe('secret-key');
  });

  it('keeps the not-found refusal (no decisions file) with its code and message', async () => {
    const refusal = { ok: false, code: 'not-found', message: 'There is no decisions file at codev/decisions.md.' };
    const { client } = clientWith({ status: 404, body: refusal });

    expect(await client.getDecisions(WS)).toEqual({ kind: 'verdict', status: 404, verdict: refusal });
  });

  it("is unreadable when the body is not a decisions body (a 401's plain text)", async () => {
    const { client } = clientWith({ status: 401, text: 'Unauthorized' });

    expect(await client.getDecisions(WS)).toEqual({ kind: 'unreadable', status: 401 });
  });

  it('is unreadable when a success body lacks the document fields the view needs', async () => {
    const { client } = clientWith({ status: 200, body: { ok: true, document: { path: 'x' } } });

    expect(await client.getDecisions(WS)).toEqual({ kind: 'unreadable', status: 200 });
  });

  it('is unreachable, not a verdict, when the connection is refused', async () => {
    const { client } = clientWith(refusedConnection());

    expect(await client.getDecisions(WS)).toEqual({ kind: 'unreachable', error: 'Tower not running' });
  });

  it('is unreachable with the transport message for any other failure', async () => {
    const { client } = clientWith(new Error('socket hang up'));

    expect(await client.getDecisions(WS)).toEqual({ kind: 'unreachable', error: 'socket hang up' });
  });
});

describe('ruleDecision', () => {
  const REQUEST = { id: 'D-1', fingerprint: 'abc', word: 'ship', comment: 'Looks right.' };

  it('posts the ruling as JSON to the rule route and returns the re-parsed document', async () => {
    const { client, calls } = clientWith({ status: 200, body: { ok: true, document: DOCUMENT } });

    const result = await client.ruleDecision(WS, REQUEST);

    expect(result).toEqual({ kind: 'verdict', status: 200, verdict: { ok: true, document: DOCUMENT } });
    expect(calls[0].url).toBe(`${BASE}/rule`);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual(REQUEST);
    expect(headersOf(calls[0].init)['Content-Type']).toBe('application/json');
    expect(headersOf(calls[0].init)['codev-tower-key']).toBe('secret-key');
  });

  it.each([
    [409, 'item-changed', 'D-1 changed since you opened it; nothing was written.'],
    [400, 'comment-heading', 'A comment cannot contain a heading.'],
    [500, 'write-failed', 'codev/decisions.md could not be written; the file is unchanged.'],
  ])('keeps a %i refusal (%s) with its code and message', async (status, code, message) => {
    const { client } = clientWith({ status, body: { ok: false, code, message } });

    expect(await client.ruleDecision(WS, REQUEST)).toEqual({ kind: 'verdict', status, verdict: { ok: false, code, message } });
  });

  it('is unreachable when Tower is down', async () => {
    const { client } = clientWith(refusedConnection());

    expect(await client.ruleDecision(WS, REQUEST)).toEqual({ kind: 'unreachable', error: 'Tower not running' });
  });
});

describe('getDecisionImage', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

  it('returns the bytes and type unchanged, asking for the path as written, with the key', async () => {
    const { client, calls } = clientWith({ status: 200, bytes: PNG, contentType: 'image/png' });

    const result = await client.getDecisionImage(WS, '../shots/my shot.png');

    expect(result).toEqual({ kind: 'image', bytes: PNG, contentType: 'image/png' });
    expect(calls[0].url).toBe(`${BASE}/image?path=${encodeURIComponent('../shots/my shot.png')}`);
    expect(headersOf(calls[0].init)['codev-tower-key']).toBe('secret-key');
    // A GET of bytes: no JSON content type is forced on it.
    expect(headersOf(calls[0].init)['Content-Type']).toBeUndefined();
  });

  it('sends no key header when there is no key', async () => {
    const { client, calls } = clientWith({ status: 200, bytes: PNG, contentType: 'image/png' }, null);

    await client.getDecisionImage(WS, 'a.png');

    expect(headersOf(calls[0].init)['codev-tower-key']).toBeUndefined();
  });

  it('is unreadable when a 2xx answer is not an image', async () => {
    const { client } = clientWith({ status: 200, text: '<html></html>', contentType: 'text/html' });

    expect(await client.getDecisionImage(WS, 'a.png')).toEqual({ kind: 'unreadable', status: 200 });
  });

  it.each([
    [404, 'not-found', 'There is no image at a.png.'],
    [400, 'outside-workspace', 'The image ../../etc/x.png is outside the workspace, so it was not read.'],
    [413, 'image-too-large', 'The image a.png is 20000000 bytes, over the 10485760-byte limit, so it was not read.'],
    [415, 'not-an-image', 'a.txt is not a png, jpg, jpeg, gif, webp, svg image, so it was not read.'],
  ])('keeps a %i refusal (%s) with its code and message', async (status, code, message) => {
    const { client } = clientWith({ status, body: { ok: false, code, message }, contentType: 'application/json' });

    expect(await client.getDecisionImage(WS, 'a.png')).toEqual({ kind: 'verdict', status, verdict: { ok: false, code, message } });
  });

  it('is unreadable when a refusal body is not a decisions refusal', async () => {
    const { client } = clientWith({ status: 401, text: 'Unauthorized' });

    expect(await client.getDecisionImage(WS, 'a.png')).toEqual({ kind: 'unreadable', status: 401 });
  });

  it('is unreachable when the connection is refused, and when the request times out', async () => {
    expect(await clientWith(refusedConnection()).client.getDecisionImage(WS, 'a.png'))
      .toEqual({ kind: 'unreachable', error: 'Tower not running' });
    expect(await clientWith(new Error('The operation was aborted due to timeout')).client.getDecisionImage(WS, 'a.png'))
      .toEqual({ kind: 'unreachable', error: 'Request timeout' });
  });
});
