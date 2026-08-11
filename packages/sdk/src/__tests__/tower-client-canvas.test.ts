/**
 * Canvas command + view registration calls (spec 1401, plan phase 5).
 *
 * The contract under test is that a resolved promise always carries a verdict a controller can
 * act on: Tower's own `code` when Tower answered, and the client-synthesized `unreachable` when
 * it did not. Conflating those two is the specific bug this call exists to prevent, so most of
 * these cases are about failure shapes rather than the happy path.
 */

import { describe, it, expect, vi } from 'vitest';
import { TowerClient } from '../tower-client.js';

/** Build a client whose transport is a scripted response, and capture what it sent. */
function clientWith(response: { status: number; body?: unknown } | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    const text = response.body === undefined ? '' : JSON.stringify(response.body);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    } as unknown as Response;
  });
  const client = new TowerClient({ port: 4100, fetchFn: fetchFn as unknown as typeof fetch });
  return { client, calls };
}

const TARGET = { workspace: '/ws' };

describe('sendCanvasCommand', () => {
  it('returns the resolved target on success', async () => {
    const { client, calls } = clientWith({
      status: 200,
      body: { ok: true, target: { viewId: 'canvas-1', file: '/ws/spec.md' } },
    });

    const result = await client.sendCanvasCommand('comment-next', TARGET);

    expect(result).toEqual({ ok: true, target: { viewId: 'canvas-1', file: '/ws/spec.md' } });
    expect(calls[0].url).toBe('http://localhost:4100/api/canvas/command');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      workspace: '/ws',
      command: 'comment-next',
    });
  });

  it('preserves the no-canvas code rather than flattening it to a message', async () => {
    const { client } = clientWith({
      status: 404,
      body: { ok: false, code: 'no-canvas', error: 'No canvas view is open' },
    });

    const result = await client.sendCanvasCommand('block-next', TARGET);

    expect(result).toMatchObject({ ok: false, code: 'no-canvas' });
  });

  it('preserves the invalid-request code', async () => {
    const { client } = clientWith({
      status: 400,
      body: { ok: false, code: 'invalid-request', error: 'count is not valid for doc-start' },
    });

    const result = await client.sendCanvasCommand('doc-start', TARGET, { count: 2 });

    expect(result).toMatchObject({ ok: false, code: 'invalid-request' });
  });

  it('reports an unreachable Tower distinguishably from no-canvas', async () => {
    const { client } = clientWith(new Error('connect ECONNREFUSED 127.0.0.1:4100'));

    const result = await client.sendCanvasCommand('block-next', TARGET);

    // The whole point: a controller must not render "no canvas open" when Tower is down.
    expect(result).toMatchObject({ ok: false, code: 'unreachable' });
    expect(result).not.toMatchObject({ code: 'no-canvas' });
  });

  it('reports a timeout as unreachable', async () => {
    const { client } = clientWith(new Error('The operation timed out'));
    const result = await client.sendCanvasCommand('block-next', TARGET);
    expect(result).toMatchObject({ ok: false, code: 'unreachable' });
  });

  // A response is only a verdict if the whole shape checks out. Accepting anything with an `ok`
  // field would hand the caller `target.viewId` off undefined, or a code outside its union.
  it.each([
    ['no ok field', { unexpected: true }],
    ['success with no target', { ok: true }],
    ['success with a malformed target', { ok: true, target: { viewId: 7 } }],
    ['success with a partial target', { ok: true, target: { viewId: 'v' } }],
    ['failure with an unknown code', { ok: false, code: 'unknown', error: 'x' }],
    ['failure with no code', { ok: false, error: 'x' }],
    ['failure with a non-string code', { ok: false, code: 12 }],
    ['a non-object body', 'plain text'],
    ['null', null],
  ])('reports %s as unreachable rather than inventing a verdict', async (_label, body) => {
    const { client } = clientWith({ status: 200, body });
    const result = await client.sendCanvasCommand('block-next', TARGET);
    expect(result).toMatchObject({ ok: false, code: 'unreachable' });
  });

  it('supplies a message when Tower omits one on a valid failure code', async () => {
    const { client } = clientWith({ status: 404, body: { ok: false, code: 'no-canvas' } });
    const result = await client.sendCanvasCommand('block-next', TARGET);
    expect(result).toMatchObject({ ok: false, code: 'no-canvas' });
    expect((result as { error: string }).error).toBeTruthy();
  });

  it('never rejects, whatever the transport does', async () => {
    const { client } = clientWith(new Error('kaboom'));
    await expect(client.sendCanvasCommand('block-next', TARGET)).resolves.toBeDefined();
  });

  it('sends file and count only when supplied', async () => {
    const { client, calls } = clientWith({
      status: 200,
      body: { ok: true, target: { viewId: 'v', file: '/ws/a.md' } },
    });

    await client.sendCanvasCommand('block-next', TARGET);
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('file');
    expect(JSON.parse(calls[0].init.body as string)).not.toHaveProperty('count');

    await client.sendCanvasCommand('block-next', { workspace: '/ws', file: '/ws/a.md' }, { count: 3 });
    expect(JSON.parse(calls[1].init.body as string)).toMatchObject({
      file: '/ws/a.md',
      count: 3,
    });
  });
});

