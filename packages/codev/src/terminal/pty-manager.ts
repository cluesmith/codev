/**
 * Terminal Manager: manages PTY sessions lifecycle, REST API routes,
 * and WebSocket connections.
 */

import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { PtySession } from './pty-session.js';
import type { PtySessionConfig, PtySessionInfo } from './pty-session.js';
import { decodeFrame, encodeControl, encodeData } from './ws-protocol.js';
import { DEFAULT_COLS, DEFAULT_ROWS } from './index.js';

export interface TerminalManagerConfig {
  workspaceRoot: string;
  logDir?: string; // Default: <workspaceRoot>/.agent-farm/logs
  maxSessions?: number; // Default: 50
  ringBufferLines?: number;
  diskLogEnabled?: boolean;
  diskLogMaxBytes?: number;
  reconnectTimeoutMs?: number;
}

export interface CreateTerminalRequest {
  command?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
  label?: string;
}

interface ErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}

export class TerminalManager {
  private sessions: Map<string, PtySession> = new Map();
  private wss: WebSocketServer | null = null;
  private readonly config: Required<TerminalManagerConfig>;

  constructor(config: TerminalManagerConfig) {
    this.config = {
      workspaceRoot: config.workspaceRoot,
      logDir: config.logDir ?? path.join(config.workspaceRoot, '.agent-farm', 'logs'),
      maxSessions: config.maxSessions ?? 50,
      ringBufferLines: config.ringBufferLines ?? 1000,
      diskLogEnabled: config.diskLogEnabled ?? true,
      diskLogMaxBytes: config.diskLogMaxBytes ?? 50 * 1024 * 1024,
      reconnectTimeoutMs: config.reconnectTimeoutMs ?? 300_000,
    };
  }

  /** Create a new PTY session. */
  async createSession(req: CreateTerminalRequest): Promise<PtySessionInfo> {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new ManagerError('MAX_SESSIONS', `Maximum ${this.config.maxSessions} sessions reached`);
    }

