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

  it('creates a session', async () => {
    const info = await manager.createSession({ label: 'test' });
    expect(info.id).toBeTruthy();
    expect(info.pid).toBe(99999);
    expect(info.label).toBe('test');
    expect(info.status).toBe('running');
    expect(info.cols).toBe(80);
    expect(info.rows).toBe(24);
  });

  it('lists sessions', async () => {
    await manager.createSession({ label: 'a' });
    await manager.createSession({ label: 'b' });
    const list = manager.listSessions();
    expect(list.length).toBe(2);
    expect(list.map(s => s.label)).toEqual(['a', 'b']);
  });

  it('gets a session by ID', async () => {
    const info = await manager.createSession({ label: 'findme' });
    const session = manager.getSession(info.id);
    expect(session).toBeTruthy();
    expect(session!.label).toBe('findme');
  });

  it('returns undefined for unknown session', () => {
    expect(manager.getSession('nonexistent')).toBeUndefined();
  });

  it('kills a session', async () => {
    const info = await manager.createSession({ label: 'killme' });
    expect(manager.killSession(info.id)).toBe(true);
    expect(manager.getSession(info.id)).toBeUndefined();
  });

  it('returns false when killing nonexistent session', () => {
    expect(manager.killSession('nope')).toBe(false);
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

  it('creates sessions with custom dimensions', async () => {
    const info = await manager.createSession({ cols: 120, rows: 40 });
    expect(info.cols).toBe(120);
    expect(info.rows).toBe(40);
  });

  it('gets output from ring buffer', async () => {
    const info = await manager.createSession({});
    // No output yet
    const output = manager.getOutput(info.id);
    expect(output).toBeTruthy();
    expect(output!.lines).toEqual([]);
    expect(output!.total).toBe(0);
  });

  it('returns null for output of nonexistent session', () => {
    expect(manager.getOutput('nope')).toBeNull();
  });

  it('shuts down all sessions', async () => {
    await manager.createSession({ label: 'a' });
    await manager.createSession({ label: 'b' });
    manager.shutdown();
    expect(manager.listSessions()).toEqual([]);
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