describe('canvas view registration', () => {
  it('registers and returns the Tower-minted id and canonical path', async () => {
    const { client, calls } = clientWith({
      status: 200,
      body: { ok: true, viewId: 'canvas-9', file: '/private/ws/spec.md' },
    });

    const result = await client.registerCanvasView('/ws', '/ws/spec.md');

    expect(result).toEqual({ ok: true, viewId: 'canvas-9', file: '/private/ws/spec.md' });
    expect(calls[0].url).toBe('http://localhost:4100/api/canvas/views');
  });

  it('reports a failed registration without throwing', async () => {
    const { client } = clientWith(new Error('connect ECONNREFUSED 127.0.0.1:4100'));
    await expect(client.registerCanvasView('/ws', '/ws/spec.md')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('heartbeats, and flags an unknown view so the host knows to re-register', async () => {
    const alive = clientWith({ status: 200, body: { ok: true } });
    await expect(alive.client.heartbeatCanvasView('canvas-1', true)).resolves.toEqual({
      ok: true,
      unknownView: false,
    });
    expect(JSON.parse(alive.calls[0].init.body as string)).toEqual({ focused: true });

    const forgotten = clientWith({ status: 404, body: { ok: false, error: 'Unknown view' } });
    const result = await forgotten.client.heartbeatCanvasView('canvas-1');
    // A forgotten id and an unreachable Tower call for different host behavior: re-register
    // versus retry later.
    expect(result).toMatchObject({ ok: false, unknownView: true });

    const down = clientWith(new Error('connect ECONNREFUSED 127.0.0.1:4100'));
    await expect(down.client.heartbeatCanvasView('canvas-1')).resolves.toMatchObject({
      ok: false,
      unknownView: false,
    });
  });

  it('omits focused from the heartbeat body when not supplied', async () => {
    const { client, calls } = clientWith({ status: 200, body: { ok: true } });
    await client.heartbeatCanvasView('canvas-1');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({});
  });

  it('unregisters with DELETE', async () => {
    const { client, calls } = clientWith({ status: 200, body: { ok: true } });

    await expect(client.unregisterCanvasView('canvas-1')).resolves.toEqual({ ok: true });
    expect(calls[0].init.method).toBe('DELETE');
    expect(calls[0].url).toBe('http://localhost:4100/api/canvas/views/canvas-1');
  });

  it('encodes a view id that would otherwise break the path', async () => {
    const { client, calls } = clientWith({ status: 200, body: { ok: true } });
    await client.unregisterCanvasView('canvas/../evil');
    expect(calls[0].url).toBe('http://localhost:4100/api/canvas/views/canvas%2F..%2Fevil');
  });
});