    const id = randomUUID();
    const shell = req.command ?? process.env.SHELL ?? '/bin/bash';
    const baseEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      SHELL: shell,
      TERM: 'xterm-256color',
      // UTF-8 locale for proper Unicode character rendering
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL ?? '',
    };

    const sessionConfig: PtySessionConfig = {
      id,
      command: shell,
      args: req.args ?? [],
      cols: req.cols ?? DEFAULT_COLS,
      rows: req.rows ?? DEFAULT_ROWS,
      cwd: req.cwd ?? this.config.workspaceRoot,
      env: { ...baseEnv, ...req.env },
      label: req.label ?? `terminal-${id.slice(0, 8)}`,
      logDir: this.config.logDir,
      ringBufferLines: this.config.ringBufferLines,
      diskLogEnabled: this.config.diskLogEnabled,
      diskLogMaxBytes: this.config.diskLogMaxBytes,
      reconnectTimeoutMs: this.config.reconnectTimeoutMs,
    };

    const session = new PtySession(sessionConfig);

    session.on('exit', () => {
      // Keep session around briefly for status queries, then clean up
      setTimeout(() => {
        this.sessions.delete(id);
      }, 30_000);
    });

    session.on('timeout', () => {
      this.sessions.delete(id);
    });

    await session.spawn();
    this.sessions.set(id, session);

    return session.info;
  }

  /**
   * Create a PtySession without spawning a process.
   * Used for shellper-backed sessions where attachShellper() will be called
   * instead of spawn().
   */
  createSessionRaw(opts: { label: string; cwd: string }): PtySessionInfo {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new ManagerError('MAX_SESSIONS', `Maximum ${this.config.maxSessions} sessions reached`);
    }

    const id = randomUUID();
    const sessionConfig: PtySessionConfig = {
      id,
      command: '', // Not used for shellper-backed sessions
      args: [],
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: opts.cwd,
      env: {},
      label: opts.label,
      logDir: this.config.logDir,
      ringBufferLines: this.config.ringBufferLines,
      diskLogEnabled: this.config.diskLogEnabled,
      diskLogMaxBytes: this.config.diskLogMaxBytes,
      reconnectTimeoutMs: this.config.reconnectTimeoutMs,
    };

    const session = new PtySession(sessionConfig);

    session.on('exit', () => {
      setTimeout(() => {
        this.sessions.delete(id);
      }, 30_000);
    });

    session.on('timeout', () => {
      this.sessions.delete(id);
    });

    this.sessions.set(id, session);
    return session.info;
  }

  /** List all sessions. */
  listSessions(): PtySessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.info);
  }

  /** Get a session by ID. */
  getSession(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  /** Kill and remove a session. */
  killSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.kill();
    this.sessions.delete(id);
    return true;
  }

  /** Resize a session. */
  resizeSession(id: string, cols: number, rows: number): PtySessionInfo | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.resize(cols, rows);
    return session.info;
  }

  /** Get output lines from ring buffer. */
  getOutput(id: string, lines?: number, offset?: number): { lines: string[]; total: number; hasMore: boolean } | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const all = session.ringBuffer.getAll();
    const start = offset ?? 0;
    const count = lines ?? 100;
    const sliced = all.slice(start, start + count);
    return {
      lines: sliced,
      total: all.length,
      hasMore: start + count < all.length,
    };
  }

  /** Attach WebSocket server to an HTTP server for terminal/:id routes. */
  attachWebSocket(server: http.Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const match = url.pathname.match(/^\/ws\/terminal\/([^/]+)$/);

      if (!match) {
        // Not a terminal WebSocket — let other handlers deal with it
        return;
      }

      const sessionId = match[1];
      const session = this.sessions.get(sessionId);

      if (!session) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.handleTerminalConnection(ws, session, req);
      });
    });
  }

  private handleTerminalConnection(ws: WebSocket, session: PtySession, req: http.IncomingMessage): void {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const resumeSeq = req.headers['x-session-resume'];

    // Create a client adapter
    const client = {
      send: (data: Buffer | string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(typeof data === 'string' ? encodeData(data) : encodeData(data));
        }
      },
    };

    // Attach and replay buffer
    let replayLines: string[];
    if (resumeSeq && typeof resumeSeq === 'string') {
      replayLines = session.attachResume(client, parseInt(resumeSeq, 10));
    } else {
      replayLines = session.attach(client);
    }

    // Send replay data
    if (replayLines.length > 0) {
      const replayData = replayLines.join('\n');
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeData(replayData));
      }
    }

    // Handle incoming messages from client
    ws.on('message', (rawData: Buffer) => {
      try {
        const frame = decodeFrame(Buffer.from(rawData));
        if (frame.type === 'data') {
          session.write(frame.data.toString('utf-8'));
        } else if (frame.type === 'control') {
          this.handleControlMessage(session, ws, frame.message);
        }
      } catch {
        // If decode fails, treat as raw data (for simpler clients)
        session.write(rawData.toString('utf-8'));
      }
    });

    ws.on('close', () => {
      session.detach(client);
    });

    ws.on('error', () => {
      session.detach(client);
    });
  }

  private handleControlMessage(
    session: PtySession,
    ws: WebSocket,
    msg: { type: string; payload: Record<string, unknown> },
  ): void {
    switch (msg.type) {
      case 'resize': {
        const cols = msg.payload.cols as number;
        const rows = msg.payload.rows as number;
        if (typeof cols === 'number' && typeof rows === 'number') {
          session.resize(cols, rows);
        }
        break;
      }
      case 'ping':
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(encodeControl({ type: 'pong', payload: {} }));
        }
        break;
    }
  }

  /** Handle REST API requests. Returns true if handled. */
  handleRequest(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const method = req.method ?? 'GET';

    // POST /api/terminals
    if (method === 'POST' && url.pathname === '/api/terminals') {
      this.handleCreateTerminal(req, res);
      return true;
    }

    // GET /api/terminals
    if (method === 'GET' && url.pathname === '/api/terminals') {
      this.sendJson(res, 200, { terminals: this.listSessions() });
      return true;
    }

    // Routes with :id
    const idMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)(\/.*)?$/);
    if (!idMatch) return false;

    const id = idMatch[1];
    const subpath = idMatch[2] ?? '';

    // GET /api/terminals/:id
    if (method === 'GET' && subpath === '') {
      const session = this.sessions.get(id);
      if (!session) {
        this.sendError(res, 404, 'NOT_FOUND', `Session ${id} not found`);
        return true;
      }
      this.sendJson(res, 200, session.info);
      return true;
    }

    // DELETE /api/terminals/:id
    if (method === 'DELETE' && subpath === '') {
      if (!this.killSession(id)) {
        this.sendError(res, 404, 'NOT_FOUND', `Session ${id} not found`);
        return true;
      }
      res.writeHead(204);
      res.end();
      return true;
    }

    // POST /api/terminals/:id/resize
    if (method === 'POST' && subpath === '/resize') {
      this.handleResize(req, res, id);
      return true;
    }

    // GET /api/terminals/:id/output
    if (method === 'GET' && subpath === '/output') {
      const output = this.getOutput(
        id,
        parseInt(url.searchParams.get('lines') ?? '100', 10),
        parseInt(url.searchParams.get('offset') ?? '0', 10),
      );
      if (!output) {
        this.sendError(res, 404, 'NOT_FOUND', `Session ${id} not found`);
        return true;
      }
      this.sendJson(res, 200, output);
      return true;
    }

    return false;
  }

  private async handleCreateTerminal(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const body = await readJsonBody(req);
      const info = await this.createSession(body as CreateTerminalRequest);
      const response = {
        ...info,
        wsPath: `/ws/terminal/${info.id}`,
      };
      this.sendJson(res, 201, response);
    } catch (err) {
      if (err instanceof ManagerError) {
        this.sendError(res, err.code === 'MAX_SESSIONS' ? 503 : 400, err.code, err.message);
      } else {
        this.sendError(res, 500, 'INTERNAL_ERROR', (err as Error).message);
      }
    }
  }

  private async handleResize(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    try {
      const body = await readJsonBody(req) as { cols?: number; rows?: number };
      if (typeof body.cols !== 'number' || typeof body.rows !== 'number') {
        this.sendError(res, 400, 'INVALID_PARAMS', 'cols and rows must be numbers');
        return;
      }
      const info = this.resizeSession(id, body.cols, body.rows);
      if (!info) {
        this.sendError(res, 404, 'NOT_FOUND', `Session ${id} not found`);
        return;
      }
      this.sendJson(res, 200, info);
    } catch {
      this.sendError(res, 400, 'INVALID_PARAMS', 'Invalid JSON body');
    }
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
    this.sendJson(res, status, { error: code, message } as ErrorResponse);
  }

  /** Kill all sessions and clean up. */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.shellperBacked) {
        // Shellper-backed sessions survive Tower restart. Detach listeners
        // so that SessionManager.shutdown() disconnecting the client doesn't
        // cascade into exit events and SQLite row deletion.
        session.detachShellper();
        continue;
      }
      session.kill();
    }
    this.sessions.clear();
    if (this.wss) {
      this.wss.close();
    }
  }
}

class ManagerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ManagerError';
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body.length > 0 ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
