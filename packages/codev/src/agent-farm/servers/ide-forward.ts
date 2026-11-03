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
import { IDE_DEFAULT_PREFIX, matchIdePrefix, readIdeConnectionToken } from '../lib/ide-record.js';
import { getRecordedIdePort, ensureIdeServerLive } from './ide-server.js';
import { IDE_FORWARD_COOKIE } from '../utils/server-utils.js';

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
 * - `x-forwarded-host` / `-proto` / `-prefix`: only Tower's own stamps reach the
 *   IDE server (Issue #1869); a client copy could steer the workbench's
 *   `remoteAuthority` or base path.
 * - `host`: replaced with the loopback target authority below.
 */
const STRIP_BEFORE_FORWARD = new Set([
  'x-forwarded-port',
  'x-original-host',
  // Tower's own x-forwarded-* stamps are the only ones the IDE server may see
  // (Issue #1869): client-supplied copies are dropped on every path.
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-prefix',
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

/** The connection-token cookie name the VS Code server reads. */
const IDE_TOKEN_COOKIE = 'vscode-tkn';

/**
 * Set the IDE connection token in a Cookie header value as `vscode-tkn=…`,
 * preserving every other cookie. Tower's token REPLACES any incoming
 * `vscode-tkn` (Issue #1869): Tower is the sole legitimate source, so a
 * browser-held copy (a hand-built `?tkn=` URL, a pre-fix session, a token
 * stale after rotation) is never authoritative. Exported for testing.
 */
export function mergeConnectionTokenCookie(existing: string | string[] | undefined, token: string): string {
  const others = stripCookie(existing, IDE_TOKEN_COOKIE);
  const pair = `${IDE_TOKEN_COOKIE}=${token}`;
  return others ? `${others}; ${pair}` : pair;
}

/**
 * Remove one cookie (exact name) from a Cookie header value, preserving every
 * other pair in order. Accepts the string | string[] shape. Returns '' when no
 * pair remains. Used to keep Tower's forward cookie (Issue #1869) away from the
 * IDE server, the way the key header is stripped. Exported for testing.
 */
export function stripCookie(existing: string | string[] | undefined, name: string): string {
  if (existing === undefined) return '';
  const joined = Array.isArray(existing) ? existing.join('; ') : existing;
  return joined
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (pair.length === 0) return false;
      const eq = pair.indexOf('=');
      const pairName = eq < 0 ? pair : pair.slice(0, eq).trim();
      return pairName !== name;
    })
    .join('; ');
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
  connectionToken: string | null,
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

  if (isTunnelBorne(incoming)) {
    if (publicAuthority) {
      out['x-forwarded-host'] = publicAuthority.host;
      out['x-forwarded-proto'] = publicAuthority.proto;
      out['x-forwarded-prefix'] = publicAuthority.prefix;
    }
  } else if (typeof incoming.host === 'string' && incoming.host.length > 0) {
    // Local browser (Issue #1869): the IDE server builds the workbench's
    // `remoteAuthority` from the Host it sees, and the rewrite above makes that
    // its own port, so the workbench would dial the IDE server directly and
    // bypass Tower's forward seam. Stamp Tower's own authority (the incoming
    // Host, already Host-guarded) so the workbench's sockets and remote
    // resources come back through Tower. No prefix: locally `/ide` IS the
    // server's base path.
    out['x-forwarded-host'] = incoming.host;
    out['x-forwarded-proto'] = 'http';
  }

  // Present the IDE server's connection token as a cookie. The server is
  // spawned with `--connection-token-file` and 403s without it, and the
  // browser never holds the token (Tower strips the server's Set-Cookie,
  // Issue #1869), so Tower injects it here on every request (Issue #1668),
  // REPLACING any browser-held `vscode-tkn` and keeping every other cookie.
  // Tower's own forward cookie is stripped first: the IDE server must never
  // see it (Issue #1869).
  const cookie = stripCookie(incoming.cookie, IDE_FORWARD_COOKIE);
  delete out['cookie'];
  if (connectionToken) {
    out['cookie'] = mergeConnectionTokenCookie(cookie, connectionToken);
  } else if (cookie) {
    out['cookie'] = cookie;
  }
  return out;
}

/** True if `pathname` targets the IDE forward prefix; defined beside the prefix constant. */
export { matchIdePrefix };

/**
 * Drop every `vscode-tkn` cookie the IDE server tries to set in the browser
 * (Issue #1869). The server answers an authenticated request with
 * `Set-Cookie: vscode-tkn=<connection token>` (7 days, SameSite=Lax); cookies
 * are not port-scoped, so a browser holding it could open the remote protocol
 * on the IDE server's own port from any localhost page, bypassing Tower. Tower
 * injects the token on every forwarded request, so the browser never needs it.
 * Returns undefined when nothing remains. Exported for testing.
 */
export function stripConnectionTokenSetCookie(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value) ? value : [value];
  const kept = entries.filter((entry) => !new RegExp(`^\\s*${IDE_TOKEN_COOKIE}=`).test(entry));
  return kept.length > 0 ? kept : undefined;
}

