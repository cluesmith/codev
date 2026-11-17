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

  // ------------------------------------------------------------------ Issue #1482
  // `resizeSession` returns null for BOTH "no such session" and "the resize never reached
  // the process", which is exactly why the REST layer needs its own existence check to tell
  // 409 from 404. Before this issue the route answered 200 and echoed the REQUESTED dims
  // back, so a dropped resize was indistinguishable from a successful one at the API — the
  // mechanism that let Tower's dims silently diverge from the kernel's.
  //
  // A dropped write is a shellper-backed condition (the socket write fails); a local PTY
  // session is removed from the manager on exit, so it cannot reach this state. The session's
  // own resize contract is covered against a real fake shellper client in
  // pty-session-resize.test.ts — here the point is the MANAGER/route contract on top of it.

  it('returns null when the session exists but the resize was dropped, leaving dims unmoved', async () => {
    const info = await manager.createSession({});
    const session = manager.getSession(info.id)!;
    const before = { cols: session.info.cols, rows: session.info.rows };
    vi.spyOn(session, 'resize').mockReturnValue(false);

    expect(manager.resizeSession(info.id, 200, 60)).toBeNull();
    expect(session.info.cols).toBe(before.cols);
    expect(session.info.rows).toBe(before.rows);
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

    it('answers 409 RESIZE_DROPPED when the session exists but the resize was dropped', async () => {
      const info = await manager.createSession({});
      vi.spyOn(manager.getSession(info.id)!, 'resize').mockReturnValue(false);

      const req = makeReq('POST', `/api/terminals/${info.id}/resize`, { cols: 200, rows: 60 });
      const res = makeRes();
      expect(manager.handleRequest(req, res)).toBe(true);
      await vi.waitFor(() => expect(res._status).not.toBe(0));

      expect(res._status).toBe(409);
      const body = JSON.parse(res._body);
      expect(body.error ?? body.code).toBeDefined();
      expect(res._body).toContain('RESIZE_DROPPED');
      // The failure must NOT read as "the terminal is gone" — it is very much alive.
      expect(res._body).not.toContain('NOT_FOUND');
    });

    it('answers 404 NOT_FOUND for an unknown id — the code a dropped resize must not borrow', async () => {
      const req = makeReq('POST', '/api/terminals/no-such-session/resize', { cols: 200, rows: 60 });
      const res = makeRes();
      expect(manager.handleRequest(req, res)).toBe(true);
      await vi.waitFor(() => expect(res._status).not.toBe(0));

      expect(res._status).toBe(404);
      expect(res._body).toContain('NOT_FOUND');
      expect(res._body).not.toContain('RESIZE_DROPPED');
    });

    it('still answers 200 with the APPLIED dims when the resize lands', async () => {
      const info = await manager.createSession({});
      const req = makeReq('POST', `/api/terminals/${info.id}/resize`, { cols: 120, rows: 40 });
      const res = makeRes();
      expect(manager.handleRequest(req, res)).toBe(true);
      await vi.waitFor(() => expect(res._status).not.toBe(0));

      expect(res._status).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.cols).toBe(120);
      expect(body.rows).toBe(40);
    });

    it('does not handle unrelated routes', () => {
      const req = makeReq('GET', '/api/state');
      const res = makeRes();
      const handled = manager.handleRequest(req, res);
      expect(handled).toBe(false);
    });
  });
});
