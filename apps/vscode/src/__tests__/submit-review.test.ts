/**
 * Submit Review flow (#1037): target-builder resolution (active diff owner →
 * sole pending builder → QuickPick), open-terminal-then-inject ordering with
 * the bracketed-paste wrapped message (no trailing Enter), clearing exactly
 * the submitted ids, and the queue surviving a failed injection.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    activeEditorFsPath: undefined as string | undefined,
    quickPickResult: undefined as { label: string } | undefined,
    warnings: [] as string[],
    statusMessages: [] as string[],
  };
  return { state };
});

vi.mock('vscode', () => ({
  EventEmitter: class {
    event = (): { dispose(): void } => ({ dispose() {} });
    fire(): void {}
    dispose(): void {}
  },
  RelativePattern: class {},
  window: {
    get activeTextEditor() {
      if (!h.state.activeEditorFsPath) { return undefined; }
      return { document: { uri: { fsPath: h.state.activeEditorFsPath } } };
    },
    showQuickPick: vi.fn(async () => h.state.quickPickResult),
    showWarningMessage: vi.fn(async (msg: string) => {
      h.state.warnings.push(msg);
      return undefined;
    }),
    setStatusBarMessage: vi.fn((msg: string) => { h.state.statusMessages.push(msg); }),
  },
  workspace: {
    createFileSystemWatcher: vi.fn(),
    getConfiguration: () => ({ get: () => 'comment' }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: { executeCommand: () => Promise.resolve(undefined) },
  languages: { registerCodeLensProvider: () => ({ dispose() {} }) },
  Range: class {},
  CodeLens: class {},
}));

const { submitReview, resolveTargetBuilder } = await import('../review-queue/submit.js');
const { setDiffInjectSession, upsertDiffInjectEntry } = await import('../diff-inject-codelens.js');
const { wrapBracketedPaste, buildSubmitMessage } = await import('../review-queue/queue.js');

function makeComment(id: string) {
  return { id, createdAt: 't', file: 'src/a.ts', lineRange: { start: 1, end: 2 }, body: `b-${id}` };
}

/** Minimal in-memory stand-in for ReviewQueueStore. */
function makeStore(queues: Record<string, ReturnType<typeof makeComment>[]>) {
  const removed: Array<{ builderId: string; ids: readonly string[] }> = [];
  return {
    removed,
    getWorktreePath: () => '/wt',
    registerWorktree: () => {},
    buildersWithPending: () => Object.keys(queues).filter(k => queues[k]!.length > 0),
    count: (id: string) => (queues[id] ?? []).length,
    load: async (id: string) => queues[id] ?? [],
    getComments: (id: string) => queues[id] ?? [],
    remove: async (builderId: string, ids: readonly string[]) => { removed.push({ builderId, ids }); },
  };
}

function makeTerminalManager(injectResult = true) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    openBuilderByRoleOrId: vi.fn(async (id: string) => {
      calls.push({ method: 'open', args: [id] });
      return id;
    }),
    injectBuilderText: vi.fn((id: string, text: string) => {
      calls.push({ method: 'inject', args: [id, text] });
      return injectResult;
    }),
  };
}

const overviewCache = { getData: () => ({ builders: [], currentUser: 'amr' }) };

beforeEach(() => {
  h.state.activeEditorFsPath = undefined;
  h.state.quickPickResult = undefined;
  h.state.warnings.length = 0;
  h.state.statusMessages.length = 0;
  setDiffInjectSession([]);
});

describe('resolveTargetBuilder', () => {
  it('prefers the active builder-diff file’s owner', async () => {
    upsertDiffInjectEntry({ fsPath: '/wt/src/a.ts', builderId: 'pir-1', relPath: 'src/a.ts', hunks: [] });
    h.state.activeEditorFsPath = '/wt/src/a.ts';
    const store = makeStore({ 'pir-2': [makeComment('x')] });
    expect(await resolveTargetBuilder(store as never)).toBe('pir-1');
  });

  it('falls back to the sole builder with pending comments', async () => {
    const store = makeStore({ 'pir-2': [makeComment('x')], 'pir-3': [] });
    expect(await resolveTargetBuilder(store as never)).toBe('pir-2');
  });

  it('quick-picks when several builders have pending comments', async () => {
    h.state.quickPickResult = { label: 'pir-3' };
    const store = makeStore({ 'pir-2': [makeComment('x')], 'pir-3': [makeComment('y')] });
    expect(await resolveTargetBuilder(store as never)).toBe('pir-3');
  });

  it('reports and returns undefined when nothing is pending anywhere', async () => {
    const store = makeStore({});
    expect(await resolveTargetBuilder(store as never)).toBeUndefined();
    expect(h.state.statusMessages.some(m => m.includes('No pending review comments'))).toBe(true);
  });
});

describe('submitReview', () => {
  it('opens the terminal, injects the wrapped packaged message, clears submitted ids', async () => {
    const comments = [makeComment('c1'), makeComment('c2')];
    const store = makeStore({ 'pir-1': comments });
    const tm = makeTerminalManager();

    await submitReview({ store, terminalManager: tm, overviewCache } as never, 'pir-1');

    expect(tm.calls.map(c => c.method)).toEqual(['open', 'inject']);
    const injected = tm.calls[1]!.args[1] as string;
    expect(injected).toBe(wrapBracketedPaste(buildSubmitMessage(comments)));
    // Wrapped: bracketed-paste guarded, no raw newlines, no trailing Enter.
    expect(injected.startsWith('\x1b[200~')).toBe(true);
    expect(injected.endsWith('\x1b[201~')).toBe(true);
    expect(injected).not.toContain('\n');
    expect(store.removed).toEqual([{ builderId: 'pir-1', ids: ['c1', 'c2'] }]);
  });

  it('keeps the queue intact when the terminal injection fails', async () => {
    const store = makeStore({ 'pir-1': [makeComment('c1')] });
    const tm = makeTerminalManager(false);

    await submitReview({ store, terminalManager: tm, overviewCache } as never, 'pir-1');

    expect(store.removed).toEqual([]);
    expect(h.state.warnings.some(w => w.includes('kept in the queue'))).toBe(true);
  });

  it('does nothing but report when the target builder has no pending comments', async () => {
    const store = makeStore({ 'pir-1': [] });
    const tm = makeTerminalManager();
    await submitReview({ store, terminalManager: tm, overviewCache } as never, 'pir-1');
    expect(tm.calls).toEqual([]);
    expect(h.state.statusMessages.some(m => m.includes('No pending comments for pir-1'))).toBe(true);
  });
});
