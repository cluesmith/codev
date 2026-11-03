/**
 * Shared server utilities
 * Extracted from tower-server.ts and open-server.ts
 * to eliminate code duplication (Maintenance Run 0004)
 */

import type * as http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER, LEGACY_WEB_KEY_HEADER, WS_MARKER_PROTOCOL, WS_KEY_PROTOCOL_PREFIX } from '@cluesmith/codev-types';
import { matchIdePrefix } from '../lib/ide-prefix.js';

/**
 * HTML-escape a string to prevent XSS
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Read raw request body as a string with size limit.
 */
export function readBody(req: http.IncomingMessage, maxSize = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Parse JSON body from request with size limit
 * @param req - HTTP incoming message
 * @param maxSize - Maximum body size in bytes (default 1MB)
 */
export function parseJsonBody(req: http.IncomingMessage, maxSize = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk.toString();
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

// ============================================================================
// Request authentication (advisory GHSA-xvjp-7748-v88v)
// ============================================================================
//
// Tower's local HTTP + WebSocket API reaches privileged local operations, so
// every request that is not on the narrow public-route allowlist must present
// the shared local key (`~/.agent-farm/local-key`) in the `codev-tower-key`
// header. Enforcement is server-side only (server/client isolation, #1189):
// clients merely transport the key.

// Wire-contract names (header + WS subprotocols) live in `@cluesmith/codev-types`
// so the server and every client share one source of truth.

/**
 * Cached expected key. `undefined` = not yet loaded; `null` = load failed
 * (fail closed — reject every authenticated request). Tower owns generation,
 * so under normal operation the key file exists after boot.
 */
let cachedExpectedKey: string | null | undefined;

/**
 * The expected local key, cached after first read. Issues the key if missing
 * (Tower is the owner). Returns null and stays fail-closed if the key cannot be
 * read or created (e.g. an unwritable `~/.agent-farm`).
 */
export function getExpectedKey(): string | null {
  if (cachedExpectedKey === undefined) {
    try {
      cachedExpectedKey = ensureLocalKey() || null;
    } catch {
      cachedExpectedKey = null;
    }
  }
  return cachedExpectedKey;
}

/**
 * Reset the cached key. Test-only seam; also lets a future rotation path force
 * a re-read. Not wired to any runtime rotation in this change.
 */
export function resetExpectedKeyCache(): void {
  cachedExpectedKey = undefined;
}

/**
 * Constant-time key comparison. `timingSafeEqual` throws on unequal-length
 * buffers, so length is checked first (a length mismatch is an immediate,
 * non-secret reject).
 */
export function keysMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Routes intentionally reachable without the key. Kept deliberately narrow:
 * pre-auth liveness/version probes, the Tower launcher shell, the React
 * dashboard's static assets (the page loads keyless, then authenticates its
 * own API/WebSocket calls with the key), the annotator shell + vendor files,
 * and the cloud OAuth callback. Everything else requires the key.
 *
 * The entries here are the paths a *browser navigation* reaches — a top-level
 * redirect, an iframe load, a `<script>`/`<link>` tag — none of which can
 * attach the `codev-tower-key` header. Each one therefore carries either no
 * secret or its own credential; adding a route here means proving that.
 *
 * The privileged workspace `file` reader and every `api/` or `ws/` subpath are
 * explicitly excluded so a static-asset carve-out never exposes a data route.
 */
export function isPublicRoute(method: string, pathname: string): boolean {
  if (method !== 'GET') return false;

  if (pathname === '/health') return true;
  if (pathname === '/api/version') return true;
  if (pathname === '/' || pathname === '/index.html') return true;

  // Cloud OAuth callback (#1570). cloud.codevos.ai ends registration by
  // redirecting the browser here, and a cross-site top-level navigation cannot
  // carry the key header — so the key check can only ever 401 the flow. The
  // route is self-authenticating instead: the nonce IS the credential. It is
  // single-use with a 5-minute TTL and can only be minted by an authenticated
  // POST /api/tunnel/connect, and handleTunnelEndpoint 400s ("Invalid or
  // expired registration link") without a valid one, so a keyless request
  // registers nothing. Exact match only — never widen this to an /api/tunnel/
  // prefix, which would expose the keyed status/disconnect routes.
  if (pathname === '/api/tunnel/connect/callback') return true;

  // React SPA served under /workspace/<encoded>/... — static assets only. The
  // trailing subpath is optional: bare /workspace/<enc> serves the SPA shell,
  // same as /workspace/<enc>/ (handleWorkspaceRoutes treats them identically).
  const workspaceMatch = pathname.match(/^\/workspace\/[^/]+(?:\/(.*))?$/);
  if (workspaceMatch) {
    const subPath = workspaceMatch[1] || '';

    // Annotator: its HTML shell and vendor libraries are loaded by iframe
    // navigation and <script>/<link> tags that cannot carry the key header, so
    // they are public (no secret; the shell gets the key injected same-origin).
    // Every data/media sub-route (file, save, api/mtime, api/image, ...) stays
    // keyed — the shell fetches them with the key.
    const annotate = subPath.match(/^api\/annotate\/[^/]+(?:\/(.*))?$/);
    if (annotate) {
      const annotateSub = annotate[1] || '';
      return annotateSub === '' || annotateSub.startsWith('vendor/');
    }

    if (subPath.startsWith('api/') || subPath === 'api') return false;
    if (subPath.startsWith('ws/') || subPath === 'ws') return false;
    if (subPath === 'file') return false;
    return true;
  }

  return false;
}

/**
 * CORS origin allowlist (advisory Layer 3). Replaces the previous
 * reflect-any-`https://` behavior. Allowed: loopback origins on any port
 * (`http://localhost[:port]`, `http://127.0.0.1[:port]`) plus any origins an
 * operator lists in `CODEV_TOWER_ALLOWED_ORIGINS` (comma-separated, exact
 * match) for a tunnel/proxy deployment. Secure by default: no wildcard, no
 * scheme-only reflection. CORS is defense-in-depth; the key check is the
 * actual control.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;

  const configured = process.env.CODEV_TOWER_ALLOWED_ORIGINS;
  if (configured) {
    for (const allowed of configured.split(',')) {
      if (allowed.trim() === origin) return true;
    }
  }
  return false;
}

/** Extract the hostname (no port) from a `Host` header value. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim();
  if (h.startsWith('[')) {
    // IPv6 literal: [::1] or [::1]:port. The remainder after ] must be empty or
    // a :port — otherwise the value is malformed and returned whole (matching
    // nothing on the allowlist) rather than trusting its leading literal.
    const end = h.indexOf(']');
    if (end < 0) return h;
    const rest = h.slice(end + 1);
    if (rest === '' || /^:\d+$/.test(rest)) return h.slice(1, end);
    return h;
  }
  const colon = h.lastIndexOf(':');
  if (colon >= 0 && /^\d+$/.test(h.slice(colon + 1))) {
    return h.slice(0, colon);
  }
  return h;
}

/** True if `hostname` is an IPv4 or IPv6 literal (brackets already stripped). */
function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true; // IPv4
  return hostname.includes(':'); // IPv6 (a DNS name never contains ':')
}

