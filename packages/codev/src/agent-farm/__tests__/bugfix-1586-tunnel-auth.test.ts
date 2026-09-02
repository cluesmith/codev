/**
 * Regression: #1586 — cloud-proxied requests are 401'd by the local Tower.
 *
 * Second half of the #1421 auth regression. A request arriving through the
 * tunnel carried the cloud edge's `Host: cloud.codevos.ai` verbatim and no
 * local key, so Tower rejected it twice over: the Host guard runs even ahead
 * of the public-route allowlist (so `GET /` 401s too), and every keyed route
 * has no key to check.
 *
 * These tests run the REAL `isRequestAllowed` in the local server, so they pin
 * authorization end-to-end rather than merely asserting header shapes.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import http from 'node:http';
import { MockTunnelServer } from './helpers/mock-tunnel-server.js';
import { TunnelClient } from '../lib/tunnel-client.js';

const TEST_KEY = 'b'.repeat(64);

vi.mock('@cluesmith/codev-core/auth', () => ({
  ensureLocalKey: vi.fn(() => TEST_KEY),
  readLocalKey: vi.fn(() => TEST_KEY),
}));

import { isRequestAllowed, resetExpectedKeyCache } from '../utils/server-utils.js';

/** The public authority the cloud edge puts on tunnel-borne requests. */
const CLOUD_HOST = 'cloud.codevos.ai';

async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function startServer(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') resolve(addr.port);
    });
  });
}

async function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * A stand-in for Tower: enforces the real auth guard, then echoes what it saw.
 * `/api/state` is a keyed route; `/` is on the public allowlist but still
 * subject to the Host guard.
 */
function createGuardedServer(): http.Server {
  return http.createServer((req, res) => {
    if (!isRequestAllowed(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', host: req.headers.host }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  });
}

describe('#1586 tunnel-borne request authentication', () => {
  let mockServer: MockTunnelServer;
  let localServer: http.Server;
  let client: TunnelClient;

  beforeEach(() => {
    resetExpectedKeyCache();
  });

  afterEach(async () => {
    if (client) client.disconnect();
    if (mockServer) await mockServer.stop();
    if (localServer) await stopServer(localServer);
    vi.restoreAllMocks();
  });

  async function connect(server: http.Server): Promise<void> {
    localServer = server;
    const localPort = await startServer(server);
    mockServer = new MockTunnelServer();
    const port = await mockServer.start();
    client = new TunnelClient({
      serverUrl: `http://127.0.0.1:${port}`,
      apiKey: 'ctk_test_key',
      towerId: '',
      localPort,
    });
    client.connect();
    await waitFor(() => client.getState() === 'connected');
  }

  it('authorizes a keyed API route that arrives with the cloud Host and no key', async () => {
    await connect(createGuardedServer());

    const response = await mockServer.sendRequest({
      path: '/api/state',
      headers: { host: CLOUD_HOST },
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.headers.host).toMatch(/^localhost:\d+$/);
    expect(body.headers['codev-tower-key']).toBe(TEST_KEY);
  });

  it('authorizes the public dashboard shell, which the Host guard also rejected', async () => {
    await connect(createGuardedServer());

    const response = await mockServer.sendRequest({ path: '/', headers: { host: CLOUD_HOST } });

    expect(response.status).toBe(200);
  });

  it('replaces a key forged by the cloud side rather than passing it through', async () => {
    await connect(createGuardedServer());

    const response = await mockServer.sendRequest({
      path: '/api/state',
      headers: {
        host: CLOUD_HOST,
        'codev-tower-key': 'forged-key',
        'codev-web-key': 'forged-legacy-key',
        'x-codev-tunnel-proxy': 'forged-marker',
      },
    });

    expect(response.status).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.headers['codev-tower-key']).toBe(TEST_KEY);
    expect(body.headers['codev-web-key']).toBeUndefined();
    expect(body.headers['x-codev-tunnel-proxy']).toBe('1');
  });

  it('still refuses tunnel management endpoints, keyed or not', async () => {
    await connect(createGuardedServer());

    const enc = Buffer.from('/Users/me/proj').toString('base64url');
    for (const path of ['/api/tunnel/disconnect', `/workspace/${enc}/api/tunnel/disconnect`]) {
      const response = await mockServer.sendRequest({
        method: 'POST',
        path,
        headers: { host: CLOUD_HOST },
      });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body).error).toContain('local-only');
    }
  });

  it('forwards the browser codev-key subprotocol untouched through the WebSocket upgrade', async () => {
    let seen: http.IncomingHttpHeaders = {};
    const sockets: import('node:net').Socket[] = [];
    const wsServer = http.createServer();
    wsServer.on('upgrade', (req, socket) => {
      seen = req.headers;
      sockets.push(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      socket.resume();
      socket.on('error', () => {});
    });

    try {
      await connect(wsServer);

      // HTTP/2 CONNECT carries the authority as `:authority`, not a `host`
      // header — Node rejects the latter on a CONNECT stream.
      const stream = mockServer.sendConnect('/ws/terminal/test', {
        'sec-websocket-protocol': `codev-key.${TEST_KEY}`,
      });

      await new Promise<void>((resolve, reject) => {
        stream.on('response', (headers) => {
          expect(headers[':status']).toBe(200);
          resolve();
        });
        stream.on('error', reject);
        setTimeout(() => reject(new Error('CONNECT timeout')), 5000);
      });

      // The key travels in the subprotocol offer, which is what `isWebSocketAllowed`
      // reads — it must survive the H2 CONNECT → localhost upgrade verbatim.
      expect(seen['sec-websocket-protocol']).toBe(`codev-key.${TEST_KEY}`);
      expect(seen.host).toMatch(/^localhost:\d+$/);
      stream.destroy();
    } finally {
      for (const s of sockets) if (!s.destroyed) s.destroy();
    }
  });
});
