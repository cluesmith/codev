/**
 * HTTP/2 Role-Reversal Tunnel Client (Spec 0097 Phase 3, TICK-001)
 *
 * Opens a WebSocket connection to codevos.ai/tunnel, authenticates
 * with JSON messages, then runs an HTTP/2 *server* over the WebSocket
 * stream. codevos.ai acts as the HTTP/2 *client*, sending requests
 * through the tunnel. The tower proxies those requests to localhost.
 *
 * TICK-001: Transport changed from raw TCP/TLS to WebSocket.
 * The H2 role-reversal is transport-agnostic — it works over any duplex stream.
 */

import { randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import http from 'node:http';
import https from 'node:https';
import { Duplex } from 'node:stream';
import { URL } from 'node:url';
import WebSocket, { createWebSocketStream } from 'ws';
import { TOWER_KEY_HEADER, LEGACY_WEB_KEY_HEADER } from '@cluesmith/codev-types';
import { getExpectedKey } from '../utils/server-utils.js';
import { backoffDelayMs } from './reconnect-backoff.js';

export interface TunnelClientOptions {
  serverUrl: string;      // codevos.ai URL (e.g. "https://codevos.ai")
  apiKey: string;         // Tower API key (ctk_...)
  towerId: string;        // Tower ID (confirmed after auth handshake)
  localPort: number;      // localhost port to proxy to (4100)
  /** @deprecated Use serverUrl protocol (ws:// vs wss://) instead */
  tunnelPort?: number;
  /** @deprecated No longer needed — WebSocket handles TLS via wss:// */
  usePlainTcp?: boolean;
}

export type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'auth_failed';

export interface TowerMetadata {
  workspaces: Array<{ path: string; name: string }>;
  terminals: Array<{ id: string; workspacePath: string }>;
}

type StateChangeCallback = (
  state: TunnelState,
  previousState: TunnelState,
  reason?: string
) => void;

/** Headers that must be stripped when proxying between HTTP/2 and HTTP/1.1 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/** Paths that are local-only management endpoints — block from tunnel */
const BLOCKED_PATH_PREFIX = '/api/tunnel/';

/**
 * Matches an `api/tunnel/` segment anywhere in a normalized path, not just at
 * the root (#1370).
 *
 * A root-anchored prefix check misses the workspace-scoped form the dashboard
 * actually uses — `/workspace/<base64url>/api/tunnel/disconnect` — which
 * `handleWorkspaceRoutes` strips and dispatches to the very same
 * `handleTunnelEndpoint`. That path sailed through this blocklist and
 * deregistered the tower.
 */
const BLOCKED_PATH_SEGMENT = /(^|\/)api\/tunnel\//;

/**
 * Header stamped on every request this client proxies in from the cloud (#1370).
 *
 * Requests reaching Tower through the tunnel arrive over localhost, so the
 * socket address alone cannot tell them apart from a genuinely local caller.
 * This marker makes the distinction explicit — Tower uses it both for source
 * attribution in the log and to refuse cloud-originated management calls.
 *
 * Any inbound copy is stripped before stamping, so a cloud-side actor cannot
 * forge or suppress it.
 */
export const TUNNEL_PROXY_HEADER = 'x-codev-tunnel-proxy';

/**
 * Headers this client owns outright: whatever the cloud side sent under these
 * names is dropped before ours is stamped, so none of them can be forged or
 * suppressed from outside (#1586).
 */
const CLIENT_OWNED_HEADERS = new Set([
  TUNNEL_PROXY_HEADER,
  TOWER_KEY_HEADER,
  LEGACY_WEB_KEY_HEADER,
  'host',
]);

/**
 * Rewrite the headers of a tunnel-borne request into what a *local* caller
 * would have sent (#1586).
 *
 * Tower authenticates local actors with the shared local key and rejects any
 * `Host` outside its allowlist (advisory GHSA-xvjp-7748-v88v). A request that
 * arrives through the tunnel carries the cloud edge's `Host` and no key, so
 * without this it is rejected twice over — the Host guard runs even ahead of
 * the public-route allowlist, so every page 401s too, not just the API.
 *
 * The cloud edge has already authenticated the remote user; `TunnelClient`
 * runs inside the Tower process and is itself a local actor, so it
 * legitimately holds the key. Host, key and proxy marker are stamped together
 * here so the three can never drift apart.
 */
function stampLocalHeaders(
  headers: Record<string, string | string[]>,
  localPort: number
): void {
  for (const key of Object.keys(headers)) {
    if (CLIENT_OWNED_HEADERS.has(key.toLowerCase())) delete headers[key];
  }
  headers['Host'] = `localhost:${localPort}`;
  headers[TUNNEL_PROXY_HEADER] = '1';
  // Fails closed: with no local key readable, the request goes on unkeyed and
  // Tower rejects it, exactly as it did before this stamp existed.
  const key = getExpectedKey();
  if (key) headers[TOWER_KEY_HEADER] = key;
}

/** Heartbeat ping interval — send a WebSocket ping every 30 seconds */
export const PING_INTERVAL_MS = 30_000;

/** Pong timeout — if no pong received within 10 seconds, declare connection dead */
export const PONG_TIMEOUT_MS = 10_000;

/**
 * Connect watchdog (#1372) — maximum time the client may sit in `connecting`.
 *
 * Neither the WebSocket handshake nor the auth-response wait has a deadline of
 * its own: `ws` only enforces one when `handshakeTimeout` is passed, and Node
 * applies no socket timeout by default. After an uplink flap a half-open path
 * (stale NAT/conntrack entry) accepts the TCP connection and then goes silent,
 * so no `error` or `close` event ever fires. The heartbeat can't help — it is
 * armed only after `connected`. Without this watchdog the client parks in
 * `connecting` forever and only a brand-new TunnelClient recovers it.
 */
export const CONNECT_TIMEOUT_MS = 20_000;

/**
 * Auth circuit-breaker half-open interval (#1372).
 *
 * `invalid_api_key` used to be terminal, which turns any misclassified auth
 * error during a network blip into a permanent cloud outage. Retrying at a long
 * interval costs one cheap round-trip every 15 minutes; a genuinely revoked key
 * just fails again and re-parks.
 */
export const AUTH_RETRY_INTERVAL_MS = 15 * 60_000;

/**
 * Marks an `auth_failed` transition as a *repeat* park after a half-open retry
 * (#1372). `tower-tunnel.ts` keys its "log the alarm once" rule off this, so it
 * is a shared contract, not a free-form string — do not inline the literal.
 */
export const AUTH_RETRY_FAILED_MARKER = 'half-open retry failed';

/**
 * Calculate reconnection backoff with exponential increase and jitter.
 * Exported for unit testing.
 *
 * Formula: min(1000 * 2^attempt + random(0, 1000), 60000)
 * After 10 consecutive failures: 300000ms (5 min)
 *
 * Thin wrapper over the shared backoff curve (#961). The tunnel keeps its own
 * tuning — 60s cap, 1s jitter, and a 5-minute floor after 10 failures — and its
 * host-side circuit breaker (auth_failed / rate-limit handling stays below).
 */
export function calculateBackoff(attempt: number, randomFn: () => number = Math.random): number {
  return backoffDelayMs(attempt, {
    baseMs: 1000,
    capMs: 60_000,
    jitterMs: 1000,
    floor: { afterAttempts: 10, delayMs: 300_000 },
    random: randomFn,
  });
}

/**
 * Check if a request path should be blocked from tunnel proxying.
 * Normalizes percent-encoding and collapses dot segments before checking,
 * preventing bypass via encoded slashes (%2F), double dots, etc.
 * Exported for unit testing.
 */
export function isBlockedPath(path: string): boolean {
  try {
    // Decode percent-encoding, then resolve dot segments via URL normalization
    const decoded = decodeURIComponent(path);
    // Collapse duplicate slashes and resolve . / .. segments
    const normalized = new URL(decoded, 'http://localhost').pathname;
    return BLOCKED_PATH_SEGMENT.test(normalized);
  } catch {
    // If decoding fails, check the raw path as a fallback (fail closed)
    return path.startsWith(BLOCKED_PATH_PREFIX) || BLOCKED_PATH_SEGMENT.test(path);
  }
}

/**
 * Filter hop-by-hop headers from a headers object.
 * Returns a new object with only end-to-end headers.
 * Exported for unit testing.
 */
export function filterHopByHopHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Make any relay-supplied text safe to log: strip control characters (a
 * newline would otherwise forge a tower log entry) and cap the length (an
 * oversized payload would otherwise inflate the log). Every externally derived
 * string that reaches a state-change reason must pass through here.
 * Exported for testing.
 */
export function sanitizeRemoteDetail(text: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text
    .replace(/[\u0000-\u001f\u007f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .trim();
  return stripped.length > 120 ? `${stripped.slice(0, 120)}…` : stripped;
}

/**
 * Build the WebSocket tunnel URL from the server URL.
 * https:// → wss://, http:// → ws://
 */
function buildTunnelWsUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  const wsProtocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${parsed.host}/tunnel`;
}

export class TunnelClient {
  private options: TunnelClientOptions;
  private state: TunnelState = 'disconnected';
  private connectedAt: number | null = null;
  private stateListeners: StateChangeCallback[] = [];
  private ws: WebSocket | null = null;
  private wsStream: Duplex | null = null;
  private h2Server: http2.Http2Server | null = null;
  private h2Session: http2.ServerHttp2Session | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private rateLimitCount = 0;
  private destroyed = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private pongReceived = false;
  private heartbeatWs: WebSocket | null = null;
  /** Suppresses repeat auth-failure alarms while the breaker half-opens (#1372) */
  private authFailureLogged = false;

  constructor(options: TunnelClientOptions) {
    this.options = options;
  }

  getState(): TunnelState {
    return this.state;
  }

  getUptime(): number | null {
    if (this.state !== 'connected' || this.connectedAt === null) return null;
    return Date.now() - this.connectedAt;
  }

  onStateChange(callback: StateChangeCallback): void {
    this.stateListeners.push(callback);
  }

  private setState(newState: TunnelState, reason?: string): void {
    if (this.state === newState) return;
    const prev = this.state;
    this.state = newState;
    // Leaving `connecting` — the attempt resolved, so disarm its watchdog (#1372)
    if (newState !== 'connecting') this.clearConnectTimeout();
    if (newState === 'connected') {
      this.connectedAt = Date.now();
      this.consecutiveFailures = 0;
      this.rateLimitCount = 0;
      this.authFailureLogged = false;
      // Push cached metadata on connect
      if (this._pendingMetadata) {
        this.pushMetadataViaHttp(this._pendingMetadata);
      }
    } else if (newState === 'disconnected' || newState === 'auth_failed') {
      this.connectedAt = null;
    }
    for (const listener of this.stateListeners) {
      try {
        listener(newState, prev, reason);
      } catch {
        // Ignore listener errors
      }
    }
  }

  /**
   * Initiate tunnel connection. Non-blocking — connection happens asynchronously.
   */
  connect(): void {
    if (this.state === 'connecting' || this.state === 'connected') return;
    this.destroyed = false;
    this.clearReconnectTimer();
    this.doConnect();
  }

  /**
   * Gracefully disconnect the tunnel.
   */
  disconnect(): void {
    this.destroyed = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.cleanup();
    this.setState('disconnected', 'disconnect() called');
  }

  /**
   * Reset the circuit breaker (e.g. after config change).
   * Allows reconnection after auth_failed state.
   */
  resetCircuitBreaker(): void {
    if (this.state === 'auth_failed') {
      this.destroyed = false;
      this.consecutiveFailures = 0;
      this.rateLimitCount = 0;
      this.authFailureLogged = false;
      // Cancelling the pending half-open retry without scheduling a fresh
      // attempt would leave a standalone caller worse off than before, so
      // reconnect here rather than relying on the caller to build a new client.
      this.clearReconnectTimer();
      this.setState('disconnected', 'circuit breaker reset');
      this.scheduleReconnect();
    }
  }

  /**
   * Send tower metadata to codevos.ai.
   *
   * Uses a dual mechanism:
   * 1. Caches metadata for `GET /__tower/metadata` (served when codevos.ai H2 client polls)
   * 2. When connected, proactively POSTs to `serverUrl/api/tower/metadata` via HTTPS
   *
   * Call before `connect()` to set initial metadata, or after to update it.
   */
  sendMetadata(metadata: TowerMetadata): void {
    this._pendingMetadata = metadata;
    // Proactively push via HTTPS when connected
    if (this.state === 'connected') {
      this.pushMetadataViaHttp(metadata);
    }
  }

  /** Stored metadata for serving via GET /__tower/metadata */
  private _pendingMetadata: TowerMetadata | null = null;

  /**
   * Push metadata to codevos.ai via outbound HTTPS POST.
   * Best-effort — failures are silently ignored since codevos.ai
   * can also poll via the H2 tunnel's GET /__tower/metadata handler.
   */
  private pushMetadataViaHttp(metadata: TowerMetadata): void {
    try {
      const url = new URL('/api/tower/metadata', this.options.serverUrl);
      const body = JSON.stringify(metadata);
      const isSecure = url.protocol === 'https:';
      const transport = isSecure ? https : http;

      const req = transport.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.options.apiKey}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        res.resume(); // Drain response
      });

      req.on('error', () => {
        // Best-effort — silently ignore network errors
      });

      req.end(body);
    } catch {
      // Ignore URL construction or other errors
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Schedule the next connect attempt.
   *
   * Callers increment `consecutiveFailures` *before* calling this (#1372).
   * Previously the pong-timeout and close paths incremented first while the
   * error and auth paths incremented after, so the same failure drew a
   * different delay depending on which event happened to surface it — and for
   * a WebSocket an `error` is always followed by a `close`, making that
   * arbitrary. Unified on increment-first (what the majority of paths already
   * did); the error path's first retry moves ~1.5s → ~2.5s.
   */
  private scheduleReconnect(): void {
    if (this.destroyed || this.state === 'auth_failed') return;
    this.clearReconnectTimer();
    const delay = calculateBackoff(this.consecutiveFailures);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed && this.state !== 'auth_failed') {
        this.doConnect();
      }
    }, delay);
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
    this.clearConnectTimeout();

    if (this.h2Session && !this.h2Session.destroyed) {
      this.h2Session.destroy();
    }
    this.h2Session = null;

    if (this.h2Server) {
      this.h2Server.close();
    }
    this.h2Server = null;

    if (this.wsStream) {
      this.wsStream.destroy();
    }
    this.wsStream = null;

    // Detach *before* closing. `close()` on a CONNECTING socket aborts the
    // handshake and emits `error`; `ws` currently defers that via
    // process.nextTick, but if it ever emitted synchronously the handler would
    // still see `ws === this.ws`, run handleConnectionError, and overwrite the
    // caller's reason — the watchdog's "connect timeout" would be swallowed by
    // the same-state check in setState. Nulling first makes every late event
    // from this socket hit the stale guard regardless of when it fires.
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
  }

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.heartbeatWs = ws;

    this.pingInterval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      this.pongReceived = false;
      try {
        ws.ping();
      } catch {
        // ws.ping() can throw if the socket is in a transitional state.
        // Fall through to arm the pong timeout — it will trigger reconnect
        // if the socket remains unresponsive.
      }

      this.pongTimeout = setTimeout(() => {
        if (!this.pongReceived && ws === this.ws) {
          console.warn('Tunnel heartbeat: pong timeout, reconnecting');
          this.cleanup();
          this.consecutiveFailures++;
          this.setState('disconnected', `heartbeat pong timeout after ${PONG_TIMEOUT_MS}ms`);
          this.scheduleReconnect();
        }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    ws.on('pong', () => {
      this.pongReceived = true;
      if (this.pongTimeout) {
        clearTimeout(this.pongTimeout);
        this.pongTimeout = null;
      }
    });
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
    if (this.heartbeatWs) {
      this.heartbeatWs.removeAllListeners('pong');
      this.heartbeatWs = null;
    }
  }

  private doConnect(): void {
    this.setState('connecting', 'connect attempt started');

    // A synchronous throw anywhere in here — `new URL()` on a malformed
    // serverUrl, or the WebSocket constructor — would otherwise leave the
    // client in `connecting` with no watchdog armed, the very wedge this fix
    // exists to prevent. URL construction must stay inside the guard.
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildTunnelWsUrl(this.options.serverUrl));
    } catch (err) {
      this.consecutiveFailures++;
      this.setState('disconnected', `websocket construction failed: ${(err as Error).message}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // Watchdog (#1372): tear down and reschedule any attempt that neither
    // completes the handshake nor answers auth within CONNECT_TIMEOUT_MS.
    // Covers both silent-hang phases — no `error`/`close` event is emitted on
    // a half-open path, so this is the only thing that unsticks `connecting`.
    this.clearConnectTimeout();
    this.connectTimeout = setTimeout(() => {
      this.connectTimeout = null;
      if (ws !== this.ws || this.state !== 'connecting') return;
      console.warn(`Tunnel: connect attempt timed out after ${CONNECT_TIMEOUT_MS}ms, retrying`);
      this.cleanup();
      this.consecutiveFailures++;
      this.setState('disconnected', `connect timeout after ${CONNECT_TIMEOUT_MS}ms`);
      this.scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    ws.on('open', () => {
      this.onWsOpen(ws);
    });

    ws.on('error', (err: Error) => {
      // Ignore events from stale WebSockets (e.g. after disconnect + reconnect)
      if (ws !== this.ws) return;
      this.handleConnectionError(err);
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      // Ignore events from stale WebSockets (e.g. after disconnect + reconnect)
      if (ws !== this.ws) return;
      if (this.state === 'connected' || this.state === 'connecting') {
        const detail = reasonBuf?.length ? `: ${sanitizeRemoteDetail(reasonBuf.toString())}` : '';
        this.cleanup();
        this.consecutiveFailures++;
        this.setState('disconnected', `websocket closed (code ${code}${detail})`);
        this.scheduleReconnect();
      }
    });
  }

  private onWsOpen(ws: WebSocket): void {
    // Ignore a stale socket (e.g. one the connect watchdog already tore down)
    if (ws !== this.ws) return;

    // Send JSON auth message (TICK-001 protocol)
    ws.send(JSON.stringify({ type: 'auth', apiKey: this.options.apiKey }));

    // Wait for auth response
    const onMessage = (data: WebSocket.RawData) => {
      ws.removeListener('message', onMessage);

      // The watchdog tears attempts down mid-flight, so an `auth_ok` queued
      // before cleanup can still arrive here. Without this guard it would
      // resurrect a dead socket: startH2Server() would clobber the h2 handles
      // and flip the state back to `connected` while a reconnect is pending.
      if (ws !== this.ws) return;

      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'auth_ok') {
          this.options.towerId = msg.towerId;
          this.startH2Server(ws);
        } else if (msg.type === 'auth_error') {
          this.handleAuthError(msg.reason || 'unknown');
        } else {
          this.handleConnectionError(
            new Error(`unexpected auth response type: ${sanitizeRemoteDetail(String(msg.type))}`)
          );
        }
      } catch (err) {
        this.handleConnectionError(
          new Error(`invalid auth response: ${sanitizeRemoteDetail(data.toString())}`)
        );
      }
    };

    ws.on('message', onMessage);
  }

  private handleAuthError(reason: string): void {
    this.cleanup();
    this.consecutiveFailures++;

    if (reason === 'invalid_api_key') {
      // A revoked key re-parks here every AUTH_RETRY_INTERVAL_MS. Raise the
      // alarm once; tag later re-parks so the tower logs them quietly instead
      // of crying wolf every 15 minutes.
      const repeat = this.authFailureLogged;
      this.setState(
        'auth_failed',
        repeat
          ? `auth rejected: invalid_api_key (${AUTH_RETRY_FAILED_MARKER})`
          : 'auth rejected: invalid_api_key'
      );
      if (!repeat) {
        this.authFailureLogged = true;
        console.error(
          "Cloud connection failed: API key is invalid or revoked. Run 'afx tower connect --reauth' to update credentials."
        );
      }
      // Circuit breaker: park, but half-open on a long interval (#1372) so a
      // misclassified auth error during a network blip isn't a permanent outage.
      this.scheduleAuthRetry();
      return;
    }

    // Transient errors: rate_limited, internal_error, etc.
    this.setState('disconnected', `auth rejected: ${sanitizeRemoteDetail(reason)}`);

    if (reason === 'rate_limited') {
      this.rateLimitCount++;
      // First rate limit: 60s. Subsequent: 5 minutes (per spec).
      const delay = this.rateLimitCount <= 1 ? 60_000 : 300_000;
      this.clearReconnectTimer();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.destroyed) this.doConnect();
      }, delay);
    } else {
      this.scheduleReconnect();
    }
  }

  /**
   * Half-open the auth circuit breaker (#1372): after AUTH_RETRY_INTERVAL_MS,
   * leave `auth_failed` and try once more. A genuinely revoked key fails again
   * and re-parks here, so the cost is one round-trip per interval.
   */
  private scheduleAuthRetry(): void {
    if (this.destroyed) return;
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.destroyed || this.state !== 'auth_failed') return;
      this.setState('disconnected', 'auth circuit breaker half-open, retrying');
      this.doConnect();
    }, AUTH_RETRY_INTERVAL_MS);
  }

  private handleConnectionError(err: Error): void {
    this.cleanup();
    if (this.state === 'auth_failed') return; // Don't override circuit breaker
    this.consecutiveFailures++;
    // Choke point: some errors originate from the relay (e.g. `ws`'s
    // "Unexpected server response: <status>"), so sanitize here too.
    this.setState('disconnected', `connection error: ${sanitizeRemoteDetail(err.message)}`);
    this.scheduleReconnect();
  }

  private startH2Server(ws: WebSocket): void {
    // Belt and braces alongside the onWsOpen guard — never build h2 state on a
    // socket the client has already moved on from.
    if (ws !== this.ws) return;

    // Convert WebSocket to a Node.js duplex stream
    const wsStream = createWebSocketStream(ws);
    this.wsStream = wsStream;

    // Create an HTTP/2 server (plaintext — TLS is handled by the WebSocket layer)
    // Enable extended CONNECT for WebSocket proxying (RFC 8441)
    const h2Server = http2.createServer({
      settings: { enableConnectProtocol: true },
    });
    this.h2Server = h2Server;

    h2Server.on('session', (session: http2.ServerHttp2Session) => {
      // The session lands a tick later; the attempt may have been torn down since.
      if (ws !== this.ws) {
        session.destroy();
        return;
      }
      this.h2Session = session;
      this.setState('connected', 'h2 session established');
      this.startHeartbeat(ws);
    });

    h2Server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      this.handleH2Stream(stream, headers);
    });

    h2Server.on('error', () => {
      // H2 server error — will be handled by ws close
    });

    // Emit the duplex stream as a connection to the H2 server
    // This is the "role reversal" — the H2 server runs over an outbound WebSocket
    h2Server.emit('connection', wsStream);
  }

  private handleH2Stream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
    const method = headers[':method'] as string;
    const path = headers[':path'] as string;
    const protocol = headers[':protocol'] as string | undefined;

    // Check blocklist
    if (path && isBlockedPath(path)) {
      if (stream.destroyed) return;
      stream.respond({
        ':status': 403,
        'content-type': 'application/json',
      });
      stream.end(JSON.stringify({ error: 'Forbidden: tunnel management endpoints are local-only' }));
      return;
    }

    // Handle metadata requests from the server
    if (method === 'GET' && path === '/__tower/metadata') {
      if (stream.destroyed) return;
      stream.respond({
        ':status': 200,
        'content-type': 'application/json',
      });
      stream.end(JSON.stringify(this._pendingMetadata ?? { workspaces: [], terminals: [] }));
      return;
    }

    // Handle WebSocket CONNECT (RFC 8441)
    if (method === 'CONNECT' && protocol === 'websocket') {
      this.handleWebSocketConnect(stream, headers);
      return;
    }

    // Regular HTTP proxy
    this.proxyHttpRequest(stream, headers, method, path);
  }

  private handleWebSocketConnect(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
    const path = headers[':path'] as string || '/';

    // WebSocket CONNECT: proxy to local server. `stampLocalHeaders` rewrites
    // Host to localhost — Tower's Host guard (advisory GHSA-xvjp-7748-v88v)
    // rejects the tunnel's public authority. The browser's own
    // `Sec-WebSocket-Protocol: codev-key.<KEY>` offer is forwarded untouched
    // and is what authenticates the upgrade.

    // Forward non-hop-by-hop headers from the H2 CONNECT to the local WS upgrade
    const forwardHeaders: Record<string, string | string[]> = {
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
    };
    for (const [key, value] of Object.entries(headers)) {
      if (key.startsWith(':')) continue;
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      if (value !== undefined) {
        forwardHeaders[key] = value as string | string[];
      }
    }
    stampLocalHeaders(forwardHeaders, this.options.localPort);

    // Make HTTP/1.1 WebSocket upgrade request to localhost
    const wsReq = http.request({
      hostname: 'localhost',
      port: this.options.localPort,
      path,
      method: 'GET',
      headers: forwardHeaders,
    });

    wsReq.on('upgrade', (_res, socket, head) => {
      // Respond 200 to the H2 CONNECT
      if (stream.destroyed) { socket.destroy(); return; }
      stream.respond({ ':status': 200 });

      // If there's buffered data from upgrade, push it
      if (head.length > 0) {
        stream.write(head);
      }

      // Bidirectional pipe
      socket.pipe(stream);
      stream.pipe(socket);

      socket.on('error', () => { stream.destroy(); });
      stream.on('error', () => { socket.destroy(); });
      socket.on('close', () => { if (!stream.destroyed) stream.destroy(); });
      stream.on('close', () => { if (!socket.destroyed) socket.destroy(); });
    });

    // Handle non-upgrade responses (e.g. 404 for missing terminal)
    wsReq.on('response', (res) => {
      if (!stream.destroyed) {
        stream.respond({ ':status': res.statusCode || 502 });
        res.pipe(stream);
      }
    });

    wsReq.on('error', () => {
      if (!stream.destroyed) {
        stream.respond({ ':status': 502 });
        stream.end();
      }
    });

    wsReq.end();
  }

  private proxyHttpRequest(
    stream: http2.ServerHttp2Stream,
    h2Headers: http2.IncomingHttpHeaders,
    method: string,
    path: string
  ): void {
    // Build HTTP/1.1 request headers, filtering H2 pseudo-headers and hop-by-hop
    const reqHeaders: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(h2Headers)) {
      if (key.startsWith(':')) continue; // Skip H2 pseudo-headers
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      if (value !== undefined) {
        reqHeaders[key] = value as string | string[];
      }
    }
    stampLocalHeaders(reqHeaders, this.options.localPort);

    const proxyReq = http.request(
      {
        hostname: 'localhost',
        port: this.options.localPort,
        path,
        method,
        headers: reqHeaders,
      },
      (proxyRes) => {
        // Filter hop-by-hop headers from response
        const responseHeaders: Record<string, string | string[] | number> = {
          ':status': proxyRes.statusCode ?? 500,
        };
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase()) && value !== undefined) {
            responseHeaders[key] = value;
          }
        }

        if (stream.destroyed) { proxyRes.resume(); return; }
        stream.respond(responseHeaders);
        proxyRes.pipe(stream);

        proxyRes.on('error', () => {
          if (!stream.destroyed) stream.destroy();
        });
      }
    );

    proxyReq.on('error', () => {
      if (!stream.destroyed) {
        stream.respond({ ':status': 502 });
        stream.end(JSON.stringify({ error: 'Bad Gateway: local server unavailable' }));
      }
    });

    // Pipe request body
    stream.pipe(proxyReq);

    stream.on('error', () => {
      if (!proxyReq.destroyed) proxyReq.destroy();
    });
  }
}