/** True if `hostname` matches a `CODEV_TOWER_ALLOWED_ORIGINS` entry's host. */
function isConfiguredHost(hostname: string): boolean {
  const configured = process.env.CODEV_TOWER_ALLOWED_ORIGINS;
  if (!configured) return false;
  for (const origin of configured.split(',')) {
    try {
      if (new URL(origin.trim()).hostname.toLowerCase() === hostname) return true;
    } catch { /* ignore malformed entry */ }
  }
  return false;
}

/**
 * Host allowlist (advisory GHSA-xvjp-7748-v88v). A DNS-rebinding guard for the
 * key-bearing dashboard shell: the key is injected into the (public) shell, so a
 * browser rebound to Tower's address would carry the attacker's hostname in
 * `Host` and be rejected before the shell is served. Allowed: loopback hostnames
 * and the hostnames of any `CODEV_TOWER_ALLOWED_ORIGINS` (the same var the CORS
 * allowlist uses, so a tunnel/proxy deployment configures both).
 *
 * In BRIDGE_MODE the operator has deliberately exposed Tower on the network, so
 * the allowlist ALSO accepts IP-literal Hosts — a LAN client reaches Tower by IP
 * (`http://192.168.1.5:4100/`), while DNS rebinding requires a host *name*, which
 * stays rejected even in bridge mode. Hostname-based LAN access uses the
 * `CODEV_TOWER_ALLOWED_ORIGINS` escape hatch. The key (mandatory under bridge
 * mode) remains the primary control and is checked separately for keyed routes;
 * this relaxation never weakens it.
 */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const hostname = hostnameOf(hostHeader).toLowerCase();

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  if (isConfiguredHost(hostname)) return true;
  if (process.env.BRIDGE_MODE === '1' && isIpLiteral(hostname)) return true;

  return false;
}

