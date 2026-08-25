/**
 * Builder-review Submit is the single authoring surface's delivery point
 * (#1552). The diff codelens mode decides what Submit does with the authored
 * prose:
 *   - comment mode → enqueue a PendingComment (the batched Submit Review path)
 *   - forward mode → inject "<ref> <prose>" into the builder PTY immediately
 * An empty / whitespace-only submit leaves NOTHING behind (no queue entry, no
 * forward, no orphan thread) — the same net result as Escape/Cancel.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  class EventEmitter<T> {
    private handlers: Array<(e: T) => void> = [];
    event = (fn: (e: T) => void): { dispose(): void } => { this.handlers.push(fn); return { dispose() {} }; };
    fire(value: T): void { for (const fn of this.handlers) { fn(value); } }
    dispose(): void {}
  }
  const state = {
    mode: 'comment' as string,
    handlers: new Map<string, (...args: never[]) => unknown>(),
    executed: [] as Array<{ command: string; args: unknown[] }>,
  };
  return { EventEmitter, state };
});

vi.mock('vscode', () => ({
  EventEmitter: h.EventEmitter,
  Range: class { constructor(public a: number, public b: number, public c: number, public d: number) {} },
  Uri: { file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }) },
  Disposable: class { constructor(private fn: () => void) {} dispose(): void { this.fn(); } },
  MarkdownString: class { constructor(public value: string) {} },
  CommentMode: { Preview: 1, Editing: 0 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  comments: {
    createCommentController: () => ({
      options: undefined as unknown,
      commentingRangeProvider: undefined as unknown,
      createCommentThread: vi.fn(() => ({ comments: [], dispose() {} })),
      dispose: vi.fn(),
    }),
  },
  commands: {
    registerCommand: (id: string, fn: (...args: never[]) => unknown) => { h.state.handlers.set(id, fn); return { dispose() {} }; },
    executeCommand: vi.fn(async (command: string, ...args: unknown[]) => { h.state.executed.push({ command, args }); }),
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    showWarningMessage: vi.fn(),
  },
  workspace: {
    textDocuments: [],
    getConfiguration: () => ({ get: () => h.state.mode }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  languages: { registerCodeLensProvider: () => ({ dispose() {} }) },
}));

const { activateBuilderReviewComments } = await import('../comments/builder-review.js');
const { setDiffInjectSession } = await import('../diff-inject-codelens.js');

const ENTRY = { fsPath: '/wt/pkg/src/a.ts', builderId: 'pir-9', relPath: 'pkg/src/a.ts', hunks: [], baseRef: 'main', worktreePath: '/wt' };

const added: Array<{ builderId: string; comment: { file: string; lineRange: unknown; body: string } }> = [];
const storeStub = {
  onDidChangeQueue: () => ({ dispose() {} }),
  getWorktreePath: () => '/wt',
  registerWorktree: () => {},
  load: async () => [],
  getComments: () => [],
  add: async (builderId: string, comment: { file: string; lineRange: unknown; body: string }) => { added.push({ builderId, comment }); },
} as never;
const overviewStub = { getData: () => null } as never;

/** A pending in-progress reply thread. `range` undefined → a file comment. */
function makeThread(range?: { start: { line: number }; end: { line: number } }) {
  return { uri: { fsPath: ENTRY.fsPath }, range, dispose: vi.fn() };
}

function submit() {
  return h.state.handlers.get('codev.submitBuilderComment') as (reply: unknown) => Promise<void>;
}
function forwardCalls() {
  return h.state.executed.filter(e => e.command === 'codev.forwardToBuilder');
}

beforeEach(() => {
  h.state.handlers.clear();
  h.state.executed = [];
  added.length = 0;
  setDiffInjectSession([]);
  activateBuilderReviewComments({ subscriptions: [] } as never, storeStub, overviewStub);
  setDiffInjectSession([ENTRY]);
});

describe('builder-review Submit delivery (#1552)', () => {
  it('comment mode: enqueues the authored prose with the thread range', async () => {
    h.state.mode = 'comment';
    const thread = makeThread({ start: { line: 4 }, end: { line: 8 } }); // 1-based 5..9
    await submit()({ thread, text: 'please rename this' });
    expect(added).toHaveLength(1);
    expect(added[0].builderId).toBe('pir-9');
    expect(added[0].comment.file).toBe('pkg/src/a.ts');
    expect(added[0].comment.lineRange).toEqual({ start: 5, end: 9 });
    expect(added[0].comment.body).toBe('please rename this');
    expect(forwardCalls()).toHaveLength(0);
    expect(thread.dispose).toHaveBeenCalled();
  });

  it('forward mode: injects "<ref> <prose>" into the builder PTY and enqueues nothing', async () => {
    h.state.mode = 'forward';
    const thread = makeThread({ start: { line: 4 }, end: { line: 8 } });
    await submit()({ thread, text: 'please rename this' });
    expect(forwardCalls()).toEqual([
      { command: 'codev.forwardToBuilder', args: ['pir-9', 'pkg/src/a.ts:L5-L9 please rename this'] },
    ]);
    expect(added).toHaveLength(0);
    expect(thread.dispose).toHaveBeenCalled();
  });

  it('forward mode, whole-file comment: forwards the file ref + prose', async () => {
    h.state.mode = 'forward';
    const thread = makeThread(undefined); // file comment
    await submit()({ thread, text: 'overall this file needs work' });
    expect(forwardCalls()).toEqual([
      { command: 'codev.forwardToBuilder', args: ['pir-9', 'pkg/src/a.ts overall this file needs work'] },
    ]);
    expect(added).toHaveLength(0);
  });

  it('empty / whitespace submit leaves nothing behind in either mode', async () => {
    for (const mode of ['comment', 'forward']) {
      h.state.mode = mode;
      const thread = makeThread({ start: { line: 4 }, end: { line: 8 } });
      await submit()({ thread, text: '   \n\t ' });
      expect(added).toHaveLength(0);
      expect(forwardCalls()).toHaveLength(0);
      expect(thread.dispose).toHaveBeenCalled();
    }
  });

  it('trims surrounding whitespace from the authored body (comment mode)', async () => {
    h.state.mode = 'comment';
    const thread = makeThread({ start: { line: 4 }, end: { line: 8 } });
    await submit()({ thread, text: '  trailing spaces kept out  ' });
    expect(added[0].comment.body).toBe('trailing spaces kept out');
  });
});
