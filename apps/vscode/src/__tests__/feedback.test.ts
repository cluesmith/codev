/**
 * Mode-neutral review feedback (#1410): the diff/scroll dial verbs route each
 * chunk forward-now (immediate PTY inject) or into the queue, following the
 * `codev.diffCodelensMode` setting, deriving both branches from the same anchor.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    mode: 'forward' as 'forward' | 'comment',
    activeFsPath: undefined as string | undefined,
    selection: { active: { line: 0 }, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true },
    executed: [] as Array<{ command: string; args: unknown[] }>,
    warnings: [] as string[],
    statusMessages: [] as string[],
  };
  return { state };
});

vi.mock('vscode', () => ({
  EventEmitter: class { event = (): { dispose(): void } => ({ dispose() {} }); fire(): void {} dispose(): void {} },
  RelativePattern: class {},
  window: {
    get activeTextEditor() {
      if (!h.state.activeFsPath) { return undefined; }
      return { document: { uri: { fsPath: h.state.activeFsPath } }, selection: h.state.selection };
    },
    showWarningMessage: vi.fn(async (msg: string) => { h.state.warnings.push(msg); return undefined; }),
    setStatusBarMessage: vi.fn((msg: string) => { h.state.statusMessages.push(msg); }),
  },
  workspace: {
    createFileSystemWatcher: vi.fn(),
    getConfiguration: () => ({ get: () => h.state.mode }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: { executeCommand: vi.fn(async (command: string, ...args: unknown[]) => { h.state.executed.push({ command, args }); }) },
  languages: { registerCodeLensProvider: () => ({ dispose() {} }) },
  Range: class {},
  CodeLens: class {},
}));

const { feedbackFile, feedbackHunk, feedbackSelection } = await import('../review-queue/feedback.js');
const { setDiffInjectSession } = await import('../diff-inject-codelens.js');

const FS_PATH = '/w/alpha/.builders/pir-1/src/a.ts';

/** Minimal in-memory ReviewQueueStore stand-in capturing worktree + queue writes. */
function makeStore() {
  const worktrees = new Map<string, string>();
  const added: Array<{ builderId: string; comment: { file: string; lineRange: unknown; body: string } }> = [];
  return {
    store: {
      getWorktreePath: (id: string) => worktrees.get(id),
      registerWorktree: (id: string, wt: string) => { worktrees.set(id, wt); },
      add: async (builderId: string, comment: { file: string; lineRange: unknown; body: string }) => { added.push({ builderId, comment }); },
    },
    worktrees,
    added,
  };
}

describe('feedback mode-router (#1410)', () => {
  beforeEach(() => {
    h.state.mode = 'forward';
    h.state.activeFsPath = FS_PATH;
    h.state.selection = { active: { line: 0 }, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true };
    h.state.executed = [];
    h.state.warnings = [];
    h.state.statusMessages = [];
    setDiffInjectSession([{ fsPath: FS_PATH, builderId: 'pir-1', relPath: 'src/a.ts', hunks: [{ start: 5, end: 9 }] }]);
  });

  it('forward mode: a file press injects immediately via forwardToBuilder', async () => {
    const { store, added } = makeStore();
    await feedbackFile({ store: store as never });
    expect(h.state.executed).toEqual([{ command: 'codev.forwardToBuilder', args: ['pir-1', 'src/a.ts '] }]);
    expect(added).toHaveLength(0); // nothing queued in forward mode
  });

  it('comment mode: a file press enqueues a whole-file comment through the store', async () => {
    h.state.mode = 'comment';
    const { store, added, worktrees } = makeStore();
    await feedbackFile({ store: store as never });
    expect(h.state.executed).toHaveLength(0); // no immediate forward
    expect(added).toHaveLength(1);
    expect(added[0].builderId).toBe('pir-1');
    expect(added[0].comment.file).toBe('src/a.ts');
    expect(added[0].comment.lineRange).toBeNull(); // whole file
    expect(added[0].comment.body).toContain('Stream Deck');
    // worktree derived from the diff entry (never guessed)
    expect(worktrees.get('pir-1')).toBe('/w/alpha/.builders/pir-1');
  });

  it('comment mode: a hunk press enqueues the changed-hunk range under the cursor', async () => {
    h.state.mode = 'comment';
    h.state.selection = { active: { line: 6 }, start: { line: 6, character: 0 }, end: { line: 6, character: 0 }, isEmpty: true }; // line 7 ∈ [5,9]
    const { store, added } = makeStore();
    await feedbackHunk({ store: store as never });
    expect(added[0].comment.lineRange).toEqual({ start: 5, end: 9 });
  });

  it('comment mode: a selection press enqueues the selected range', async () => {
    h.state.mode = 'comment';
    h.state.selection = { active: { line: 2 }, start: { line: 2, character: 0 }, end: { line: 5, character: 4 }, isEmpty: false };
    const { store, added } = makeStore();
    await feedbackSelection({ store: store as never });
    expect(added[0].comment.lineRange).toEqual({ start: 3, end: 6 });
  });

  it('does nothing when the focused editor is not a tracked builder diff', async () => {
    h.state.activeFsPath = '/some/unrelated/file.ts';
    const { store, added } = makeStore();
    await feedbackFile({ store: store as never });
    expect(h.state.executed).toHaveLength(0);
    expect(added).toHaveLength(0);
  });
});
