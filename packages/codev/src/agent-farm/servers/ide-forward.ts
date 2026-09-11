/**
 * IDE prefix forward (Issue #1668).
 *
 * Tower forwards a fixed `/ide/` prefix to a single local VS Code server-web
 * process — plain HTTP here and, for the workbench's own remote-protocol
 * sockets, a raw bidirectional WebSocket pipe (Tower never parses those frames;
 * they are VS Code's protocol, not Tower's — see `tower-websocket.ts` for the
 * contrast with the PTY terminal bridge).
 *
 * Authorization is decided upstream by `isForwardAuthorized` (the HTTP path also
 * passes the general `isRequestAllowed` choke point first); this module only
 * proxies, after that decision. Header hygiene and `x-forwarded-*` stamping
 * happen here, strictly after auth (Issue #1668 §D2).
 */

import http from 'node:http';
import type net from 'node:net';
import { URL } from 'node:url';
import { readCloudConfig } from '../lib/cloud-config.js';
import { TUNNEL_PROXY_HEADER } from '../lib/tunnel-client.js';
import { TOWER_KEY_HEADER, LEGACY_WEB_KEY_HEADER } from '@cluesmith/codev-types';
import { IDE_DEFAULT_PREFIX } from '../lib/ide-record.js';
import { ensureIdeServerLive } from './ide-server.js';

/** Hop-by-hop headers not forwarded between connections (RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Headers stripped before forwarding to the IDE server:
 * - `x-forwarded-port` / `x-original-host`: a leaked upstream port makes the
 *   browser dial the wrong WebSocket port, breaking the live session.
 * - `codev-tower-key` / `codev-web-key`: Tower's auth credential — the IDE
 *   server must never see it.
 * - `x-codev-tunnel-proxy`: Tower's tunnel marker — never forwarded, so it
 *   cannot leak or be trusted downstream (marker integrity, #1674).
 * - `host`: replaced with the loopback target authority below.
 */
const STRIP_BEFORE_FORWARD = new Set([
  'x-forwarded-port',
  'x-original-host',
  TOWER_KEY_HEADER,
  LEGACY_WEB_KEY_HEADER,
  TUNNEL_PROXY_HEADER,
  'host',
]);

/** The tunnel's public authority, for stamping `x-forwarded-*` on tunnel-borne requests. */
export interface PublicAuthority {
  host: string;
  proto: string;
  prefix: string;
}

/** True if this request arrived over the tunnel (stamped by `TunnelClient`, #1588). */
function isTunnelBorne(headers: http.IncomingHttpHeaders): boolean {
  return headers[TUNNEL_PROXY_HEADER] === '1';
}

/**
 * Derive the tunnel's public authority from the cloud config, matching the
 * `accessUrl` Tower advertises (`tower-tunnel.ts`: `${server_url}/t/${tower_name}/`).
 * Returns null when the tower is not cloud-registered.
 */
export function getPublicAuthority(): PublicAuthority | null {
  const cfg = readCloudConfig();
  if (!cfg) return null;
  let host: string;
  let proto: string;
  try {
    const url = new URL(cfg.server_url);
    host = url.host;
    proto = url.protocol === 'http:' ? 'http' : 'https';
  } catch {
    return null;
  }
  return { host, proto, prefix: `/t/${cfg.tower_name}${IDE_DEFAULT_PREFIX.replace(/\/$/, '')}` };
}

/**
 * Build the header set forwarded to the IDE server: drop hop-by-hop and
 * Tower-internal headers, set the loopback `Host`, and — only when tunnel-borne
 * — stamp `x-forwarded-host` / `x-forwarded-proto` / `x-forwarded-prefix` from
 * the public authority so the workbench builds correct `remoteAuthority` and
 * base-path URLs and never sees a stale upstream port. Response caching headers
 * (`Cache-Control` / `ETag`) are a RESPONSE concern and preserved separately.
 *
 * Pure and exported for unit testing.
 */
export function buildForwardHeaders(
  incoming: http.IncomingHttpHeaders,
  port: number,
  publicAuthority: PublicAuthority | null,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (STRIP_BEFORE_FORWARD.has(lower)) continue;
    out[key] = value;
  }
  out['host'] = `127.0.0.1:${port}`;

  if (isTunnelBorne(incoming) && publicAuthority) {
    out['x-forwarded-host'] = publicAuthority.host;
    out['x-forwarded-proto'] = publicAuthority.proto;
    out['x-forwarded-prefix'] = publicAuthority.prefix;
  }
  return out;
}