/** Read one header value as a non-empty string, or null. */
function headerValue(raw: string | string[] | undefined): string | null {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0 && raw[0]) return raw[0];
  return null;
}

/**
 * Read the key a client presented on an HTTP request, or null if absent. Prefers
 * the current `codev-tower-key` header and falls back to the legacy
 * `codev-web-key` (dual-accept for one release) so an already-installed client
 * bundling an older sdk still authenticates while it updates.
 */
function presentedHttpKey(req: http.IncomingMessage): string | null {
  return headerValue(req.headers[TOWER_KEY_HEADER]) ?? headerValue(req.headers[LEGACY_WEB_KEY_HEADER]);
}

/**
 * Security: decide whether an HTTP request may proceed.
 *
 * Public-allowlisted routes pass keyless; every other route must present a
 * `codev-tower-key` header that constant-time-matches the expected local key.
 * Fails closed when the expected key is unavailable.
 *
 * @param req - HTTP incoming message
 * @returns true if the request is authorized
 */
export function isRequestAllowed(req: http.IncomingMessage): boolean {
  // Host guard runs first (even for public routes) — the key is injected into the
  // public dashboard shell, so a rebound Host must not reach it.
  if (!isAllowedHost(req.headers.host)) return false;

  const method = req.method || 'GET';
  let pathname = '/';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return false;
  }

  // The IDE forward has its own seam, which also accepts the header-free
  // forward cookie (Issue #1869). Every other route stays header-only.
  if (matchIdePrefix(pathname)) return isForwardAuthorized(req);

  if (isPublicRoute(method, pathname)) return true;

  const expected = getExpectedKey();
  if (!expected) return false;

  const presented = presentedHttpKey(req);
  if (!presented) return false;

  return keysMatch(presented, expected);
}

// ============================================================================
// IDE forward credential (Issue #1869)
// ============================================================================
//
// A browser navigation to `/ide/`, the workbench's asset loads, and its
// `?reconnectionToken=` WebSockets cannot attach the key header, so a loopback
// browser gets a header-free credential for the `/ide` prefix: an HttpOnly,
// SameSite=Strict, Path=/ide cookie minted by the key-gated
// `POST /api/ide/session`.
//
// TRUST: this is a full-trust credential for this machine, scoped by ROUTE, not
// by capability. `/ide/*` is the whole workbench (terminals, files), so holding
// the cookie means running commands as the OS user. Treat it like the key.
//
// It is the first AMBIENT credential Tower accepts (the browser attaches it, not
// key-holding script), so the cookie branch carries a cross-port guard: ports
// are not part of a cookie "site", and any other localhost page could otherwise
// open a cookie-bearing WebSocket into the workbench (CORS does not apply).

/** Name of the forward cookie. Never forwarded to the IDE server. */
export const IDE_FORWARD_COOKIE = 'codev-ide-session';

/**
 * Versioned purpose string for the derivation. Bumping the version invalidates
 * every outstanding cookie without rotating the local key.
 */
const IDE_FORWARD_COOKIE_PURPOSE = 'codev-ide-forward/v1';

/**
 * The forward cookie's expected value: `HMAC-SHA256(localKey, purpose)`, hex.
 * Derived from `getExpectedKey()` on EVERY call (never cached at module load),
 * so the `CODEV_TOWER_KEY` override and `resetExpectedKeyCache()` are honoured
 * and rotating the local key revokes every cookie. That rotation is the only
 * revocation. The value cannot be inverted to the key, so it never grants
 * Tower's API routes. Returns null (fail closed) when the key is unavailable.
 */
export function ideForwardCookieValue(): string | null {
  const key = getExpectedKey();
  if (!key) return null;
  return createHmac('sha256', key).update(IDE_FORWARD_COOKIE_PURPOSE).digest('hex');
}

