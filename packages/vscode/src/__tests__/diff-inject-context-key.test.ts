/**
 * Regression (#789, raised by the PR consultation): the
 * `codev.activeEditorIsBuilderFile` context key — which gates the right-click
 * "Forward Selection to Builder" menu and the Cmd/Ctrl+K B keybinding — must
 * re-sync when the diff registry changes, not only on editor-focus changes.
 *
 * `openBuilderFileDiff` opens the diff (making it the active editor) BEFORE
 * registering its file, so the active-editor event fires while the registry is
 * still empty. Without a registry-change re-sync the key stays `false` on the
 * just-opened diff until focus changes, leaving the selection action dead.
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
    activeEditor: undefined as unknown,
    setContextCalls: [] as Array<{ key: string; value: unknown }>,
  };
  return { EventEmitter, state };
});

vi.mock('vscode', () => ({
  EventEmitter: h.EventEmitter,
  Range: class {},
  CodeLens: class {},
  languages: { registerCodeLensProvider: () => ({ dispose() {} }) },
  commands: {
    executeCommand: (cmd: string, ...args: unknown[]) => {
      if (cmd === 'setContext') {
        h.state.setContextCalls.push({ key: args[0] as string, value: args[1] });
      }
      return Promise.resolve();
    },
  },
  window: {
    get activeTextEditor() { return h.state.activeEditor; },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  },
}));

const {
  activateDiffInjectCodeLens,
  setDiffInjectSession,
  upsertDiffInjectEntry,
  BUILDER_FILE_CONTEXT_KEY,
} = await import('../diff-inject-codelens.js');

function editorFor(fsPath: string): unknown {
  return { document: { uri: { fsPath, toString: () => `file://${fsPath}` } } };
}
function lastContext(): { key: string; value: unknown } | undefined {
  return h.state.setContextCalls[h.state.setContextCalls.length - 1];
}

const ENTRY = { fsPath: '/wt/pkg/src/a.ts', builderId: 'b1', relPath: 'pkg/src/a.ts', hunks: [] };

describe('#789 — activeEditorIsBuilderFile re-syncs on registry change', () => {
  beforeEach(() => {
    h.state.activeEditor = undefined;
    setDiffInjectSession([]); // clear the singleton registry
    h.state.setContextCalls.length = 0;
  });

  it('sets the key true after the active file is registered (not only on focus change)', () => {
    h.state.activeEditor = editorFor(ENTRY.fsPath);

    activateDiffInjectCodeLens({ subscriptions: [] } as never);
    // Diff is active but not yet registered → key false.
    expect(lastContext()).toEqual({ key: BUILDER_FILE_CONTEXT_KEY, value: false });

    // openBuilderFileDiff order: open the diff, THEN register its file.
    upsertDiffInjectEntry(ENTRY);

    // The registry-change re-sync must flip the key true (the bug left it false).
    expect(lastContext()).toEqual({ key: BUILDER_FILE_CONTEXT_KEY, value: true });
  });

  it('clears the key when a new session no longer tracks the active file', () => {
    h.state.activeEditor = editorFor(ENTRY.fsPath);
    activateDiffInjectCodeLens({ subscriptions: [] } as never);
    upsertDiffInjectEntry(ENTRY);
    expect(lastContext()?.value).toBe(true);

    setDiffInjectSession([]); // e.g. a fresh viewDiff run without this file
    expect(lastContext()?.value).toBe(false);
  });
});
