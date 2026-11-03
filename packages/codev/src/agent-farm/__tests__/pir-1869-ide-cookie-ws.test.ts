/**
 * Issue #1869: the `/ide` forward cookie on the REAL WebSocket upgrade path.
 *
 * Drives real `ws` clients through the real `setupUpgradeHandler` into a stub
 * loopback "IDE server". Proves the workbench's vanilla `?reconnectionToken=`
 * socket authorizes on the cookie alone, that another localhost port cannot
 * ride the cookie (security review M1), that the cookie never reaches the IDE
 * server, and that refusal logs carry no credential (S4).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { rmSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';

const TMP_DIR = vi.hoisted(() => `${process.env.TMPDIR || '/tmp'}/pir-1869-ws-${process.pid}-${Date.now()}`);
const KEY = 'c'.repeat(64);
const { logLines } = vi.hoisted(() => ({ logLines: [] as string[] }));

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: TMP_DIR };
});

vi.mock('@cluesmith/codev-core/auth', () => ({
  ensureLocalKey: vi.fn(() => KEY),
  readLocalKey: vi.fn(() => KEY),
}));

vi.mock('../servers/tower-terminals.js', () => ({
  getTerminalManager: () => ({ getSession: () => null }),
  isStartupReconcileSettled: () => true,
  whenStartupReconcileSettled: () => Promise.resolve(),
  logTerminal: (level: string, message: string) => {
    logLines.push(`${level} ${message}`);
  },
}));

vi.mock('../servers/tower-utils.js', () => ({
  normalizeWorkspacePath: (p: string) => p,
}));

import { setupUpgradeHandler } from '../servers/tower-websocket.js';
import { writeIdeRecord, deleteIdeRecord, ensureIdeConnectionToken } from '../lib/ide-record.js';
import { IDE_FORWARD_COOKIE, resetExpectedKeyCache } from '../utils/server-utils.js';

const COOKIE = `${IDE_FORWARD_COOKIE}=${createHmac('sha256', KEY).update('codev-ide-forward/v1').digest('hex')}`;

let stub: http.Server;
let stubWss: WebSocketServer;
let tower: http.Server;
let towerWss: WebSocketServer;
let towerPort: number;
let stubPort: number;
let lastUpstreamCookie: string | undefined;
let lastUpstreamForwardedHost: string | undefined;
let lastClientSetCookie: string | string[] | undefined;

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

type Outcome = { kind: 'echo'; data: string } | { kind: 'closed'; code: number } | { kind: 'error'; message: string };

function connect(headers: Record<string, string>, origin?: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${towerPort}/ide/?reconnectionToken=abc`, { headers, origin });
    const timer = setTimeout(() => resolve({ kind: 'error', message: 'timeout' }), 5000);
    ws.on('upgrade', (res) => {
      lastClientSetCookie = res.headers['set-cookie'];
    });
    ws.on('open', () => ws.send('hello'));
    ws.on('message', (data) => {
      clearTimeout(timer);
      ws.close();
      resolve({ kind: 'echo', data: data.toString() });
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve({ kind: 'closed', code });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      resolve({ kind: 'error', message: err.message });
    });
  });
}

beforeAll(async () => {
  resetExpectedKeyCache();
  stub = http.createServer((_req, res) => res.end('ok'));
  stubWss = new WebSocketServer({ server: stub });
  // The real IDE server answers with its connection token as a cookie; Tower must
  // never let that reach the browser.
  stubWss.on('headers', (headers) => {
    headers.push('Set-Cookie: vscode-tkn=UPSTREAM-TOKEN; Max-Age=604800; SameSite=Lax');
  });
  stubWss.on('connection', (ws, req) => {
    lastUpstreamCookie = req.headers.cookie;
    lastUpstreamForwardedHost = req.headers['x-forwarded-host'] as string | undefined;
    ws.on('message', (data) => ws.send(`echo:${data.toString()}`));
  });
  stubPort = await listen(stub);
  ensureIdeConnectionToken();

  tower = http.createServer((_req, res) => res.end());
  towerWss = new WebSocketServer({ noServer: true });
  towerPort = await listen(tower);
  setupUpgradeHandler(tower, towerWss, towerPort);
});

afterAll(async () => {
  stubWss.close();
  towerWss.close();
  await close(stub);
  await close(tower);
  rmSync(TMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  deleteIdeRecord();
  logLines.length = 0;
  lastUpstreamCookie = undefined;
  lastUpstreamForwardedHost = undefined;
  lastClientSetCookie = undefined;
});

function recordStub(): void {
  writeIdeRecord({ prefix: '/ide/', port: stubPort, serverPath: '/x', pid: 0, startedAt: new Date().toISOString() });
}

describe('IDE WS upgrade with the forward cookie', () => {
  it('a same-origin workbench socket authorizes on the cookie alone and is piped to the IDE server', async () => {
    recordStub();
    const outcome = await connect({ cookie: COOKIE }, `http://localhost:${towerPort}`);
    expect(outcome).toEqual({ kind: 'echo', data: 'echo:hello' });
    // The IDE server sees its own token, never Tower's cookie.
    expect(lastUpstreamCookie).toContain('vscode-tkn=');
    expect(lastUpstreamCookie).not.toContain(IDE_FORWARD_COOKIE);
    // The IDE server is told Tower's own authority, so the workbench's
    // remoteAuthority (and every later socket) targets Tower, not its port.
    expect(lastUpstreamForwardedHost).toBe(`localhost:${towerPort}`);
    // The IDE server's token cookie is stripped from the 101 response.
    expect(lastClientSetCookie).toBeUndefined();
  });

  it('a page on another localhost port cannot ride the cookie (cross-port WS hijack)', async () => {
    recordStub();
    const outcome = await connect({ cookie: COOKIE }, 'http://localhost:3000');
    expect(outcome.kind).toBe('closed');
    expect(lastUpstreamCookie).toBeUndefined();
    const refusal = logLines.find((l) => l.includes('IDE WS upgrade 401'));
    expect(refusal).toContain('cross-origin');
    // S4: the refusal log carries no credential.
    expect(refusal).not.toContain(COOKIE.split('=')[1]);
    expect(refusal).not.toContain(KEY);
  });

  it('Sec-Fetch-Site same-site is refused even with the cookie', async () => {
    recordStub();
    const outcome = await connect({ cookie: COOKIE, 'sec-fetch-site': 'same-site' });
    expect(outcome.kind).not.toBe('echo');
  });

  it('a bare socket with neither header nor cookie is refused', async () => {
    recordStub();
    const outcome = await connect({});
    expect(outcome.kind).not.toBe('echo');
  });

  it('the tunnel-stamped header still passes with a cloud Origin (cloud path unchanged)', async () => {
    recordStub();
    const outcome = await connect({ 'codev-tower-key': KEY, 'x-codev-tunnel-proxy': '1' }, 'https://cloud.codevos.ai');
    expect(outcome).toEqual({ kind: 'echo', data: 'echo:hello' });
  });
});