/**
 * Copy response headers, dropping hop-by-hop; preserves `Cache-Control` /
 * `ETag`. With `stripTokenCookie` (a LOCAL request, Issue #1869) it also drops
 * the IDE server's `vscode-tkn` Set-Cookie; the tunnel path relays it unchanged
 * (the cloud variant is a separate follow-up). Exported for testing.
 */
export function copyResponseHeaders(
  headers: http.IncomingHttpHeaders,
  stripTokenCookie: boolean,
): Record<string, string | string[] | number> {
  const out: Record<string, string | string[] | number> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (stripTokenCookie && lower === 'set-cookie') {
      const kept = stripConnectionTokenSetCookie(value);
      if (kept) out[key] = kept;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Opening of the workbench configuration the IDE server embeds in its page. */
const WORKBENCH_CONFIG_OPEN = '<meta id="vscode-workbench-web-configuration" data-settings="{';

/** Largest workbench page Tower will buffer to rewrite; anything bigger streams unchanged. */
export const MAX_WORKBENCH_HTML_BYTES = 2 * 1024 * 1024;

/** Only a plain alphanumeric token is ever written into the page. */
const SAFE_TOKEN = /^[A-Za-z0-9-]+$/;

/** Decode the HTML character references the server uses in `data-settings`. */
function decodeAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The decoded `data-settings` JSON object, or null when it does not parse as one. */
function parseSettings(attribute: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(decodeAttribute(attribute));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Hand the workbench its connection token through its own configuration
 * instead of the browser cookie jar (Issue #1869). The workbench takes
 * `connectionToken` from its configuration first and falls back to the
 * `vscode-tkn` cookie, which Tower strips locally because a cookie is readable
 * by every localhost port. Same shape as Tower's same-origin key injection into
 * the dashboard shell: post-auth only, never cross-origin readable.
 *
 * Inserts `"connectionToken":"<token>"` as the first key of the HTML-escaped
 * JSON in `data-settings` (no trailing comma for an empty `{}`). Returns null,
 * so the caller relays the page unchanged, when the token is not
 * `^[A-Za-z0-9-]+$`, the page carries no workbench configuration, the
 * configuration does not parse, it already names a `connectionToken`, or the
 * rewritten configuration would not decode to valid JSON carrying the token.
 * Exported for testing.
 */
export function injectWorkbenchConnectionToken(html: string, token: string): string | null {
  if (!SAFE_TOKEN.test(token)) return null;
  const start = html.indexOf(WORKBENCH_CONFIG_OPEN);
  if (start < 0) return null;
  const valueStart = start + WORKBENCH_CONFIG_OPEN.length - 1; // at the "{"
  const valueEnd = html.indexOf('"', valueStart);
  if (valueEnd < 0) return null;

  const original = html.slice(valueStart, valueEnd);
  const settings = parseSettings(original);
  if (!settings || 'connectionToken' in settings) return null;

  const isEmpty = Object.keys(settings).length === 0;
  const entry = `&quot;connectionToken&quot;:&quot;${token}&quot;`;
  let rewritten = `{${entry},${original.slice(1)}`;
  if (isEmpty) rewritten = `{${entry}}`;

  const check = parseSettings(rewritten);
  if (!check || check.connectionToken !== token) return null;
  return html.slice(0, valueStart) + rewritten + html.slice(valueEnd);
}

/**
 * True for a response Tower may rewrite: 200, uncompressed `text/html`, and not
 * declared larger than the bound. Everything else streams unchanged.
 */
function isRewritableWorkbenchPage(res: http.IncomingMessage): boolean {
  if (res.statusCode !== 200) return false;
  const type = res.headers['content-type'] ?? '';
  if (!type.startsWith('text/html')) return false;
  if (res.headers['content-encoding'] !== undefined) return false;
  const declared = Number(res.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_WORKBENCH_HTML_BYTES) return false;
  return true;
}

/**
 * Buffer a workbench page (up to the bound), inject the connection token, and
 * relay it with a corrected Content-Length. A body that outgrows the bound
 * mid-stream is relayed unchanged: the buffered bytes, then a pipe of the rest.
 */
function relayWorkbenchHtml(proxyRes: http.IncomingMessage, res: http.ServerResponse, token: string): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let streaming = false;

  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    size += chunk.length;
    if (size <= MAX_WORKBENCH_HTML_BYTES) return;
    streaming = true;
    proxyRes.off('data', onData);
    res.writeHead(proxyRes.statusCode ?? 502, copyResponseHeaders(proxyRes.headers, true));
    for (const buffered of chunks) res.write(buffered);
    proxyRes.pipe(res);
  };
  proxyRes.on('data', onData);

  proxyRes.on('end', () => {
    if (streaming) return;
    const original = Buffer.concat(chunks).toString('utf8');
    const rewritten = injectWorkbenchConnectionToken(original, token);
    const body = Buffer.from(rewritten ?? original, 'utf8');
    const out = copyResponseHeaders(proxyRes.headers, true);
    for (const key of Object.keys(out)) {
      const lower = key.toLowerCase();
      if (lower === 'content-length' || lower === 'transfer-encoding') delete out[key];
    }
    out['content-length'] = body.length;
    res.writeHead(proxyRes.statusCode ?? 502, out);
    res.end(body);
  });
  proxyRes.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
    if (!res.writableEnded) res.end();
  });
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
  // Hot path: resolve the target port from the record — no port scan. A dead
  // server fails the connect below, which triggers a respawn (Issue #1668).
  const port = getRecordedIdePort();
  if (port === null) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'IDE server unavailable' }));
    return;
  }

  const connectionToken = readIdeConnectionToken();
  const local = !isTunnelBorne(req.headers);
  const headers = buildForwardHeaders(req.headers, port, getPublicAuthority(), connectionToken);
  const proxyReq = http.request(
    { hostname: '127.0.0.1', port, path: req.url || '/', method: req.method, headers },
    (proxyRes) => {
      // Local only (Issue #1869): the browser gets the token through the
      // workbench configuration, never as a cookie. The tunnel path is unchanged.
      if (local && connectionToken && isRewritableWorkbenchPage(proxyRes)) {
        relayWorkbenchHtml(proxyRes, res, connectionToken);
        return;
      }
      res.writeHead(proxyRes.statusCode ?? 502, copyResponseHeaders(proxyRes.headers, local));
      proxyRes.pipe(res);
      proxyRes.on('error', () => {
        if (!res.writableEnded) res.end();
      });
    },
  );

  proxyReq.on('error', (err) => {
    log('WARN', `IDE HTTP forward error: ${err.message}`);
    onUpstreamConnectError(err, log);
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
 * On a refused/reset upstream connection the recorded server is down. Kick a
 * respawn off the hot path (fire-and-forget) so the next request lands; this
 * request still 502s. The respawn (cold path) is where the `lsof` probe lives.
 */
function onUpstreamConnectError(err: NodeJS.ErrnoException, log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void): void {
  if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
    ensureIdeServerLive(log).catch(() => {});
  }
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
  const port = getRecordedIdePort();
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
  const headers = buildForwardHeaders(req.headers, port, getPublicAuthority(), readIdeConnectionToken());
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
    socket.write(rebuildUpgradeResponse(_upstreamRes, !isTunnelBorne(req.headers)));
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

  upstream.on('error', (err: NodeJS.ErrnoException) => {
    log('WARN', `IDE WS forward error: ${err.message}`);
    onUpstreamConnectError(err, log);
    if (!socket.destroyed) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    }
  });

  upstream.end();
}

/**
 * Reconstruct the HTTP/1.1 101 switching-protocols response line + headers.
 * With `stripTokenCookie` (a LOCAL request) it drops the IDE server's
 * `vscode-tkn` Set-Cookie like the HTTP path does. Exported for testing.
 */
export function rebuildUpgradeResponse(
  res: Pick<http.IncomingMessage, 'statusCode' | 'statusMessage' | 'headers'>,
  stripTokenCookie: boolean,
): string {
  const statusLine = `HTTP/1.1 ${res.statusCode ?? 101} ${res.statusMessage ?? 'Switching Protocols'}`;
  const lines = [statusLine];
  for (const [key, raw] of Object.entries(res.headers)) {
    let value = raw;
    if (stripTokenCookie && key.toLowerCase() === 'set-cookie') value = stripConnectionTokenSetCookie(raw);
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) lines.push(`${key}: ${v}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\r\n') + '\r\n\r\n';
}
