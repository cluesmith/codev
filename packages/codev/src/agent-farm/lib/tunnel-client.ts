/**
 * HTTP/2 Role-Reversal Tunnel Client (Spec 0097 Phase 3)
 *
 * Opens an outbound TLS connection to codevos.ai, authenticates,
 * then runs an HTTP/2 *server* over that connection. codevos.ai
 * acts as the HTTP/2 *client*, sending requests through the tunnel.
 * The tower proxies those requests to localhost.
 *
 * Uses only Node.js built-in modules: node:http2, node:tls, node:net, node:http
 */

import http2 from 'node:http2';
import tls from 'node:tls';
import net from 'node:net';
import http from 'node:http';
import { URL } from 'node:url';

export interface TunnelClientOptions {
  serverUrl: string;      // codevos.ai URL (e.g. "https://codevos.ai")
  tunnelPort: number;     // Tunnel server port (default: 4200)
  apiKey: string;         // Tower API key (ctk_...)
  towerId: string;        // Tower ID (confirmed after auth handshake)
  localPort: number;      // localhost port to proxy to (4100)
  /** Use plain TCP instead of TLS (for tests only) */
  usePlainTcp?: boolean;
}

export type TunnelState = 'disconnected' | 'connecting' | 'connected' | 'auth_failed';

export interface TowerMetadata {
  projects: Array<{ path: string; name: string }>;
  terminals: Array<{ id: string; projectPath: string }>;
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
 * Exported for unit testing.
 */
export function isBlockedPath(path: string): boolean {
  return path.startsWith(BLOCKED_PATH_PREFIX);
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

export class TunnelClient {
  private options: TunnelClientOptions;
  private state: TunnelState = 'disconnected';
  private connectedAt: number | null = null;
  private stateListeners: StateChangeCallback[] = [];
  private socket: net.Socket | tls.TLSSocket | null = null;
  private h2Server: http2.Http2Server | null = null;
  private h2Session: http2.ServerHttp2Session | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private destroyed = false;

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
    if (this.destroyed) return;
    if (this.state === 'connecting' || this.state === 'connected') return;
    this.clearReconnectTimer();
    this.doConnect();
  }

  /**
   * Gracefully disconnect the tunnel.
   */
  disconnect(): void {
    this.destroyed = true;
    this.clearReconnectTimer();
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
      this.setState('disconnected');
    }
  }

  /**
   * Send tower metadata to codevos.ai through the tunnel.
   *
   * Stores metadata for two delivery mechanisms:
   * 1. Initial push: written as META <json>\n on the socket during the
   *    auth handshake (before H2 takes over). Sent automatically on connect.
   * 2. On-demand: served via GET /__tower/metadata when the H2 client polls.
   *
   * Call this before connect() to set initial metadata, or after connect()
   * to update it (will be served on next GET /__tower/metadata poll).
   */
  sendMetadata(metadata: TowerMetadata): void {
    this._pendingMetadata = metadata;
  }

  /** Stored metadata for serving via GET /__tower/metadata and initial push */
  private _pendingMetadata: TowerMetadata | null = null;

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
    if (this.h2Session && !this.h2Session.destroyed) {
      this.h2Session.destroy();
    }
    this.h2Session = null;

