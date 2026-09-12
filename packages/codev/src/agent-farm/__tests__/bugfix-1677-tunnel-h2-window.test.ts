/**
 * Regression test for #1677 — small RPCs starve behind large transfers on the
 * shared relay↔tower H2 session.
 *
 * Both browser WebSockets (VS Code management + extension-host) are multiplexed
 * as two streams on ONE H2 session between the relay and the tower. With Node's
 * default 64 KB per-stream and connection windows, a large transfer on one
 * stream starves tiny RPCs on the other (head-of-line blocking at the session
 * window): the field trace saw a ~100 B management `resolve` take 39 s while a
 * 1.3 MB upload drained.
 *
 * The fix raises the tower's *inbound* H2 windows — a per-stream
 * `settings.initialWindowSize` and a larger connection window via
 * `session.setLocalWindowSize(...)` — and disables `ws` per-message deflate on
 * the tunnel so large DATA frames don't CPU-starve small outbound frames.
 *
 * These settings are advertised to the peer, so the mock relay (H2 *client*)
 * can read them back directly — a deterministic guard that fails at Node's
 * 65535 B defaults and passes once the windows are raised.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  TunnelClient,
  TUNNEL_H2_STREAM_WINDOW_SIZE,
  TUNNEL_H2_SESSION_WINDOW_SIZE,
} from '../lib/tunnel-client.js';
import { MockTunnelServer } from './helpers/mock-tunnel-server.js';

/** Node's default HTTP/2 flow-control window — the value the bug shipped with. */
const NODE_DEFAULT_H2_WINDOW = 65535;

async function waitFor(fn: () => boolean, timeoutMs = 10000, intervalMs = 25): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function startLocalServer(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') resolve({ server, port: addr.port });
    });
  });
}

describe('bugfix-1677: tunnel H2 flow-control windows', () => {
  let mockServer: MockTunnelServer | undefined;
  let client: TunnelClient | undefined;
  let local: { server: http.Server; port: number } | undefined;

  afterEach(async () => {
    if (client) client.disconnect();
    if (mockServer) await mockServer.stop();
    if (local) await new Promise<void>((resolve) => local!.server.close(() => resolve()));
    mockServer = undefined;
    client = undefined;
    local = undefined;
  });

  async function connect(serverOpts: ConstructorParameters<typeof MockTunnelServer>[0] = {}): Promise<void> {
    local = await startLocalServer();
    mockServer = new MockTunnelServer(serverOpts);
    const port = await mockServer.start();
    client = new TunnelClient({
      serverUrl: `http://127.0.0.1:${port}`,
      apiKey: 'ctk_test_key',
      towerId: '',
      localPort: local.port,
    });
    client.connect();
    await waitFor(() => client!.getState() === 'connected');
  }

  it('advertises a per-stream receive window of at least 1 MiB (not Node default 64 KB)', async () => {
    await connect();
    const session = mockServer!.getLatestH2Session();
    expect(session).toBeDefined();

    // `remoteSettings` are the settings the peer (tower) advertised to the relay.
    // The tower's SETTINGS frame may land a tick after it reports `connected`,
    // so allow a brief settle before reading (mirrors the connection-window test).
    await waitFor(() => (session!.remoteSettings.initialWindowSize ?? 0) !== NODE_DEFAULT_H2_WINDOW, 2000);
    const advertised = session!.remoteSettings.initialWindowSize;
    expect(advertised).toBe(TUNNEL_H2_STREAM_WINDOW_SIZE);
    expect(advertised).toBeGreaterThan(NODE_DEFAULT_H2_WINDOW);
    expect(advertised).toBeGreaterThanOrEqual(1024 * 1024);
  });

  it('raises the connection-level receive window above one stream and Node default', async () => {
    await connect();
    const session = mockServer!.getLatestH2Session();
    expect(session).toBeDefined();

    // On the H2 client, `state.remoteWindowSize` is the space it may send into
    // the tower's connection window — governed by the tower's setLocalWindowSize.
    // The WINDOW_UPDATE lands a tick after connect, so allow a brief settle; a
    // short bound keeps the without-fix case (window stays at the default) a fast
    // failure rather than a full-length timeout.
    await waitFor(() => (session!.state.remoteWindowSize ?? 0) > NODE_DEFAULT_H2_WINDOW, 2000);
    const connectionWindow = session!.state.remoteWindowSize ?? 0;
    expect(connectionWindow).toBeGreaterThan(NODE_DEFAULT_H2_WINDOW);
    expect(connectionWindow).toBeGreaterThanOrEqual(TUNNEL_H2_STREAM_WINDOW_SIZE);
    // Larger than one stream's window so a big transfer cannot consume the whole
    // shared session window and starve a small RPC on the other stream.
    expect(connectionWindow).toBeGreaterThan(TUNNEL_H2_STREAM_WINDOW_SIZE);
  });

  it('does not negotiate per-message deflate on the tunnel even when the relay offers it', async () => {
    // Relay (mock ws server) offers permessage-deflate; the tower's tunnel
    // client must decline it so large DATA frames are not CPU-inflated on the
    // event loop, starving small outbound frames.
    await connect({ perMessageDeflate: true });
    expect(mockServer!.getLatestNegotiatedExtensions()).not.toContain('permessage-deflate');
  });
});