/** True if `pathname` targets the IDE forward prefix (`/ide` or `/ide/…`). */
export function matchIdePrefix(pathname: string): boolean {
  const bare = IDE_DEFAULT_PREFIX.replace(/\/$/, ''); // "/ide"
  return pathname === bare || pathname.startsWith(IDE_DEFAULT_PREFIX);
}

/** Copy response headers, dropping hop-by-hop; preserves `Cache-Control` / `ETag`. */
function copyResponseHeaders(headers: http.IncomingHttpHeaders): Record<string, string | string[] | number> {
  const out: Record<string, string | string[] | number> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Forward a plain HTTP request to the local IDE server. Assumes authorization
 * has already passed. Path and query are forwarded unchanged (the workbench
 * runs with `--server-base-path /ide` and selects the workspace from `?folder=`).
 * A dead / unreachable server yields 502, never a crash.
 */
export async function forwardIdeHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void,
): Promise<void> {
  const port = await ensureIdeServerLive();
  if (port === null) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'IDE server unavailable' }));
    return;
  }

  const headers = buildForwardHeaders(req.headers, port, getPublicAuthority());
  const proxyReq = http.request(
    { hostname: '127.0.0.1', port, path: req.url || '/', method: req.method, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, copyResponseHeaders(proxyRes.headers));
      proxyRes.pipe(res);
      proxyRes.on('error', () => {
        if (!res.writableEnded) res.end();
      });
    },
  );

  proxyReq.on('error', (err) => {
    log('WARN', `IDE HTTP forward error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad Gateway: IDE server unavailable' }));
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  req.pipe(proxyReq);
  req.on('error', () => proxyReq.destroy());
}

/**
 * Forward a WebSocket upgrade to the local IDE server as a raw bidirectional
 * byte pipe. Tower authenticates the upgrade (caller) and then gets out of the
 * way — the workbench speaks VS Code's own remote protocol, which Tower must not
 * parse. Mirrors `tunnel-client.ts handleWebSocketConnect`'s pipe.
 */
export async function forwardIdeWebSocket(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void,
): Promise<void> {
  const port = await ensureIdeServerLive();
  if (port === null) {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
    return;
  }

  // Header hygiene drops the hop-by-hop `Connection`/`Upgrade` pair, so re-add
  // them for the upstream upgrade (as `tunnel-client.ts` does). The client's
  // `Sec-WebSocket-Key` is preserved by `buildForwardHeaders` and forwarded as-is
  // so the upstream's `Sec-WebSocket-Accept` — relayed back verbatim — validates
  // against the client's own key.
  const headers = buildForwardHeaders(req.headers, port, getPublicAuthority());
  headers['Connection'] = 'Upgrade';
  headers['Upgrade'] = 'websocket';
  const upstream = http.request({
    hostname: '127.0.0.1',
    port,
    path: req.url || '/',
    method: 'GET',
    headers,
  });

  upstream.on('upgrade', (_upstreamRes, upstreamSocket, upstreamHead) => {
    // Replay the handshake response and any buffered bytes, then pipe both ways.
    socket.write(rebuildUpgradeResponse(_upstreamRes));
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);

    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);

    const closeBoth = () => {
      if (!socket.destroyed) socket.destroy();
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    };
    socket.on('error', closeBoth);
    upstreamSocket.on('error', closeBoth);
    socket.on('close', closeBoth);
    upstreamSocket.on('close', closeBoth);
  });

  upstream.on('response', (upstreamRes) => {
    // Upstream declined the upgrade (e.g. 404) — relay the status and close.
    socket.write(`HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ''}\r\n\r\n`);
    socket.destroy();
  });

  upstream.on('error', (err) => {
    log('WARN', `IDE WS forward error: ${err.message}`);
    if (!socket.destroyed) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    }
  });

  upstream.end();
}

/** Reconstruct the HTTP/1.1 101 switching-protocols response line + headers. */
function rebuildUpgradeResponse(res: http.IncomingMessage): string {
  const statusLine = `HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}`;
  const lines = [statusLine];
  for (const [key, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${key}: ${v}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\r\n') + '\r\n\r\n';
}
