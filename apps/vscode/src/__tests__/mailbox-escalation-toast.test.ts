/**
 * Spec 1313 Phase 8: unit tests for the `mailbox-escalation` toast handler.
 * `vscode` is mocked (this is a `src/__tests__` vitest unit, not the Electron
 * `src/test` harness); we drive the SSE callback the handler subscribes to and
 * assert on `window.showWarningMessage`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  getBool: vi.fn((_key: string, dflt: boolean) => dflt),
}));

vi.mock('vscode', () => ({
  window: { showWarningMessage: h.showWarningMessage },
  workspace: {
    getConfiguration: () => ({ get: (key: string, dflt: boolean) => h.getBool(key, dflt) }),
  },
}));

const { activateMailboxEscalationToasts, MAX_SEEN } = await import('../notifications/mailbox-escalation-toast.js');

type SSEHandler = (e: { type: string; data: string }) => void;

function makeCtx() {
  return { subscriptions: [] as { dispose(): void }[] };
}

function makeConnectionManager(workspacePath: string | null) {
  let handler: SSEHandler | null = null;
  return {
    getWorkspacePath: () => workspacePath,
    onSSEEvent: (fn: SSEHandler) => {
      handler = fn;
      return { dispose() {} };
    },
    /** Simulate Tower pushing an SSE `data:` payload. */
    fire: (data: string) => handler?.({ type: 'message', data }),
  };
}

function escalationEvent(overrides: Record<string, unknown> = {}): string {
  const payload = {
    workspacePath: '/ws',
    toAgent: 'spir-1',
    mailboxId: 'mb1',
    ageMs: 65_000,
    reason: 'busy',
    ...overrides,
  };
  return JSON.stringify({ type: 'mailbox-escalation', body: JSON.stringify(payload) });
}

/**
 * Minimal OverviewCache double: the workspace-level `mailboxEscalated` flag plus a
 * manual change hook, so a test can drive the de-escalation prune (#1472) the same
 * way Tower's overview refresh would.
 */
function makeOverviewCache(initial: { mailboxEscalated: boolean } | null = null) {
  let data = initial;
  const listeners: (() => void)[] = [];
  return {
    getData: () => data,
    onDidChange: (fn: () => void) => {
      listeners.push(fn);
      return { dispose() {} };
    },
    /** Simulate an overview refresh committing a new escalated state. */
    set: (next: { mailboxEscalated: boolean } | null) => {
      data = next;
      for (const fn of listeners) { fn(); }
    },
  };
}

function activate(
  cm: ReturnType<typeof makeConnectionManager>,
  cache: ReturnType<typeof makeOverviewCache> = makeOverviewCache(),
) {
  const ctx = makeCtx();
  // Structural fakes stand in for vscode.ExtensionContext / ConnectionManager / OverviewCache.
  activateMailboxEscalationToasts(ctx as any, cm as any, cache as any);
  return ctx;
}

beforeEach(() => {
  h.showWarningMessage.mockClear();
  h.getBool.mockReset();
  h.getBool.mockImplementation((_key: string, dflt: boolean) => dflt);
});

