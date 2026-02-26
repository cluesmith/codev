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

type StateChangeCallback = (state: TunnelState, previousState: TunnelState) => void;

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

/** Heartbeat ping interval — send a WebSocket ping every 30 seconds */
export const PING_INTERVAL_MS = 30_000;

/** Pong timeout — if no pong received within 10 seconds, declare connection dead */
export const PONG_TIMEOUT_MS = 10_000;

/**
 * Calculate reconnection backoff with exponential increase and jitter.
 * Exported for unit testing.
 *
 * Formula: min(1000 * 2^attempt + random(0, 1000), 60000)
 * After 10 consecutive failures: 300000ms (5 min)
 */
export function calculateBackoff(attempt: number, randomFn: () => number = Math.random): number {
  if (attempt >= 10) return 300_000;
  const base = 1000 * Math.pow(2, attempt);
  const jitter = Math.floor(randomFn() * 1000);
  return Math.min(base + jitter, 60_000);
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
    return normalized.startsWith(BLOCKED_PATH_PREFIX);
  } catch {
    // If decoding fails, check the raw path as a fallback (fail closed)
    return path.startsWith(BLOCKED_PATH_PREFIX);
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
  private consecutiveFailures = 0;
  private rateLimitCount = 0;
  private destroyed = false;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private pongReceived = false;
  private heartbeatWs: WebSocket | null = null;

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

  private setState(newState: TunnelState): void {
    if (this.state === newState) return;
    const prev = this.state;
    this.state = newState;
    if (newState === 'connected') {
      this.connectedAt = Date.now();
      this.consecutiveFailures = 0;
      this.rateLimitCount = 0;
      // Push cached metadata on connect
      if (this._pendingMetadata) {
        this.pushMetadataViaHttp(this._pendingMetadata);
      }
    } else if (newState === 'disconnected' || newState === 'auth_failed') {
      this.connectedAt = null;
    }
    for (const listener of this.stateListeners) {
      try {
        listener(newState, prev);
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
    this.setState('disconnected');
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
      this.setState('disconnected');
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

  private scheduleReconnect(): void {
    if (this.destroyed || this.state === 'auth_failed') return;
    const delay = calculateBackoff(this.consecutiveFailures);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed && this.state !== 'auth_failed') {
        this.doConnect();
      }
    }, delay);
  }

  private cleanup(): void {
    this.stopHeartbeat();

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

    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.close();
    }
    this.ws = null;
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
          this.setState('disconnected');
          this.consecutiveFailures++;
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
    this.setState('connecting');

    const wsUrl = buildTunnelWsUrl(this.options.serverUrl);

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.onWsOpen(ws);
    });

    ws.on('error', (err: Error) => {
      // Ignore events from stale WebSockets (e.g. after disconnect + reconnect)
      if (ws !== this.ws) return;
      this.handleConnectionError(err);
    });

    ws.on('close', () => {
      // Ignore events from stale WebSockets (e.g. after disconnect + reconnect)
      if (ws !== this.ws) return;
      if (this.state === 'connected' || this.state === 'connecting') {
        this.cleanup();
        this.setState('disconnected');
        this.consecutiveFailures++;
        this.scheduleReconnect();
      }
    });
  }

  private onWsOpen(ws: WebSocket): void {
    // Send JSON auth message (TICK-001 protocol)
    ws.send(JSON.stringify({ type: 'auth', apiKey: this.options.apiKey }));

    // Wait for auth response
    const onMessage = (data: WebSocket.RawData) => {
      ws.removeListener('message', onMessage);

      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'auth_ok') {
          this.options.towerId = msg.towerId;
          this.startH2Server(ws);
        } else if (msg.type === 'auth_error') {
          this.handleAuthError(msg.reason || 'unknown');
        } else {
          this.handleConnectionError(new Error(`Unexpected auth response type: ${msg.type}`));
        }
      } catch (err) {
        this.handleConnectionError(new Error(`Invalid auth response: ${data.toString()}`));
      }
    };

    ws.on('message', onMessage);
  }

  private handleAuthError(reason: string): void {
    this.cleanup();

    if (reason === 'invalid_api_key') {
      this.setState('auth_failed');
      console.error(
        "Cloud connection failed: API key is invalid or revoked. Run 'af tower connect --reauth' to update credentials."
      );
      // Circuit breaker: don't retry
      return;
    }

    // Transient errors: rate_limited, internal_error, etc.
    this.setState('disconnected');

    if (reason === 'rate_limited') {
      this.rateLimitCount++;
      // First rate limit: 60s. Subsequent: 5 minutes (per spec).
      const delay = this.rateLimitCount <= 1 ? 60_000 : 300_000;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.destroyed) this.doConnect();
      }, delay);
    } else {
      this.scheduleReconnect();
    }
    this.consecutiveFailures++;
  }

  private handleConnectionError(_err: Error): void {
    this.cleanup();
    if (this.state === 'auth_failed') return; // Don't override circuit breaker
    this.setState('disconnected');
    this.scheduleReconnect();
    this.consecutiveFailures++;
  }

  private startH2Server(ws: WebSocket): void {
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
      this.h2Session = session;
      this.setState('connected');
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
    const authority = headers[':authority'] as string || `localhost:${this.options.localPort}`;
    const path = headers[':path'] as string || '/';

    // WebSocket CONNECT: proxy to local server

    // Forward non-hop-by-hop headers from the H2 CONNECT to the local WS upgrade
    const forwardHeaders: Record<string, string | string[]> = {
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
      'Host': authority,
    };
    for (const [key, value] of Object.entries(headers)) {
      if (key.startsWith(':')) continue;
      if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
      if (key.toLowerCase() === 'host') continue; // Already set
      if (value !== undefined) {
        forwardHeaders[key] = value as string | string[];
      }
    }

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
