/**
 * Canvas view registration glue (spec 1401, plan phase 6).
 *
 * The host's three jobs are lease upkeep, activity reporting, and addressed delivery. These
 * tests drive them against a faked Tower client and a faked panel, because the parts that can go
 * wrong here are all lifecycle: registering twice, delivering to the wrong panel, heartbeating an
 * id Tower has forgotten, or leaving a view registered after its panel closed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('vscode', () => ({
  Disposable: class {
    constructor(private readonly fn: () => void) {}
    dispose(): void {
      this.fn();
    }
  },
}));

const { registerCanvasView } = await import('../markdown-preview/canvas-view-registry.js');

/** A panel double exposing the two hooks the registry uses. */
function fakePanel() {
  let viewStateHandler: ((e: { webviewPanel: { active: boolean } }) => void) | null = null;
  const posted: unknown[] = [];
  return {
    posted,
    onDidChangeViewState(handler: (e: { webviewPanel: { active: boolean } }) => void) {
      viewStateHandler = handler;
      return { dispose: vi.fn() };
    },
    webview: {
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    activate(active: boolean) {
      viewStateHandler?.({ webviewPanel: { active } });
    },
  };
}

/** A connection double: a scripted Tower client plus a controllable SSE feed. */
function fakeConnection(overrides: Record<string, unknown> = {}) {
  let sseHandler: ((e: { data: string }) => void) | null = null;
  const client = {
    registerCanvasView: vi.fn(async () => ({ ok: true, viewId: 'canvas-1', file: '/ws/spec.md' })),
    heartbeatCanvasView: vi.fn(async () => ({ ok: true, unknownView: false })),
    unregisterCanvasView: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  return {
    client,
    connectionManager: {
      getClient: () => client,
      getWorkspacePath: () => '/ws',
      onSSEEvent(handler: (e: { data: string }) => void) {
        sseHandler = handler;
        return { dispose: vi.fn() };
      },
    } as never,
    /** Push an SSE frame in Tower's envelope shape. */
    emit(type: string, body: unknown) {
      sseHandler?.({ data: JSON.stringify({ type, title: type, body: JSON.stringify(body) }) });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => vi.useRealTimers());

describe('canvas view registration', () => {
  it('registers the panel on creation', async () => {
    const conn = fakeConnection();
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();

    expect(conn.client.registerCanvasView).toHaveBeenCalledWith('/ws', '/ws/spec.md');
  });

  it('unregisters when the panel is disposed', async () => {
    const conn = fakeConnection();
    const panel = fakePanel();

    const sub = registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();
    sub.dispose();

    expect(conn.client.unregisterCanvasView).toHaveBeenCalledWith('canvas-1');
  });

  it('hands the id straight back when the panel closes mid-registration', async () => {
    let resolveRegister: (v: unknown) => void = () => {};
    const conn = fakeConnection({
      registerCanvasView: vi.fn(
        () => new Promise((resolve) => {
          resolveRegister = resolve;
        }),
      ),
    });
    const panel = fakePanel();

    const sub = registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    sub.dispose(); // closed while the request is still in flight
    resolveRegister({ ok: true, viewId: 'canvas-late', file: '/ws/spec.md' });
    await flush();

    // Otherwise this view would linger as a target that nothing will ever heartbeat.
    expect(conn.client.unregisterCanvasView).toHaveBeenCalledWith('canvas-late');
  });

  it('reports activity when the panel becomes active', async () => {
    const conn = fakeConnection();
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();
    panel.activate(true);
    await flush();

    expect(conn.client.heartbeatCanvasView).toHaveBeenCalledWith('canvas-1', true);
  });

  it('does not report activity when the panel goes inactive', async () => {
    const conn = fakeConnection();
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();
    panel.activate(false);
    await flush();

    expect(conn.client.heartbeatCanvasView).not.toHaveBeenCalled();
  });

  it('re-registers when Tower has forgotten the view', async () => {
    const conn = fakeConnection({
      heartbeatCanvasView: vi.fn(async () => ({ ok: false, unknownView: true })),
    });
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();
    expect(conn.client.registerCanvasView).toHaveBeenCalledTimes(1);

    panel.activate(true); // heartbeat comes back unknown-view
    await flush();

    // A Tower restart would otherwise leave this panel permanently undrivable.
    expect(conn.client.registerCanvasView).toHaveBeenCalledTimes(2);
  });

  it('retries registration later when Tower was unreachable at open time', async () => {
    const conn = fakeConnection({
      registerCanvasView: vi.fn(async () => ({ ok: false, error: 'Tower not running' })),
    });
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();
    expect(conn.client.registerCanvasView).toHaveBeenCalledTimes(1);

    panel.activate(true);
    await flush();
    expect(conn.client.registerCanvasView).toHaveBeenCalledTimes(2);
    // Nothing to heartbeat while unregistered, so no id was invented.
    expect(conn.client.heartbeatCanvasView).not.toHaveBeenCalled();
  });
});

describe('addressed delivery', () => {
  it('forwards a command addressed to this view', async () => {
    const conn = fakeConnection();
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();
    conn.emit('canvas-command', { viewId: 'canvas-1', command: 'comment-next' });

    expect(panel.posted).toEqual([{ type: 'command', command: 'comment-next' }]);
  });

  it('carries count when present', async () => {
    const conn = fakeConnection();
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();
    conn.emit('canvas-command', { viewId: 'canvas-1', command: 'block-next', count: 3 });

    expect(panel.posted).toEqual([{ type: 'command', command: 'block-next', count: 3 }]);
  });

  it('ignores a command addressed to a different view', async () => {
    const conn = fakeConnection();
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();
    conn.emit('canvas-command', { viewId: 'canvas-OTHER', command: 'comment-next' });

    // Tower broadcasts to every subscriber, so this filter is the entire addressing mechanism:
    // without it, one command would run in every open canvas.
    expect(panel.posted).toEqual([]);
  });

  it('ignores unrelated SSE events and malformed payloads', async () => {
    const conn = fakeConnection();
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    await flush();

    conn.emit('command', { verb: 'view-diff' });
    conn.emit('canvas-command', { viewId: 'canvas-1' }); // no command
    conn.emit('canvas-command', { command: 'comment-next' }); // no viewId
    conn.emit('canvas-command', { viewId: 'canvas-1', command: 42 });

    expect(panel.posted).toEqual([]);
  });

  it('delivers nothing before registration completes', async () => {
    let resolveRegister: (v: unknown) => void = () => {};
    const conn = fakeConnection({
      registerCanvasView: vi.fn(
        () => new Promise((resolve) => {
          resolveRegister = resolve;
        }),
      ),
    });
    const panel = fakePanel();

    registerCanvasView({ connectionManager: conn.connectionManager, panel: panel as never, file: '/ws/spec.md' });
    conn.emit('canvas-command', { viewId: 'canvas-1', command: 'comment-next' });
    expect(panel.posted).toEqual([]);

    resolveRegister({ ok: true, viewId: 'canvas-1', file: '/ws/spec.md' });
    await flush();
    conn.emit('canvas-command', { viewId: 'canvas-1', command: 'comment-next' });
    expect(panel.posted).toHaveLength(1);
  });
});
