/**
 * Regression (#1037, raised by the PR consultation): the builder-review
 * commenting ranges must NOT depend on `codev.diffCodelensMode`. The
 * `workbench.action.addComment` command — which backs the comment codelens,
 * the gutter "+", AND the always-visible context-menu action — validates
 * against these ranges, so a comment-mode-only provider silently breaks
 * `Codev: Comment for Builder` from the context menu whenever the editor is
 * in forward mode, which is the DEFAULT. Ranges must be provided for
 * registered builder-diff files in every mode, with file comments enabled.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  class EventEmitter<T> {
    private handlers: Array<(e: T) => void> = [];
    event = (fn: (e: T) => void): { dispose(): void } => {
      this.handlers.push(fn);
      return { dispose() {} };
    };
    fire(value: T): void {
      for (const fn of this.handlers) { fn(value); }
    }
    dispose(): void {}
  }
  const state = {
    mode: 'forward' as string,
    controller: undefined as unknown,
  };
  return { EventEmitter, state };
});

vi.mock('vscode', () => ({
  EventEmitter: h.EventEmitter,
  Range: class {
    constructor(
      public startLine: number,
      public startChar: number,
      public endLine: number,
      public endChar: number,
    ) {}
  },
  Selection: class {},
  Uri: { file: (fsPath: string) => ({ fsPath, toString: () => `file://${fsPath}` }) },
  Disposable: class {
    constructor(private fn: () => void) {}
    dispose(): void { this.fn(); }
  },
  MarkdownString: class {
    constructor(public value: string) {}
  },
  CommentMode: { Preview: 1, Editing: 0 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  comments: {
    createCommentController: (id: string, label: string) => {
      const controller = {
        id,
        label,
        options: undefined as unknown,
        commentingRangeProvider: undefined as unknown,
        createCommentThread: vi.fn(),
        dispose: vi.fn(),
      };
      h.state.controller = controller;
      return controller;
    },
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    executeCommand: () => Promise.resolve(undefined),
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

const ENTRY = { fsPath: '/wt/pkg/src/a.ts', builderId: 'pir-9', relPath: 'pkg/src/a.ts', hunks: [] };
const DOC = { uri: { fsPath: ENTRY.fsPath }, lineCount: 40 };

const storeStub = {
  onDidChangeQueue: () => ({ dispose() {} }),
  getWorktreePath: () => '/wt',
  registerWorktree: () => {},
  load: async () => [],
  getComments: () => [],
} as never;

const overviewStub = { getData: () => null } as never;

interface Controller {
  commentingRangeProvider: {
    provideCommentingRanges(doc: unknown): { enableFileComments: boolean; ranges: unknown[] } | unknown[];
  };
}

beforeEach(() => {
  setDiffInjectSession([]);
  activateBuilderReviewComments({ subscriptions: [] } as never, storeStub, overviewStub);
  setDiffInjectSession([ENTRY]);
});

describe('builder-review commenting ranges are mode-independent', () => {
  it.each(['forward', 'comment', 'garbage'])(
    'provides ranges + file comments for a registered file in %s mode',
    mode => {
      h.state.mode = mode;
      const provider = (h.state.controller as Controller).commentingRangeProvider;
      const result = provider.provideCommentingRanges(DOC) as { enableFileComments: boolean; ranges: unknown[] };
      expect(result.enableFileComments).toBe(true);
      expect(result.ranges.length).toBeGreaterThan(0);
    },
  );

  it('provides nothing for an unregistered file', () => {
    const provider = (h.state.controller as Controller).commentingRangeProvider;
    const result = provider.provideCommentingRanges({ uri: { fsPath: '/elsewhere.ts' }, lineCount: 5 });
    expect(result).toEqual([]);
  });
});
