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
  it('sends the codev-tower-key header when a key provider is injected', async () => {
    const { impl, calls } = jsonFetch(200, { ok: true });
    await new TowerClient(opts(impl)).sendCommand('view-diff', ['0809']);
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['codev-tower-key']).toBe(KEY);
  });

  it('omits the auth header when the injected provider has no key', async () => {
    const { impl, calls } = jsonFetch(200, { ok: true });
    await new TowerClient({ port: 4100, getAuthKey: () => null, fetchFn: impl }).sendCommand('refresh-overview');
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['codev-tower-key']).toBeUndefined();
  });

  it('defaults to NO auth when no provider is injected (issue #1189 contract)', async () => {
    const { impl, calls } = jsonFetch(200, { ok: true });
    await new TowerClient({ port: 4100, fetchFn: impl }).getHealth();
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers['codev-tower-key']).toBeUndefined();
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

  it('getPR hits /api/pr with number + workspace and unwraps the payload', async () => {
    const pr = { title: 't', body: '', state: 'MERGED', url: 'https://forge/pull/7' };
    const { impl, calls } = jsonFetch(200, pr);
    const got = await new TowerClient(opts(impl)).getPR('7', '/work/a b');
    expect(calls[0].url).toBe('http://localhost:4100/api/pr?number=7&workspace=%2Fwork%2Fa+b');
    expect(got).toEqual(pr);
  });

  it('getPR returns null on a non-2xx response (PR not found)', async () => {
    const { impl } = jsonFetch(404, { error: 'PR #7 not found or forge unavailable' });
    expect(await new TowerClient(opts(impl)).getPR('7')).toBeNull();
  });

  it('normalizes a connection refusal to "Tower not running" (not a throw)', async () => {
    const impl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const res = await new TowerClient(opts(impl)).sendCommand('view-diff');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Tower not running');
  });

  it('recognises a refusal reported the way Node fetch does: `fetch failed`, ECONNREFUSED on cause (#1950)', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4100'), { code: 'ECONNREFUSED' }),
    });
    const impl = vi.fn(async () => { throw refused; }) as unknown as typeof fetch;
    const res = await new TowerClient(opts(impl)).sendMessage('architect', 'hi');
    expect(res).toEqual({ ok: false, error: 'Tower not running', connectionRefused: true });
  });

  it('recognises a refusal thrown as a non-Error value (#1950)', async () => {
    const impl = vi.fn(async () => { throw 'connect ECONNREFUSED 127.0.0.1:4100'; }) as unknown as typeof fetch;
    const res = await new TowerClient(opts(impl)).sendMessage('architect', 'hi');
    expect(res).toEqual({ ok: false, error: 'Tower not running', connectionRefused: true });
  });

  it('does not mark a timeout as refused: that request may have reached Tower (#1950)', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const impl = vi.fn(async () => { throw timeout; }) as unknown as typeof fetch;
    const res = await new TowerClient(opts(impl)).sendMessage('architect', 'hi');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Request timeout');
    expect(res.connectionRefused).toBeUndefined();
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

describe('TowerClient.probeHealth (#1901)', () => {
  const throwing = (err: unknown) => vi.fn(async () => { throw err; }) as unknown as typeof fetch;
  const errno = (code: string) => Object.assign(new Error(`connect ${code}`), { code });
  /** Node's fetch over `localhost`: one attempt per address, the aggregate's code copied from the first. */
  const nodeFetchFailure = (...codes: string[]) =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new AggregateError(codes.map(errno), ''), { code: codes[0] }),
    });

  it('reports running on a healthy answer', async () => {
    const { impl } = jsonFetch(200, { status: 'healthy', version: '3.4.0', startedAt: '2026-11-26T00:00:00.000Z', schemaVersion: 20 });
    expect(await new TowerClient(opts(impl)).probeHealth()).toMatchObject({ state: 'running' });
  });

  it('reports not-running only when every address refused the connection', async () => {
    const client = new TowerClient(opts(throwing(nodeFetchFailure('ECONNREFUSED', 'ECONNREFUSED'))));
    expect(await client.probeHealth()).toEqual({ state: 'not-running' });
  });

  it('still reports not-running when ::1 is unreachable and 127.0.0.1 refused (broken IPv6)', async () => {
    const client = new TowerClient(opts(throwing(nodeFetchFailure('ENETUNREACH', 'ECONNREFUSED'))));
    expect(await client.probeHealth()).toEqual({ state: 'not-running' });
  });

  it('does not let a refused ::1 mask a 127.0.0.1 that failed another way', async () => {
    const client = new TowerClient(opts(throwing(nodeFetchFailure('ECONNREFUSED', 'ECONNRESET'))));
    expect((await client.probeHealth()).state).toBe('unresponsive');
  });

  it('reports a timeout as unresponsive, not as not-running', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const client = new TowerClient(opts(throwing(timeout)));
    expect(await client.probeHealth()).toEqual({ state: 'unresponsive', route: '/health/live', error: 'Request timeout' });
    expect(await client.isRunning()).toBe(false);
  });

  it('keeps the reset reason Node puts on the cause', async () => {
    const reset = Object.assign(new TypeError('fetch failed'), { cause: errno('ECONNRESET') });
    const client = new TowerClient(opts(throwing(reset)));
    expect(await client.probeHealth()).toEqual({ state: 'unresponsive', route: '/health/live', error: 'fetch failed: ECONNRESET' });
  });

  it('reports an error status as unresponsive with the status and body', async () => {
    const { impl } = jsonFetch(503, { error: 'BUSY' });
    expect(await new TowerClient(opts(impl)).probeHealth()).toEqual({
      state: 'unresponsive',
      route: '/health/live',
      error: 'HTTP 503: BUSY',
    });
  });
});