    if (this.h2Server) {
      this.h2Server.close();
    }
    this.h2Server = null;

    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }

  private doConnect(): void {
    this.setState('connecting');

    const hostname = new URL(this.options.serverUrl).hostname;
    const port = this.options.tunnelPort;

    let socket: net.Socket | tls.TLSSocket;

    if (this.options.usePlainTcp) {
      socket = net.connect({ host: hostname, port }, () => {
        this.onSocketConnected(socket);
      });
    } else {
      socket = tls.connect({ host: hostname, port, servername: hostname }, () => {
        this.onSocketConnected(socket);
      });
    }

    this.socket = socket;

    socket.on('error', (err: Error) => {
      this.handleConnectionError(err);
    });

    socket.on('close', () => {
      if (this.state === 'connected' || this.state === 'connecting') {
        this.cleanup();
        this.setState('disconnected');
        this.scheduleReconnect();
        this.consecutiveFailures++;
      }
    });
  }

  private onSocketConnected(socket: net.Socket | tls.TLSSocket): void {
    // Send auth frame: AUTH <apiKey>\n
    const authFrame = `AUTH ${this.options.apiKey}\n`;
    socket.write(authFrame);

    // Wait for response line
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return; // Wait for complete line

      socket.removeListener('data', onData);
      const response = buffer.slice(0, newlineIdx).trim();
      const remaining = buffer.slice(newlineIdx + 1);

      if (response.startsWith('OK ')) {
        const towerId = response.slice(3);
        this.options.towerId = towerId;
        // Push initial metadata before H2 takes over the socket.
        // Protocol: META <json>\n — consumed by tunnel server before
        // it starts the H2 client session.
        const metadata = this._pendingMetadata ?? { projects: [], terminals: [] };
        socket.write(`META ${JSON.stringify(metadata)}\n`);
        this.startH2Server(socket, remaining);
      } else if (response.startsWith('ERR ')) {
        const reason = response.slice(4);
        this.handleAuthError(reason);
      } else {
        this.handleConnectionError(new Error(`Unexpected auth response: ${response}`));
      }
    };

    socket.on('data', onData);
  }

  private handleAuthError(reason: string): void {
    this.cleanup();

    if (reason === 'invalid_api_key') {
      this.setState('auth_failed');
      console.error(
        "Cloud connection failed: API key is invalid or revoked. Run 'af tower register --reauth' to update credentials."
      );
      // Circuit breaker: don't retry
      return;
    }

    // Transient errors: rate_limited, internal_error, etc.
    this.setState('disconnected');

    if (reason === 'rate_limited') {
      // Wait 60 seconds for rate limiting
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.destroyed) this.doConnect();
      }, 60_000);
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

  private startH2Server(socket: net.Socket | tls.TLSSocket, extraData: string): void {
    // Create an HTTP/2 server (without TLS — TLS is on the outer socket)
    // Enable extended CONNECT for WebSocket proxying (RFC 8441)
    const h2Server = http2.createServer({
      settings: { enableConnectProtocol: true },
    });
    this.h2Server = h2Server;

    h2Server.on('session', (session: http2.ServerHttp2Session) => {
      this.h2Session = session;
      this.setState('connected');
    });

    h2Server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
      this.handleH2Stream(stream, headers);
    });

    h2Server.on('error', () => {
      // H2 server error — will be handled by socket close
    });

    // Emit the socket as a connection to the H2 server
    // This is the "role reversal" — the H2 server runs over an outbound socket
    h2Server.emit('connection', socket);

    // If there was any extra data after the auth response, push it back
    if (extraData.length > 0) {
      socket.unshift(Buffer.from(extraData, 'utf-8'));
    }
  }

  private handleH2Stream(stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders): void {
    const method = headers[':method'] as string;
    const path = headers[':path'] as string;
    const protocol = headers[':protocol'] as string | undefined;

    // Check blocklist
    if (path && isBlockedPath(path)) {
      stream.respond({
        ':status': 403,
        'content-type': 'application/json',
      });
      stream.end(JSON.stringify({ error: 'Forbidden: tunnel management endpoints are local-only' }));
      return;
    }

    // Handle metadata requests from the server
    if (method === 'GET' && path === '/__tower/metadata') {
      stream.respond({
        ':status': 200,
        'content-type': 'application/json',
      });
      stream.end(JSON.stringify(this._pendingMetadata ?? { projects: [], terminals: [] }));
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

    // Make HTTP/1.1 WebSocket upgrade request to localhost
    const wsReq = http.request({
      hostname: 'localhost',
      port: this.options.localPort,
      path,
      method: 'GET',
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(Math.random().toString()).toString('base64'),
        'Host': authority,
      },
    });

    wsReq.on('upgrade', (_res, socket, head) => {
      // Respond 200 to the H2 CONNECT
      stream.respond({ ':status': 200 });

      // If there's buffered data from upgrade, push it
      if (head.length > 0) {
        stream.write(head);
      }

      // Bidirectional pipe
      socket.pipe(stream);
      stream.pipe(socket);

      socket.on('error', () => stream.destroy());
      stream.on('error', () => socket.destroy());
      socket.on('close', () => { if (!stream.destroyed) stream.destroy(); });
      stream.on('close', () => { if (!socket.destroyed) socket.destroy(); });
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
