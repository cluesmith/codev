/**
 * IDE forward — real end-to-end proxying through a stub loopback server
 * (Issue #1668, architect-sanctioned dev path). Stands up a stub HTTP+WS server
 * as the "IDE server", points the record at it, and drives real requests
 * through `forwardIdeHttp` / `forwardIdeWebSocket`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { rmSync } from 'node:fs';

const TMP_DIR = vi.hoisted(() => `${process.env.TMPDIR || '/tmp'}/ide-forward-int-${process.pid}-${Date.now()}`);

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: TMP_DIR };
});

import { forwardIdeHttp, forwardIdeWebSocket } from '../servers/ide-forward.js';
import { writeIdeRecord, deleteIdeRecord, ensureIdeConnectionToken, type IdeServerRecord } from '../lib/ide-record.js';
import type { IncomingHttpHeaders } from 'node:http';

const noopLog = (): void => {};

let token: string;
let lastWsReqHeaders: IncomingHttpHeaders | null = null;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(addr && typeof addr !== 'string' ? addr.port : 0);
    });
  });
}
function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function recordFor(port: number): IdeServerRecord {
  return { prefix: '/ide/', port, serverPath: '/does/not/matter', pid: 0, startedAt: new Date().toISOString() };
}

let stub: http.Server;
let stubWss: WebSocketServer;
let stubPort: number;
let tower: http.Server;
let towerPort: number;

beforeAll(async () => {
  // Stub "IDE server": echoes the request, and stamps long-lived cache headers
  // the way the real server-web build serves its static assets.
  stub = http.createServer((req, res) => {
    // A workbench page (Issue #1869): the real server embeds its configuration
    // in this meta tag and sets its token as a cookie.
    const page = '<html><head><meta id="vscode-workbench-web-configuration" data-settings="{&quot;remoteAuthority&quot;:&quot;localhost:4100&quot;}"></head></html>';
    if (req.url?.startsWith('/ide/workbench-gzip')) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Encoding', 'gzip');
      res.end(page);
      return;
    }
    if (req.url?.startsWith('/ide/workbench-404')) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/html');
      res.end(page);
      return;
    }
    if (req.url?.startsWith('/ide/workbench-huge')) {
      res.setHeader('Content-Type', 'text/html');
      // Chunked (no Content-Length), so the bound is hit mid-stream.
      res.write(page);
      res.end('x'.repeat(2 * 1024 * 1024 + 10));
      return;
    }
    if (req.url?.startsWith('/ide/workbench')) {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Set-Cookie', 'vscode-tkn=UPSTREAM-TOKEN; Max-Age=604800; SameSite=Lax');
      res.end(page);
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('ETag', '"boot-commit-abc"');
    // The real server sets its connection token as a cookie (Issue #1869).
    res.setHeader('Set-Cookie', ['vscode-tkn=UPSTREAM-TOKEN; Max-Age=604800; SameSite=Lax', 'other=keep']);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers }));
  });
  stubWss = new WebSocketServer({ server: stub });
  stubWss.on('connection', (ws, req) => {
    lastWsReqHeaders = req.headers;
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
  });
  stubPort = await listen(stub);

  // The server is spawned with a connection-token file; the forward must present
  // it. Create the token in the (temp) AGENT_FARM_DIR so readIdeConnectionToken finds it.
  token = ensureIdeConnectionToken();

  // Tower stand-in: its request/upgrade handlers delegate to the forward.
  tower = http.createServer((req, res) => {
    void forwardIdeHttp(req, res, noopLog);
  });
  tower.on('upgrade', (req, socket, head) => {
    void forwardIdeWebSocket(req, socket, head as Buffer, noopLog);
  });
  towerPort = await listen(tower);
});

afterAll(async () => {
  stubWss.close();
  await close(stub);
  await close(tower);
  rmSync(TMP_DIR, { recursive: true, force: true });
});

afterEach(() => deleteIdeRecord());

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: towerPort, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('IDE HTTP forward (stub loopback)', () => {
  it('forwards path + ?folder unchanged, sanitizes request headers, and preserves Cache-Control/ETag', async () => {
    writeIdeRecord(recordFor(stubPort));

    const res = await get('/ide/?folder=%2Fhome%2Fdev%2Fproj', {
      'codev-tower-key': 'the-secret',
      'x-codev-tunnel-proxy': '1',
      'x-forwarded-port': '4100',
      accept: 'text/html',
    });

    expect(res.status).toBe(200);
    // Response caching headers preserved (the whole caching win, §D1).
    expect(res.headers['cache-control']).toBe('public, max-age=31536000');
    expect(res.headers['etag']).toBe('"boot-commit-abc"');

    const echoed = JSON.parse(res.body) as { url: string; headers: Record<string, string> };
    // Path + query forwarded verbatim (workspace selection via ?folder).
    expect(echoed.url).toBe('/ide/?folder=%2Fhome%2Fdev%2Fproj');
    // Sanitized: Tower's key + tunnel marker + leaked port never reach the server.
    expect(echoed.headers['codev-tower-key']).toBeUndefined();
    expect(echoed.headers['x-codev-tunnel-proxy']).toBeUndefined();
    expect(echoed.headers['x-forwarded-port']).toBeUndefined();
    // Host rewritten to the loopback target.
    expect(echoed.headers['host']).toBe(`127.0.0.1:${stubPort}`);
    // Connection token injected as a cookie so the server (spawned with
    // --connection-token-file) does not 403 (#1668 cloud-run fix).
    expect(echoed.headers['cookie']).toBe(`vscode-tkn=${token}`);
  });

  it('merges the token cookie without clobbering an existing Cookie header', async () => {
    writeIdeRecord(recordFor(stubPort));
    const res = await get('/ide/', { 'codev-tower-key': 'k', cookie: 'foo=bar' });
    const echoed = JSON.parse(res.body) as { headers: Record<string, string> };
    expect(echoed.headers['cookie']).toBe(`foo=bar; vscode-tkn=${token}`);
  });

  it("replaces a browser-held vscode-tkn with Tower's (Issue #1869)", async () => {
    writeIdeRecord(recordFor(stubPort));
    const res = await get('/ide/', { cookie: 'vscode-tkn=stale; foo=bar' });
    const echoed = JSON.parse(res.body) as { headers: Record<string, string> };
    expect(echoed.headers['cookie']).toBe(`foo=bar; vscode-tkn=${token}`);
  });

  it('returns 502 when no IDE server is registered', async () => {
    const res = await get('/ide/');
    expect(res.status).toBe(502);
  });

  it('502s when the recorded server is down (connect refused) — no hot-path port scan', async () => {
    // A port with nothing listening: bind then immediately release it.
    const deadPort = await new Promise<number>((resolve) => {
      const s = http.createServer();
      s.listen(0, '127.0.0.1', () => {
        const a = s.address();
        const p = a && typeof a !== 'string' ? a.port : 0;
        s.close(() => resolve(p));
      });
    });
    writeIdeRecord({ prefix: '/ide/', port: deadPort, serverPath: '/does/not/matter', pid: 0, startedAt: new Date().toISOString() });
    const res = await get('/ide/', { 'codev-tower-key': 'k' });
    expect(res.status).toBe(502);
  });
});

describe('IDE WebSocket forward (stub loopback)', () => {
  it('raw-pipes bytes both ways to the IDE server', async () => {
    writeIdeRecord(recordFor(stubPort));

    const echoed = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${towerPort}/ide/?reconnectionToken=abc`);
      const timer = setTimeout(() => reject(new Error('WS timed out')), 5000);
      ws.on('open', () => ws.send('hello'));
      ws.on('message', (data) => {
        clearTimeout(timer);
        ws.close();
        resolve(data.toString());
      });
      ws.on('error', reject);
    });

    expect(echoed).toBe('echo:hello');
    // The upgrade the stub received carried the injected connection-token cookie.
    expect(lastWsReqHeaders?.['cookie']).toContain(`vscode-tkn=${token}`);
  });
});

describe('IDE HTTP forward never hands the browser the connection token (Issue #1869)', () => {
  it('strips the vscode-tkn Set-Cookie and keeps other cookies', async () => {
    writeIdeRecord(recordFor(stubPort));
    const res = await get('/ide/?folder=%2Fw', { host: 'localhost:4100' });
    expect(res.status).toBe(200);
    const setCookie = res.headers['set-cookie'] ?? [];
    expect(setCookie.join('\n')).not.toContain('vscode-tkn');
    expect(setCookie).toContain('other=keep');
    // Tower's own authority is stamped for a local request.
    expect(JSON.parse(res.body).headers['x-forwarded-host']).toBe('localhost:4100');
  });

  it('relays the tunnel path unchanged: Set-Cookie kept (cloud variant is a follow-up)', async () => {
    writeIdeRecord(recordFor(stubPort));
    const res = await get('/ide/', { 'x-codev-tunnel-proxy': '1' });
    expect((res.headers['set-cookie'] ?? []).join('\n')).toContain('vscode-tkn=UPSTREAM-TOKEN');
  });
});

describe('IDE workbench page gets its token from configuration, not a cookie (Issue #1869)', () => {
  it('locally: injects connectionToken into the configuration, strips the Set-Cookie, fixes Content-Length', async () => {
    writeIdeRecord(recordFor(stubPort));
    const res = await get('/ide/workbench', { host: 'localhost:4100' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body));
    const settings = /data-settings="([^"]*)"/.exec(res.body)?.[1].replace(/&quot;/g, '"');
    expect(JSON.parse(settings as string)).toEqual({ connectionToken: token, remoteAuthority: 'localhost:4100' });
  });

  it('relays unchanged when Content-Encoding is set, on a non-200, or past the 2 MB bound', async () => {
    writeIdeRecord(recordFor(stubPort));
    for (const path of ['/ide/workbench-gzip', '/ide/workbench-404', '/ide/workbench-huge']) {
      const res = await get(path, { host: 'localhost:4100' });
      expect(res.body).not.toContain('connectionToken');
    }
    const huge = await get('/ide/workbench-huge', { host: 'localhost:4100' });
    expect(huge.body.length).toBeGreaterThan(2 * 1024 * 1024);
  });

  it('over the tunnel: the page and its Set-Cookie are relayed unchanged (local-only scope)', async () => {
    writeIdeRecord(recordFor(stubPort));
    const res = await get('/ide/workbench', { 'x-codev-tunnel-proxy': '1' });
    expect(res.body).not.toContain('connectionToken');
    expect((res.headers['set-cookie'] ?? []).join('\n')).toContain('vscode-tkn=UPSTREAM-TOKEN');
  });
});
