/**
 * Mock Tunnel Server for testing (Spec 0097 Phase 3)
 *
 * Lightweight TCP server that implements the codevos.ai tunnel protocol:
 * 1. Accepts AUTH <key>\n
 * 2. Responds with OK <id>\n or ERR <reason>\n
 * 3. Runs H2 client over the connection to send requests to the tower
 *
 * Uses plain TCP (no TLS) for test simplicity.
 */

import net from 'node:net';
import http2 from 'node:http2';
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
  private server: net.Server;
  private options: MockTunnelServerOptions;
  private connections: net.Socket[] = [];
  private h2Sessions: http2.ClientHttp2Session[] = [];
  port = 0;

  constructor(options: MockTunnelServerOptions = {}) {
    this.options = {
      towerId: 'test-tower-id',
      ...options,
    };
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address();
        if (addr && typeof addr !== 'string') {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error('Failed to get server address'));
        }
      });
      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    // Destroy all H2 sessions
    for (const session of this.h2Sessions) {
      if (!session.destroyed) session.destroy();
    }
    this.h2Sessions = [];

    // Destroy all connections
    for (const conn of this.connections) {
      if (!conn.destroyed) conn.destroy();
    }
    this.connections = [];

    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /**
   * Send an HTTP request through the tunnel to the tower.
   * Uses the H2 client session established over the first connection.
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
    for (const conn of this.connections) {
      if (!conn.destroyed) conn.destroy();
    }
    this.connections = [];
    for (const session of this.h2Sessions) {
      if (!session.destroyed) session.destroy();
    }
    this.h2Sessions = [];
  }

  /** Get the number of active H2 sessions */
  getActiveSessionCount(): number {
    return this.h2Sessions.filter((s) => !s.destroyed).length;
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.push(socket);

    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;

      socket.removeListener('data', onData);
      const line = buffer.slice(0, newlineIdx).trim();
      const remaining = buffer.slice(newlineIdx + 1);

      this.handleAuth(socket, line, remaining);
    };

    socket.on('data', onData);
    socket.on('error', () => {
      // Ignore connection errors in tests
    });
  }

  private handleAuth(socket: net.Socket, authLine: string, remaining: string): void {
    // Parse AUTH <key>
    if (!authLine.startsWith('AUTH ')) {
      socket.write('ERR invalid_auth_frame\n');
      socket.destroy();
      return;
    }

    const apiKey = authLine.slice(5);

    // Check forced error
    if (this.options.forceError) {
      socket.write(`ERR ${this.options.forceError}\n`);
      if (this.options.forceError !== 'rate_limited') {
        socket.destroy();
      }
      return;
    }

    // Check API key
    if (this.options.acceptKey && apiKey !== this.options.acceptKey) {
      socket.write('ERR invalid_api_key\n');
      socket.destroy();
      return;
    }

    // Auth success
    socket.write(`OK ${this.options.towerId}\n`);

    if (this.options.disconnectAfterAuth) {
      socket.destroy();
      return;
    }

    // Read the META frame that the tower sends after auth
    this.readMetaFrame(socket, remaining);
  }

  /** Last received metadata from the tower */
  lastMetadata: TowerMetadata | null = null;

  private readMetaFrame(socket: net.Socket, initial: string): void {
    let buffer = initial;

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf-8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;

      socket.removeListener('data', onData);
      const line = buffer.slice(0, newlineIdx).trim();
      const remaining = buffer.slice(newlineIdx + 1);

      // Parse META <json>
      if (line.startsWith('META ')) {
        try {
          this.lastMetadata = JSON.parse(line.slice(5)) as TowerMetadata;
        } catch {
          // Ignore parse errors in tests
        }
      }

      // Push back remaining data for H2
      if (remaining.length > 0) {
        socket.unshift(Buffer.from(remaining, 'utf-8'));
      }

      this.startH2Client(socket);
    };

    // Check if META is already in buffer
    const newlineIdx = buffer.indexOf('\n');
    if (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      const remaining = buffer.slice(newlineIdx + 1);

      if (line.startsWith('META ')) {
        try {
          this.lastMetadata = JSON.parse(line.slice(5)) as TowerMetadata;
        } catch {
          // Ignore
        }
      }

      if (remaining.length > 0) {
        socket.unshift(Buffer.from(remaining, 'utf-8'));
      }

      this.startH2Client(socket);
      return;
    }

    socket.on('data', onData);
  }

  private startH2Client(socket: net.Socket): void {
    // Start H2 client over the connection
    // Enable extended CONNECT protocol (RFC 8441) for WebSocket proxying
    const h2Session = http2.connect('http://localhost', {
      createConnection: () => socket,
      settings: { enableConnectProtocol: true },
    });

    h2Session.on('error', () => {
      // Ignore H2 errors in tests
    });

    this.h2Sessions.push(h2Session);
  }
}