describe('TowerClient liveness route (#1977)', () => {
  type Answer = () => Response | Error;
  const json = (status: number, body: unknown) => () =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  /** The catch-all every Tower gives a route it does not have. */
  const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const LIVENESS = { status: 'healthy', version: '3.4.0', startedAt: '2026-11-26T00:00:00.000Z', schemaVersion: 20 };

  /** A Tower as a transport: each path answers, or throws to stand for no answer. Records the paths asked. */
  function tower(routes: Record<string, Answer>) {
    const asked: string[] = [];
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
      const { pathname } = new URL(String(input));
      asked.push(pathname);
      const outcome = (routes[pathname] ?? notFound)();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }) as typeof fetch;
    return { client: new TowerClient(opts(fetchFn)), asked };
  }

  describe('probeHealth against a Tower that has the route', () => {
    it('reports running from the liveness route alone, carrying its version, and never asks /health', async () => {
      const { client, asked } = tower({ '/health/live': json(200, LIVENESS), '/health': json(200, { status: 'healthy' }) });
      expect(await client.probeHealth()).toEqual({ state: 'running', liveness: LIVENESS });
      expect(asked).toEqual(['/health/live']);
    });

    it('reports not-running on a refused connection, without falling back', async () => {
      const { client, asked } = tower({ '/health/live': refused });
      expect(await client.probeHealth()).toEqual({ state: 'not-running' });
      expect(asked).toEqual(['/health/live']);
    });

    it('reports unresponsive on a timeout, naming the liveness route, without falling back', async () => {
      const { client, asked } = tower({ '/health/live': timeout, '/health': json(200, { status: 'healthy' }) });
      expect(await client.probeHealth()).toEqual({ state: 'unresponsive', route: '/health/live', error: 'Request timeout' });
      expect(asked).toEqual(['/health/live']);
    });

    it('reports a Tower still starting (503) as unresponsive, without falling back', async () => {
      const { client, asked } = tower({ '/health/live': json(503, { error: 'STARTING_UP', message: 'Tower is starting up.' }) });
      expect(await client.probeHealth()).toMatchObject({ state: 'unresponsive', route: '/health/live' });
      expect(asked).toEqual(['/health/live']);
    });
  });

  /** A 200 from the liveness route whose body is not a whole TowerLiveness, and the field named. */
  const MALFORMED: Array<[string, unknown, string]> = [
    ['only a status', { status: 'healthy' }, 'version is undefined'],
    ['a non-healthy status', { ...LIVENESS, status: 'degraded' }, 'status is "degraded"'],
    ['an empty version', { ...LIVENESS, version: '' }, 'version is ""'],
    ['an unparseable startedAt', { ...LIVENESS, startedAt: 'yesterday' }, 'startedAt is "yesterday"'],
    ['a string schemaVersion', { ...LIVENESS, schemaVersion: '20' }, 'schemaVersion is "20"'],
    ['a fractional schemaVersion', { ...LIVENESS, schemaVersion: 1.5 }, 'schemaVersion is 1.5'],
    ['an array', [LIVENESS], 'body is ['],
    ['null', null, 'body is null'],
  ];

  describe('a malformed liveness body', () => {
    it.each(MALFORMED)('probeHealth reports %s as unresponsive, naming the field, without falling back', async (_what, body, field) => {
      const { client, asked } = tower({ '/health/live': json(200, body), '/health': json(200, { status: 'healthy' }) });
      const probe = await client.probeHealth();
      expect(probe).toMatchObject({ state: 'unresponsive', route: '/health/live' });
      expect(probe.state === 'unresponsive' && probe.error).toContain(`malformed liveness body: ${field}`);
      expect(asked).toEqual(['/health/live']);
    });

    it.each(MALFORMED)('getLiveness reports %s as a failure that is neither an older Tower nor unanswered', async (_what, body, field) => {
      const { client, asked } = tower({ '/health/live': json(200, body) });
      const live = await client.getLiveness();
      expect(live.ok).toBe(false);
      expect(!live.ok && live.error).toContain(`malformed liveness body: ${field}`);
      expect(live).not.toHaveProperty('unknownRoute');
      expect(live).not.toHaveProperty('unanswered');
      expect(asked).toEqual(['/health/live']);
    });
  });

  describe('probeHealth against a Tower from before the route', () => {
    it('falls back to /health on the catch-all 404 and reports running', async () => {
      const { client, asked } = tower({ '/health': json(200, { status: 'healthy', uptime: 5 }) });
      expect(await client.probeHealth()).toEqual({ state: 'running' });
      expect(asked).toEqual(['/health/live', '/health']);
    });

    it('falls back to /health on a 401, which an older Tower gives a keyless client for a route it does not list as public', async () => {
      const { client, asked } = tower({
        '/health/live': () => new Response('Unauthorized', { status: 401 }),
        '/health': json(200, { status: 'healthy' }),
      });
      expect(await client.probeHealth()).toEqual({ state: 'running' });
      expect(asked).toEqual(['/health/live', '/health']);
    });

    it('reports an unanswered /health as unresponsive, naming /health', async () => {
      const { client, asked } = tower({ '/health': timeout });
      expect(await client.probeHealth()).toEqual({ state: 'unresponsive', route: '/health', error: 'Request timeout' });
      expect(asked).toEqual(['/health/live', '/health']);
    });

    it('reports not-running when the Tower stopped between the two requests', async () => {
      const { client } = tower({ '/health': refused });
      expect(await client.probeHealth()).toEqual({ state: 'not-running' });
    });
  });

  describe('getLiveness', () => {
    it("returns the Tower's version", async () => {
      const { client, asked } = tower({ '/health/live': json(200, LIVENESS) });
      expect(await client.getLiveness()).toEqual({ ok: true, liveness: LIVENESS });
      expect(asked).toEqual(['/health/live']);
    });

    it('marks the catch-all 404 of an older Tower as an unknown route, and asks nothing else', async () => {
      const { client, asked } = tower({});
      expect(await client.getLiveness()).toMatchObject({ ok: false, unknownRoute: true });
      expect(asked).toEqual(['/health/live']);
    });

    it("marks a keyless client's 401 as an unknown route when the older Tower's public /health answers", async () => {
      const { client, asked } = tower({
        '/health/live': () => new Response('Unauthorized', { status: 401 }),
        '/health': json(200, { status: 'healthy' }),
      });
      expect(await client.getLiveness()).toMatchObject({ ok: false, unknownRoute: true });
      expect(asked).toEqual(['/health/live', '/health']);
    });

    it('does not take a 401 that /health shares (a refused Host) for an older Tower', async () => {
      const unauthorized = () => new Response('Unauthorized', { status: 401 });
      const { client } = tower({ '/health/live': unauthorized, '/health': unauthorized });
      const live = await client.getLiveness();
      expect(live.ok).toBe(false);
      expect(live).not.toHaveProperty('unknownRoute');
      expect(live).not.toHaveProperty('unanswered');
    });

    it('marks no answer at all as unanswered, not as an older Tower', async () => {
      const { client } = tower({ '/health/live': timeout });
      const live = await client.getLiveness();
      expect(live).toEqual({ ok: false, error: 'Request timeout', unanswered: true });
    });

    it('marks any other error status as neither', async () => {
      const { client } = tower({ '/health/live': json(503, { error: 'STARTING_UP', message: 'Tower is starting up.' }) });
      const live = await client.getLiveness();
      expect(live.ok).toBe(false);
      expect(live).not.toHaveProperty('unknownRoute');
      expect(live).not.toHaveProperty('unanswered');
    });
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
    expect(headers['codev-tower-key']).toBe(KEY);
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
