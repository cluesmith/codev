import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { TerminalManager } from '../pty-manager.js';

// Mock node-pty
const mockPty = {
  pid: 99999,
  onData: vi.fn(),
  onExit: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
};

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => mockPty),
}));

describe('TerminalManager', () => {
  let manager: TerminalManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPty.onData.mockImplementation(() => {});
    mockPty.onExit.mockImplementation(() => {});
    manager = new TerminalManager({
      workspaceRoot: '/tmp/test-project',
      diskLogEnabled: false,
      maxSessions: 5,
      reconnectTimeoutMs: 500,
    });
  });

  afterEach(() => {
    manager.shutdown();
  });

  it('resizes a session', async () => {
    const info = await manager.createSession({});
    const updated = manager.resizeSession(info.id, 120, 40);
    expect(updated).toBeTruthy();
    expect(updated!.cols).toBe(120);
    expect(updated!.rows).toBe(40);
  });

  it('returns null when resizing nonexistent session', () => {
    expect(manager.resizeSession('nope', 80, 24)).toBeNull();
  });

  it('respects max sessions limit', async () => {
    for (let i = 0; i < 5; i++) {
      await manager.createSession({ label: `session-${i}` });
    }
    await expect(manager.createSession({ label: 'too-many' }))
      .rejects.toThrow('Maximum 5 sessions reached');
  });

  describe('REST API handler', () => {
    function makeReq(method: string, url: string, body?: unknown): http.IncomingMessage {
      const req = new http.IncomingMessage(null as any);
      req.method = method;
      req.url = url;
      req.headers = { host: 'localhost:4200' };
      if (body) {
        const data = JSON.stringify(body);
        // Simulate readable stream
        process.nextTick(() => {
          req.emit('data', Buffer.from(data));
          req.emit('end');
        });
      } else {
        process.nextTick(() => req.emit('end'));
      }
      return req;
    }

    function makeRes(): http.ServerResponse & { _status: number; _body: string; _headers: Record<string, string> } {
      const res = {
        _status: 0,
        _body: '',
        _headers: {} as Record<string, string>,
        writeHead(status: number, headers?: Record<string, string>) {
          res._status = status;
          if (headers) Object.assign(res._headers, headers);
          return res;
        },
        end(body?: string) {
          res._body = body ?? '';
        },
      } as any;
      return res;
    }

    it('handles GET /api/terminals', () => {
      const req = makeReq('GET', '/api/terminals');
      const res = makeRes();
      const handled = manager.handleRequest(req, res);
      expect(handled).toBe(true);
      expect(res._status).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ terminals: [] });
    });

    it('returns 404 for unknown terminal', () => {
      const req = makeReq('GET', '/api/terminals/nonexistent');
      const res = makeRes();
      const handled = manager.handleRequest(req, res);
      expect(handled).toBe(true);
      expect(res._status).toBe(404);
    });

    it('does not handle unrelated routes', () => {
      const req = makeReq('GET', '/api/state');
      const res = makeRes();
      const handled = manager.handleRequest(req, res);
      expect(handled).toBe(false);
    });
  });
});