/** The `Set-Cookie` value `POST /api/ide/session` returns, or null when the key is unavailable. */
export function ideForwardSetCookie(): string | null {
  const value = ideForwardCookieValue();
  if (!value) return null;
  // No `Secure`: loopback is plain HTTP. No `Max-Age`: a browser-session cookie.
  // `__Host-` is not usable: it forces `Path=/`, which would widen the scope.
  return `${IDE_FORWARD_COOKIE}=${value}; Path=/ide; HttpOnly; SameSite=Strict`;
}

/**
 * Read one cookie's value from a `Cookie` header (string or string[] shape), or
 * null if absent. Exact-name match: `codev-ide-session2` is not `codev-ide-session`.
 */
export function cookieValue(header: string | string[] | undefined, name: string): string | null {
  if (header === undefined) return null;
  const joined = Array.isArray(header) ? header.join('; ') : header;
  for (const pair of joined.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== name) continue;
    const value = pair.slice(eq + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}

/** True if `origin` is exactly an entry of `CODEV_TOWER_ALLOWED_ORIGINS`. */
function isConfiguredOrigin(origin: string): boolean {
  const configured = process.env.CODEV_TOWER_ALLOWED_ORIGINS;
  if (!configured) return false;
  for (const allowed of configured.split(',')) {
    if (allowed.trim() === origin) return true;
  }
  return false;
}

/**
 * Cross-port guard for the forward cookie (Issue #1869). A cookie-authorized
 * request may proceed only when it is not initiated by another origin:
 * - `Origin`, if present, must be this request's own origin
 *   (`http(s)://<Host>`) or an exact `CODEV_TOWER_ALLOWED_ORIGINS` entry;
 * - `Sec-Fetch-Site`, if present, must be `same-origin` or `none`
 *   (`same-site` is exactly the other-localhost-port case and is refused).
 * A request with neither header passes: top-level navigations and same-origin
 * asset GETs may omit them, while browsers always send `Origin` on WebSocket
 * upgrades and cross-origin fetches, which is the set this must refuse.
 * Applied ONLY to the cookie branch; the key-header branch never calls it.
 */
export function isSameOriginForwardRequest(req: http.IncomingMessage): boolean {
  const origin = headerValue(req.headers.origin);
  if (origin !== null) {
    const host = (req.headers.host ?? '').trim().toLowerCase();
    const lowered = origin.toLowerCase();
    const ownOrigin = host.length > 0 && (lowered === `http://${host}` || lowered === `https://${host}`);
    if (!ownOrigin && !isConfiguredOrigin(origin)) return false;
  }

  const fetchSite = headerValue(req.headers['sec-fetch-site']);
  if (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;

  return true;
}

/** Outcome of the forward authorization decision, with a log-safe reason on refusal. */
export type ForwardAuthDecision =
  | { allowed: true; via: 'header' | 'cookie' }
  | { allowed: false; reason: string };

/**
 * Security: decide whether a request may proceed to the IDE prefix forward
 * (Issue #1668). This is the ONE authorization seam for the forward: the HTTP
 * path (`isRequestAllowed` delegates every `/ide*` path here) and the WebSocket
 * upgrade both call it.
 *
 * Fixed order:
 * 1. Host guard (DNS rebinding).
 * 2. Key header (`codev-tower-key` / legacy `codev-web-key`), constant-time.
 *    This is what `TunnelClient.stampLocalHeaders` stamps on every tunnel-borne
 *    request (#1588), so the cloud path authorizes here, with no origin check
 *    (a cloud browser's `Origin` is the cloud host, never Tower's).
 * 3. Forward cookie (Issue #1869), constant-time, AND the cross-port guard.
 *
 * There is deliberately NO per-folder logic: the IDE server offers no per-folder
 * isolation, so authorization is a whole-boundary decision (Issue #1668 §D2).
 * This is the swap point for #1589 (per-session remote credential). Fails closed
 * when the expected key is unavailable. Reasons never contain credential values.
 */
export function decideForwardAuthorization(req: http.IncomingMessage): ForwardAuthDecision {
  if (!isAllowedHost(req.headers.host)) {
    return { allowed: false, reason: `disallowed Host "${req.headers.host ?? ''}"` };
  }

  const expected = getExpectedKey();
  if (!expected) return { allowed: false, reason: 'local key unavailable' };

  const presented = presentedHttpKey(req);
  if (presented && keysMatch(presented, expected)) return { allowed: true, via: 'header' };

  const expectedCookie = ideForwardCookieValue();
  const presentedCookie = cookieValue(req.headers.cookie, IDE_FORWARD_COOKIE);
  if (expectedCookie && presentedCookie && keysMatch(presentedCookie, expectedCookie)) {
    if (!isSameOriginForwardRequest(req)) {
      return { allowed: false, reason: 'forward cookie refused: cross-origin request' };
    }
    return { allowed: true, via: 'cookie' };
  }

  return { allowed: false, reason: 'missing or invalid credential' };
}

/** Boolean form of `decideForwardAuthorization`. */
export function isForwardAuthorized(req: http.IncomingMessage): boolean {
  return decideForwardAuthorization(req).allowed;
}

/**
 * Extract the presented key from a WebSocket upgrade's `Sec-WebSocket-Protocol`
 * offer (the `codev-key.<KEY>` token), or null if absent/malformed.
 */
function presentedWsKey(req: http.IncomingMessage): string | null {
  const raw = req.headers['sec-websocket-protocol'];
  if (!raw) return null;
  const offered = (Array.isArray(raw) ? raw.join(',') : raw)
    .split(',')
    .map((p) => p.trim());
  for (const proto of offered) {
    if (proto.startsWith(WS_KEY_PROTOCOL_PREFIX)) {
      const key = proto.slice(WS_KEY_PROTOCOL_PREFIX.length);
      return key.length > 0 ? key : null;
    }
  }
  return null;
}

/**
 * The subprotocol the server echoes back on a terminal WebSocket handshake:
 * the non-secret marker if the client offered it, else none. NEVER echoes the
 * `codev-key.<key>` token — echoing it would leak the key into a response
 * header. Used as the `ws` server's `handleProtocols` (advisory
 * GHSA-xvjp-7748-v88v). Exported so the echo contract is unit-testable.
 */
export function selectWsSubprotocol(offered: Set<string>): string | false {
  return offered.has(WS_MARKER_PROTOCOL) ? WS_MARKER_PROTOCOL : false;
}

/**
 * Security: decide whether a WebSocket upgrade may proceed. Validated at the
 * handshake (before any PTY attach), independent of the `Origin` header so a
 * missing Origin can never degrade into an auth bypass. Fails closed when the
 * expected key is unavailable.
 *
 * @param req - HTTP upgrade request
 * @returns true if the upgrade is authorized
 */
export function isWebSocketAllowed(req: http.IncomingMessage): boolean {
  if (!isAllowedHost(req.headers.host)) return false;

  const expected = getExpectedKey();
  if (!expected) return false;

  const presented = presentedWsKey(req);
  if (!presented) return false;

  return keysMatch(presented, expected);
}
/**
 * Validate a bind host value for server.listen().
 *
 * Accepts 127.0.0.1, 0.0.0.0, localhost, valid IPv4, and bracketed IPv6.
 * Returns the validated host string, or throws on invalid input.
 *
 * Used by tower-server.ts to resolve BRIDGE_TOWER_HOST when BRIDGE_MODE=1.
 *
 * @param host - The bind host string (e.g., from BRIDGE_TOWER_HOST env var)
 * @returns The validated/trimmed host string
 * @throws Error with a clear message if the host is invalid
 */
export function validateHost(host: string): string {
  if (!host || host.trim().length === 0) {
    throw new Error(
      'Invalid bind host "". ' +
        'Accepted values: 127.0.0.1 (default), 0.0.0.0, localhost, ' +
        'or a valid IPv4/IPv6 literal.',
    );
  }
  const h = host.trim();

  // Allow common literals
  if (h === '127.0.0.1' || h === '0.0.0.0' || h === 'localhost') {
    return h;
  }

  // IPv4: four octets 0-255
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    if (parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
      return h;
    }
  }

  // Bracketed IPv6 (e.g., [::1], [::])
  if (/^\[[0-9a-fA-F:]+\]$/.test(h)) {
    return h;
  }

  throw new Error(
    `Invalid bind host "${h}". ` +
      'Accepted values: 127.0.0.1 (default), 0.0.0.0, localhost, ' +
      'or a valid IPv4/IPv6 literal.',
  );
}
