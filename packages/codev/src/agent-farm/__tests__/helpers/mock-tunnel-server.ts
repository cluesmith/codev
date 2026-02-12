/**
 * Mock Tunnel Server for testing (Spec 0097 Phase 3, TICK-001)
 *
 * Lightweight WebSocket server that implements the codevos.ai tunnel protocol:
 * 1. Accepts WebSocket connections on /tunnel
 * 2. Waits for JSON auth message: { type: "auth", apiKey: "ctk_..." }
 * 3. Responds with { type: "auth_ok", towerId: "..." } or { type: "auth_error", reason: "..." }
 * 4. Converts WebSocket to duplex stream and runs H2 client over it
 *
 * TICK-001: Rewritten from TCP to WebSocket to match codevos.ai server.
 */

import http from 'node:http';
import http2 from 'node:http2';
import { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket, createWebSocketStream } from 'ws';
import type { TowerMetadata } from '../../lib/tunnel-client.js';

export interface MockTunnelServerOptions {
  /** API key to accept. If not set, accepts any key. */
  acceptKey?: string;
  /** Tower ID to return on successful auth */
  towerId?: string;
  /** Force error response instead of OK */
  forceError?: 'invalid_api_key' | 'rate_limited' | 'internal_error' | 'invalid_auth_frame';
  /** Disconnect after auth (before H2) */
  disconnectAfterAuth?: boolean;
}

export interface MockRequestOptions {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export class MockTunnelServer {
  private httpServer: http.Server;
  private wss: WebSocketServer;
  private options: MockTunnelServerOptions;
  private wsConnections: WebSocket[] = [];
  private h2Sessions: http2.ClientHttp2Session[] = [];
  port = 0;

  constructor(options: MockTunnelServerOptions = {}) {
    this.options = {
      towerId: 'test-tower-id',
      ...options,
    };
    // Create an HTTP server for WebSocket upgrade + metadata POST handler
    this.httpServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/tower/metadata') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          try {
            this.lastPushedMetadata = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req, socket, head) => {
      if (req.url === '/tunnel') {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleConnection(ws);
        });
      } else {
        socket.destroy();
      }
    });
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer.address();
        if (addr && typeof addr !== 'string') {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
      this.httpServer.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    // Destroy all H2 sessions
    for (const session of this.h2Sessions) {
      if (!session.destroyed) session.destroy();
    }
    this.h2Sessions = [];

    // Close all WebSocket connections
    for (const ws of this.wsConnections) {
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    }
    this.wsConnections = [];

    return new Promise((resolve) => {
      this.wss.close(() => {
        this.httpServer.close(() => resolve());
      });
    });
  }

  /**
   * Send an HTTP request through the tunnel to the tower.
   * Uses the H2 client session established over the last connection.
   */
  async sendRequest(opts: MockRequestOptions): Promise<MockResponse> {
    const session = this.h2Sessions[this.h2Sessions.length - 1];
    if (!session || session.destroyed) {
      throw new Error('No active H2 session. Is the tunnel connected?');
    }

    return new Promise((resolve, reject) => {
      const h2Headers: Record<string, string> = {
        ':method': opts.method ?? 'GET',
        ':path': opts.path,
        ...(opts.headers ?? {}),
      };

      const req = session.request(h2Headers);
      let status = 0;
      const responseHeaders: Record<string, string | string[]> = {};
      const chunks: Buffer[] = [];

      req.on('response', (headers) => {
        status = headers[':status'] as number;
        for (const [key, value] of Object.entries(headers)) {
          if (!key.startsWith(':') && value !== undefined) {
            responseHeaders[key] = value as string | string[];
          }
        }
      });

      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve({
          status,
          headers: responseHeaders,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });

      req.on('error', reject);

      if (opts.body) {
        req.write(opts.body);
      }
      req.end();
    });
  }

  /**
   * Send a WebSocket CONNECT request through the tunnel.
   * Returns the raw H2 stream for bidirectional communication.
   */
  sendConnect(path: string): http2.ClientHttp2Stream {
    const session = this.h2Sessions[this.h2Sessions.length - 1];
    if (!session || session.destroyed) {
      throw new Error('No active H2 session. Is the tunnel connected?');
    }

    return session.request({
      ':method': 'CONNECT',
      ':path': path,
      ':protocol': 'websocket',
    });
  }

  /** Forcibly disconnect the tunnel (simulates network failure) */
  disconnectAll(): void {
    for (const ws of this.wsConnections) {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
    this.wsConnections = [];
    for (const session of this.h2Sessions) {
      if (!session.destroyed) session.destroy();
    }
    this.h2Sessions = [];
  }

  /** Get the number of active H2 sessions */
  getActiveSessionCount(): number {
    return this.h2Sessions.filter((s) => !s.destroyed).length;
  }

  /** Last received metadata from the tower (fetched via H2 GET /__tower/metadata) */
  lastMetadata: TowerMetadata | null = null;
  /** Last received metadata via outbound HTTP POST /api/tower/metadata */
  lastPushedMetadata: TowerMetadata | null = null;

  private handleConnection(ws: WebSocket): void {
    this.wsConnections.push(ws);

    // Wait for auth message
    const onMessage = (data: WebSocket.RawData) => {
      ws.removeListener('message', onMessage);

      let msg: { type?: string; apiKey?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'auth_error', reason: 'invalid_json' }));
        ws.close();
        return;
      }

      if (msg.type !== 'auth' || !msg.apiKey) {
        ws.send(JSON.stringify({ type: 'auth_error', reason: 'invalid_auth_message' }));
        ws.close();
        return;
      }

      this.handleAuth(ws, msg.apiKey);
    };

    ws.on('message', onMessage);
    ws.on('error', () => {
      // Ignore connection errors in tests
    });
  }

  private handleAuth(ws: WebSocket, apiKey: string): void {
    // Check forced error
    if (this.options.forceError) {
      ws.send(JSON.stringify({ type: 'auth_error', reason: this.options.forceError }));
      if (this.options.forceError !== 'rate_limited') {
        ws.close();
      }
      return;
    }

    // Check API key
    if (this.options.acceptKey && apiKey !== this.options.acceptKey) {
      ws.send(JSON.stringify({ type: 'auth_error', reason: 'invalid_api_key' }));
      ws.close();
      return;
    }

    // Auth success
    ws.send(JSON.stringify({ type: 'auth_ok', towerId: this.options.towerId }));

    if (this.options.disconnectAfterAuth) {
      ws.close();
      return;
    }

    // Convert WebSocket to duplex stream and start H2 client
    this.startH2Client(ws);
  }

  private startH2Client(ws: WebSocket): void {
    const wsStream = createWebSocketStream(ws);

    // Start H2 client over the WebSocket stream
    // Enable extended CONNECT protocol (RFC 8441) for WebSocket proxying
    const h2Session = http2.connect('http://localhost', {
      createConnection: () => wsStream as unknown as Duplex,
      settings: { enableConnectProtocol: true },
    });

    h2Session.on('error', () => {
      // Ignore H2 errors in tests
    });

    this.h2Sessions.push(h2Session);
  }
}
