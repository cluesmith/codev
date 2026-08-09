import { describe, it, expect, vi } from 'vitest';
import { TowerClient } from '../tower-client.js';
import { parseSseText, type SseEnvelope } from '../sse.js';

/** A fake fetch that records calls and returns a scripted JSON response. */
function jsonFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const KEY = 'deadbeef';
const opts = (fetchFn: typeof fetch) => ({ port: 4100, getAuthKey: () => KEY, fetchFn });

describe('TowerClient auth seam', () => {
  it('sends the codev-web-key header when a key provider is injected', async () => {
    const { impl, calls } = jsonFetch(200, { ok: true });
    await new TowerClient(opts(impl)).sendCommand('view-diff', ['0809']);
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['codev-web-key']).toBe(KEY);
  });

  it('omits the auth header when the injected provider has no key', async () => {
    const { impl, calls } = jsonFetch(200, { ok: true });
    await new TowerClient({ port: 4100, getAuthKey: () => null, fetchFn: impl }).sendCommand('refresh-overview');
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['codev-web-key']).toBeUndefined();
  });

  it('defaults to NO auth when no provider is injected (issue #1189 contract)', async () => {
    const { impl, calls } = jsonFetch(200, { ok: true });
    await new TowerClient({ port: 4100, fetchFn: impl }).getHealth();
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['codev-web-key']).toBeUndefined();
  });
});

describe('TowerClient REST', () => {
  it('POSTs /api/command with verb, default args, and workspace when given', async () => {
    const { impl, calls } = jsonFetch(200, { ok: true });
    await new TowerClient(opts(impl)).sendCommand('view-diff', ['0809'], '/work/alpha');
    expect(calls[0].url).toBe('http://localhost:4100/api/command');
    expect(calls[0].init!.method).toBe('POST');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({
      verb: 'view-diff',
      args: ['0809'],
      workspace: '/work/alpha',
    });
  });

  it('omits workspace from the body when not provided', async () => {
    const { impl, calls } = jsonFetch(200, { ok: true });
    await new TowerClient(opts(impl)).sendCommand('new-shell');
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ verb: 'new-shell', args: [] });
  });

  it('scopes getOverview to a workspace via the query string', async () => {
    const { impl, calls } = jsonFetch(200, { builders: [], pendingPRs: [], backlog: [], recentlyClosed: [] });
    await new TowerClient(opts(impl)).getOverview('/work/a b');
    expect(calls[0].url).toBe('http://localhost:4100/api/overview?workspace=%2Fwork%2Fa%20b');
  });

  it('listWorkspaces unwraps the workspaces array', async () => {
    const ws = [{ path: '/w', name: 'w', active: true, proxyUrl: '', terminals: 0 }];
    const { impl } = jsonFetch(200, { workspaces: ws });
    expect(await new TowerClient(opts(impl)).listWorkspaces()).toEqual(ws);
  });

  it('normalizes a connection refusal to "Tower not running" (not a throw)', async () => {
    const impl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const res = await new TowerClient(opts(impl)).sendCommand('view-diff');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Tower not running');
  });

  it('treats a non-2xx response as a failed result', async () => {
    const { impl } = jsonFetch(500, {});
    expect(await new TowerClient(opts(impl)).getOverview()).toBeNull();
  });

  it('keeps the numeric-port constructor form working', async () => {
    const { impl } = jsonFetch(200, { status: 'healthy' });
    const client = new TowerClient(5000);
    // The numeric form cannot inject fetch; probe the derived URL instead.
    expect(client.url).toBe('http://localhost:5000');
    void impl;
  });
});

describe('parseSseText', () => {
  it('decodes one complete data: envelope and returns no tail', () => {
    const seen: SseEnvelope[] = [];
    const frame = `data: ${JSON.stringify({ type: 'overview-changed', body: 'x' })}\n\n`;
    const tail = parseSseText(frame, (e) => seen.push(e));
    expect(seen).toEqual([{ type: 'overview-changed', body: 'x' }]);
    expect(tail).toBe('');
  });

  it('returns the unconsumed tail of a partial frame', () => {
    const seen: SseEnvelope[] = [];
    const tail = parseSseText('data: {"type":"a","body', (e) => seen.push(e));
    expect(seen).toEqual([]);
    expect(tail).toBe('data: {"type":"a","body');
  });

  it('ignores non-JSON keepalive frames', () => {
    const seen: SseEnvelope[] = [];
    parseSseText(':heartbeat\n\n', (e) => seen.push(e));
    expect(seen).toEqual([]);
  });
});

describe('TowerClient SSE subscription', () => {
  it('reports online, emits decoded envelopes, and stops cleanly', async () => {
    const frame = `data: ${JSON.stringify({ type: 'overview-changed', body: '' })}\n\n`;
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        ctl = controller;
        controller.enqueue(new TextEncoder().encode(frame));
      },
    });
    const impl = vi.fn(async () => ({ ok: true, status: 200, body: stream }) as unknown as Response) as unknown as typeof fetch;

    const events: SseEnvelope[] = [];
    const statuses: boolean[] = [];
    const stop = new TowerClient(opts(impl)).subscribeEvents({
      onEnvelope: (e) => events.push(e),
      onStatus: (s) => statuses.push(s),
      sleep: () => Promise.resolve(),
    });

    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0]).toEqual({ type: 'overview-changed', body: '' });
    expect(statuses[0]).toBe(true);
    stop();
    ctl.close(); // end the stream so the loop sees `stopped` and exits cleanly
  });

  it('sends the auth header on the SSE request', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    const impl = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      throw new Error('refused');
    }) as unknown as typeof fetch;

    let releaseSleep!: () => void;
    const sleep = () => new Promise<void>((r) => { releaseSleep = r; });
    const stop = new TowerClient(opts(impl)).subscribeEvents({ sleep });

    await vi.waitFor(() => expect(calls.length).toBe(1));
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['codev-web-key']).toBe(KEY);
    expect(headers['Accept']).toBe('text/event-stream');
    stop();
    releaseSleep();
  });

  it('reports offline and retries with backoff when the connection fails', async () => {
    let attempts = 0;
    const impl = vi.fn(async () => {
      attempts++;
      throw new Error('refused');
    }) as unknown as typeof fetch;

    // Gate the backoff so the reconnect loop advances exactly one attempt per
    // release; an immediately-resolving sleep would spin unbounded.
    let releaseSleep!: () => void;
    const sleep = () => new Promise<void>((r) => { releaseSleep = r; });

    const statuses: boolean[] = [];
    const stop = new TowerClient(opts(impl)).subscribeEvents({
      onStatus: (s) => statuses.push(s),
      sleep,
    });

    await vi.waitFor(() => expect(attempts).toBe(1)); // first attempt failed
    expect(statuses).toContain(false);
    releaseSleep(); // let it back off and retry once
    await vi.waitFor(() => expect(attempts).toBe(2));
    stop();
    releaseSleep(); // unpark so the loop sees `stopped` and exits
  });
});