describe('activateMailboxEscalationToasts', () => {
  it('raises a warning toast for a matching escalation, with metadata (no body)', () => {
    const cm = makeConnectionManager('/ws');
    activate(cm);
    cm.fire(escalationEvent({ toAgent: 'architect:main', ageMs: 63_000, reason: 'busy' }));

    expect(h.showWarningMessage).toHaveBeenCalledTimes(1);
    const msg = h.showWarningMessage.mock.calls[0][0] as string;
    expect(msg).toContain('architect:main');
    expect(msg).toContain('63s');
    expect(msg).toContain('afx inbox');
  });

  it('dedupes by mailboxId — a redelivered event does not re-toast', () => {
    const cm = makeConnectionManager('/ws');
    activate(cm);
    cm.fire(escalationEvent({ mailboxId: 'dup' }));
    cm.fire(escalationEvent({ mailboxId: 'dup' }));
    expect(h.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('toasts again for a different mailboxId', () => {
    const cm = makeConnectionManager('/ws');
    activate(cm);
    cm.fire(escalationEvent({ mailboxId: 'a' }));
    cm.fire(escalationEvent({ mailboxId: 'b' }));
    expect(h.showWarningMessage).toHaveBeenCalledTimes(2);
  });

  it('ignores escalations for a different workspace on a shared Tower', () => {
    const cm = makeConnectionManager('/ws');
    activate(cm);
    cm.fire(escalationEvent({ workspacePath: '/other' }));
    expect(h.showWarningMessage).not.toHaveBeenCalled();
  });

  it('ignores non-escalation SSE envelope types', () => {
    const cm = makeConnectionManager('/ws');
    activate(cm);
    cm.fire(JSON.stringify({ type: 'overview-changed', body: '{}' }));
    expect(h.showWarningMessage).not.toHaveBeenCalled();
  });

  it('ignores malformed (non-JSON) SSE data without throwing', () => {
    const cm = makeConnectionManager('/ws');
    activate(cm);
    expect(() => cm.fire('not-json')).not.toThrow();
    expect(h.showWarningMessage).not.toHaveBeenCalled();
  });

  it('does not toast when disabled via codev.mailboxEscalationToasts.enabled', () => {
    h.getBool.mockImplementation(() => false);
    const cm = makeConnectionManager('/ws');
    activate(cm);
    cm.fire(escalationEvent());
    expect(h.showWarningMessage).not.toHaveBeenCalled();
  });

  it('ignores a payload missing its mailboxId', () => {
    const cm = makeConnectionManager('/ws');
    activate(cm);
    cm.fire(escalationEvent({ mailboxId: '' }));
    expect(h.showWarningMessage).not.toHaveBeenCalled();
  });
});

/**
 * Issue #1472: the dedupe set must be bounded. Its eviction key is the mailbox row
 * leaving the escalated set — observed here as the workspace-level
 * `mailboxEscalated` flag going false — with a {@link MAX_SEEN} cap as backstop.
 * Each test observes eviction the only way it is observable from outside: an id
 * that was deduped before is toasted again after it has been evicted.
 */
describe('activateMailboxEscalationToasts — bounded dedupe set (#1472)', () => {
  it('drops seen ids once no held row in the workspace is escalated', () => {
    const cm = makeConnectionManager('/ws');
    const cache = makeOverviewCache({ mailboxEscalated: true });
    activate(cm, cache);

    cm.fire(escalationEvent({ mailboxId: 'a' }));
    expect(h.showWarningMessage).toHaveBeenCalledTimes(1);

    // The row resolved: nothing is escalated any more, so 'a' has left the set.
    cache.set({ mailboxEscalated: false });

    cm.fire(escalationEvent({ mailboxId: 'a' }));
    expect(h.showWarningMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps seen ids while the workspace is still escalated', () => {
    const cm = makeConnectionManager('/ws');
    const cache = makeOverviewCache({ mailboxEscalated: true });
    activate(cm, cache);

    cm.fire(escalationEvent({ mailboxId: 'a' }));
    cache.set({ mailboxEscalated: true });
    cm.fire(escalationEvent({ mailboxId: 'a' }));

    expect(h.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('does not prune on an empty cache — no data says nothing about the escalated set', () => {
    const cm = makeConnectionManager('/ws');
    const cache = makeOverviewCache(null);
    activate(cm, cache);

    cm.fire(escalationEvent({ mailboxId: 'a' }));
    cache.set(null);
    cm.fire(escalationEvent({ mailboxId: 'a' }));

    expect(h.showWarningMessage).toHaveBeenCalledTimes(1);
  });

  it('caps the set when the window never de-escalates, evicting oldest-first', () => {
    const cm = makeConnectionManager('/ws');
    // Permanently escalated: the prune above never runs, so only the cap bounds it.
    const cache = makeOverviewCache({ mailboxEscalated: true });
    activate(cm, cache);

    for (let i = 0; i < MAX_SEEN; i++) {
      cm.fire(escalationEvent({ mailboxId: `id-${i}` }));
    }
    expect(h.showWarningMessage).toHaveBeenCalledTimes(MAX_SEEN);

    // One past the cap evicts the oldest id, which can therefore toast again;
    // the newest id is still deduped.
    cm.fire(escalationEvent({ mailboxId: 'overflow' }));
    cm.fire(escalationEvent({ mailboxId: 'id-0' }));
    cm.fire(escalationEvent({ mailboxId: 'overflow' }));

    expect(h.showWarningMessage).toHaveBeenCalledTimes(MAX_SEEN + 2);
  });
});
