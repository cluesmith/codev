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
import { writeIdeRecord, deleteIdeRecord, type IdeServerRecord } from '../lib/ide-record.js';

const noopLog = (): void => {};

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
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('ETag', '"boot-commit-abc"');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers }));
  });
  stubWss = new WebSocketServer({ server: stub });
  stubWss.on('connection', (ws) => {
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
  });
  stubPort = await listen(stub);

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
  });

  it('returns 502 when no IDE server is registered', async () => {
    const res = await get('/ide/');
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
  });
});
