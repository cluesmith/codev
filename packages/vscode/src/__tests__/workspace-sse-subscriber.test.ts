/**
 * Spec 823 Phase 4 (iter-1 Gemini + Codex correction): runtime behavior tests
 * for the WorkspaceProvider SSE subscriber.
 *
 * The companion `workspace.test.ts` file uses source-text grep to verify the
 * subscriber's structural invariants (envelope-type checks, single-subscriber,
 * JSON.parse safety). Those guards are cheap and survive refactoring of
 * surrounding code, but as Gemini and Codex correctly pointed out at Phase 4
 * iter-1, they would pass even if the runtime wiring broke.
 *
 * This file exercises the wiring directly: mock `vscode` to capture
 * `changeEmitter.fire()` calls, mock `ConnectionManager` so we can deliver
 * synthetic SSE envelopes, instantiate `WorkspaceProvider`, then assert that
 * the right envelopes trigger a refresh and the wrong ones don't.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the vscode module with a minimal EventEmitter implementation. This is
// the established pattern referenced in vitest.config.ts ("mock the vscode
// module entirely") — the test does not need real vscode runtime.
vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          this.listeners = this.listeners.filter((l) => l !== listener);
        },
      };
    };
    fire = vi.fn((e: T) => {
      this.listeners.forEach((l) => l(e));
    });
  }

  class FakeTreeItem {
    label: string | undefined;
    constructor(label?: string, _state?: unknown) {
      this.label = label;
    }
  }

  return {
    EventEmitter: FakeEventEmitter,
    TreeItem: FakeTreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(public id: string) {} },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
  };
});

// Mock the workspace-detector / dev-shared / load-worktree-config modules so
// the WorkspaceProvider's getChildren path doesn't pull on heavy deps. None
// of these are exercised by the SSE subscriber test, but they need to
// type-check at import time.
vi.mock('../workspace-detector.js', () => ({
  getTowerAddress: () => null,
}));
vi.mock('../commands/dev-shared.js', () => ({
  resolveWorkspaceDevTarget: () => null,
}));
vi.mock('../load-worktree-config.js', () => ({
  loadWorktreeConfig: async () => null,
}));
vi.mock('@cluesmith/codev-core/workspace', () => ({
  encodeWorkspacePath: (p: string) => Buffer.from(p).toString('base64url'),
}));

// Import AFTER mocks are set up.
const { WorkspaceProvider } = await import('../views/workspace.js');

// =============================================================================
// Mock helpers
// =============================================================================

interface CapturedSubscribers {
  sse: Array<(event: { type: string; data: string }) => void>;
  state: Array<(state: unknown) => void>;
  devTerminals: Array<() => void>;
}

function makeMocks(): {
  connectionManager: any;
  terminalManager: any;
  captured: CapturedSubscribers;
} {
  const captured: CapturedSubscribers = { sse: [], state: [], devTerminals: [] };
  const connectionManager = {
    onSSEEvent: vi.fn((cb: (e: { type: string; data: string }) => void) => {
      captured.sse.push(cb);
      return { dispose: vi.fn() };
    }),
    onStateChange: vi.fn((cb: (s: unknown) => void) => {
      captured.state.push(cb);
      return { dispose: vi.fn() };
    }),
    getWorkspacePath: () => '/test/workspace',
  };
  const terminalManager = {
    onDidChangeDevTerminals: vi.fn((cb: () => void) => {
      captured.devTerminals.push(cb);
      return { dispose: vi.fn() };
    }),
  };
  return { connectionManager, terminalManager, captured };
}

// Helper that constructs a WorkspaceProvider and returns the wired-up
// changeEmitter spy alongside the captured subscriber callbacks.
function makeProvider(): {
  provider: any;
  fire: any;
  captured: CapturedSubscribers;
} {
  const { connectionManager, terminalManager, captured } = makeMocks();
  const provider = new WorkspaceProvider(connectionManager as any, terminalManager as any);
  // `changeEmitter` is `private`, so reach in via runtime cast. This is a
  // unit test of the subscriber behaviour; deliberately probing the private
  // is acceptable here.
  const fire = (provider as any).changeEmitter.fire;
  return { provider, fire, captured };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Tests
// =============================================================================

describe('Spec 823 Phase 4 — WorkspaceProvider SSE subscriber runtime behaviour', () => {
  it('exactly one onSSEEvent subscription is registered (single shared subscriber)', () => {
    const { captured } = makeProvider();
    expect(captured.sse).toHaveLength(1);
  });

  it('fires changeEmitter when an architects-updated envelope arrives', () => {
    const { fire, captured } = makeProvider();
    // Reset to ignore any fires from constructor wiring.
    fire.mockClear();

    const sseHandler = captured.sse[0];
    sseHandler({ type: '', data: JSON.stringify({ type: 'architects-updated' }) });

    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('fires changeEmitter when a codev-config-updated envelope arrives (regression)', () => {
    // Phase 4 must NOT break the existing #786 behaviour.
    const { fire, captured } = makeProvider();
    fire.mockClear();

    const sseHandler = captured.sse[0];
    sseHandler({ type: '', data: JSON.stringify({ type: 'codev-config-updated' }) });

    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on unrelated envelope types', () => {
    const { fire, captured } = makeProvider();
    fire.mockClear();

    const sseHandler = captured.sse[0];
    sseHandler({ type: '', data: JSON.stringify({ type: 'overview-changed' }) });
    sseHandler({ type: '', data: JSON.stringify({ type: 'builder-spawned' }) });
    sseHandler({ type: '', data: JSON.stringify({ type: 'heartbeat' }) });
    sseHandler({ type: '', data: JSON.stringify({ type: 'notification' }) });

    expect(fire).not.toHaveBeenCalled();
  });

  it('does NOT throw and does NOT fire on malformed JSON envelope', () => {
    const { fire, captured } = makeProvider();
    fire.mockClear();

    const sseHandler = captured.sse[0];
    // Wrap in expect to confirm the subscriber doesn't propagate the parse
    // error — its try/catch must swallow malformed payloads silently.
    expect(() => {
      sseHandler({ type: '', data: 'not-json' });
      sseHandler({ type: '', data: '{ "type": ' });
    }).not.toThrow();

    expect(fire).not.toHaveBeenCalled();
  });

  it('does NOT fire when envelope.type is missing', () => {
    const { fire, captured } = makeProvider();
    fire.mockClear();

    const sseHandler = captured.sse[0];
    sseHandler({ type: '', data: JSON.stringify({ workspace: '/test' }) });
    sseHandler({ type: '', data: JSON.stringify({}) });

    expect(fire).not.toHaveBeenCalled();
  });

  it('fires unconditionally regardless of envelope.workspace value (no workspace filter at SSE layer)', () => {
    // Per spec OQ-F + plan iter-2 Codex internal-consistency fix: the
    // SSE-subscriber layer fires unconditionally on matching envelope type.
    // The workspace field stays in the body for dashboards or other
    // listeners that want to filter; the VSCode subscriber does not.
    const { fire, captured } = makeProvider();
    fire.mockClear();

    const sseHandler = captured.sse[0];
    sseHandler({
      type: '',
      data: JSON.stringify({ type: 'architects-updated', workspace: '/some/other/workspace' }),
    });

    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('fires on multiple sequential events (no de-duplication)', () => {
    const { fire, captured } = makeProvider();
    fire.mockClear();

    const sseHandler = captured.sse[0];
    sseHandler({ type: '', data: JSON.stringify({ type: 'architects-updated' }) });
    sseHandler({ type: '', data: JSON.stringify({ type: 'architects-updated' }) });
    sseHandler({ type: '', data: JSON.stringify({ type: 'codev-config-updated' }) });

    expect(fire).toHaveBeenCalledTimes(3);
  });

  it('refresh() fires changeEmitter directly (regression for #786 imperative refresh)', () => {
    const { provider, fire } = makeProvider();
    fire.mockClear();

    (provider as any).refresh();

    expect(fire).toHaveBeenCalledTimes(1);
  });
});
