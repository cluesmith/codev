/**
 * Mode-neutral review feedback (#1410, #1552): the diff/scroll dial verbs turn
 * each chunk (whole file / hunk-under-cursor / selection) into an AUTHORING
 * gesture — they open the native comment reply box at the anchor via
 * `codev.commentForBuilder`. There is no promptless path.
 *
 * Deck composer parity (#1552): while a builder-review box is OPEN, VS Code (the
 * diff-mode owner) interprets the SAME verbs to drive it — hunk = submit,
 * file = cancel, selection = inert — mirroring the canvas composer (#1425). The
 * queue-vs-forward decision lives in the box's Submit, not here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    activeFsPath: undefined as string | undefined,
    selection: { active: { line: 0 }, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true },
    executed: [] as Array<{ command: string; args: unknown[] }>,
    warnings: [] as string[],
    statusMessages: [] as string[],
    // Stdout the press helper's fresh `git diff` returns; null → the call rejects,
    // which makes `resolvePressCursorRef` fall back to the frozen `entry.hunks`.
    gitStdout: null as string | null,
    // Builder-review composer state + spies (mocked module below).
    composerOpen: false,
    submitCalls: 0,
    cancelCalls: 0,
  };
  return { state };
});

// The press helper (#1534) re-parses the file live at press time. Stub the git
// call so these routing tests stay deterministic and never spawn a subprocess.
vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    if (h.state.gitStdout === null) { cb(new Error('no repo')); return; }
    cb(null, { stdout: h.state.gitStdout, stderr: '' });
  },
}));

// The composer owner: feedback.ts reads its open-state and drives submit/cancel.
vi.mock('../comments/builder-review.js', () => ({
  isBuilderComposerOpen: () => h.state.composerOpen,
  submitActiveBuilderComposer: vi.fn(async () => { h.state.submitCalls++; }),
  cancelActiveBuilderComposer: vi.fn(async () => { h.state.cancelCalls++; }),
}));

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
    getConfiguration: () => ({ get: () => 'forward' }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: { executeCommand: vi.fn(async (command: string, ...args: unknown[]) => { h.state.executed.push({ command, args }); }) },
  languages: { registerCodeLensProvider: () => ({ dispose() {} }) },
  Range: class {},
  CodeLens: class {},
}));

const { feedbackFile, feedbackHunk, feedbackSelection, decideFeedbackAction } = await import('../review-queue/feedback.js');
const { setDiffInjectSession } = await import('../diff-inject-codelens.js');

const FS_PATH = '/w/alpha/.builders/pir-1/src/a.ts';

/** The single `codev.commentForBuilder` invocation an OPEN gesture is expected to make. */
function commentCalls() {
  return h.state.executed.filter(e => e.command === 'codev.commentForBuilder');
}

describe('decideFeedbackAction — pure composer state machine (#1552)', () => {
  it('with NO box open, every axis opens a comment at that axis', () => {
    expect(decideFeedbackAction('file', false)).toEqual({ kind: 'open', axis: 'file' });
    expect(decideFeedbackAction('hunk', false)).toEqual({ kind: 'open', axis: 'hunk' });
    expect(decideFeedbackAction('selection', false)).toEqual({ kind: 'open', axis: 'selection' });
  });

  it('with a box open, the file dial cancels and every other dial submits (open-or-submit)', () => {
    expect(decideFeedbackAction('hunk', true)).toEqual({ kind: 'submit' });
    expect(decideFeedbackAction('selection', true)).toEqual({ kind: 'submit' });
    expect(decideFeedbackAction('file', true)).toEqual({ kind: 'cancel' });
  });

  it('a stale-open flag decides submit for hunk — never a phantom cancel/open; the built-in no-op is what makes it safe', () => {
    // The function cannot know the flag is stale; it decides `submit`. Safety
    // comes from the executor: SUBMIT runs the built-in submit-comment, a no-op
    // when nothing is focused (asserted in builder-review-submit.test.ts).
    expect(decideFeedbackAction('hunk', true)).toEqual({ kind: 'submit' });
  });
});

describe('feedback gesture routing (#1410, #1552)', () => {
  beforeEach(() => {
    h.state.activeFsPath = FS_PATH;
    h.state.selection = { active: { line: 0 }, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true };
    h.state.executed = [];
    h.state.warnings = [];
    h.state.statusMessages = [];
    h.state.gitStdout = null; // default: git rejects → fall back to the frozen entry.hunks
    h.state.composerOpen = false;
    h.state.submitCalls = 0;
    h.state.cancelCalls = 0;
    setDiffInjectSession([{ fsPath: FS_PATH, builderId: 'pir-1', relPath: 'src/a.ts', hunks: [{ start: 5, end: 9 }], baseRef: 'main', worktreePath: '/w/alpha/.builders/pir-1' }]);
  });

  it('no box open: a file press opens the comment reply box at the whole-file anchor', async () => {
    await feedbackFile();
    expect(commentCalls()).toEqual([
      { command: 'codev.commentForBuilder', args: ['pir-1', FS_PATH, 'src/a.ts', null] },
    ]);
  });

  it('no box open: a hunk press opens the input anchored to the changed-hunk range under the cursor', async () => {
    h.state.selection = { active: { line: 6 }, start: { line: 6, character: 0 }, end: { line: 6, character: 0 }, isEmpty: true }; // line 7 ∈ [5,9]
    await feedbackHunk();
    expect(commentCalls()[0].args[3]).toEqual({ start: 5, end: 9 });
  });

  it('no box open: a hunk press resolves against the FRESH git parse, not the stale frozen ranges (#1534)', async () => {
    h.state.gitStdout = '@@ -0,0 +20,2 @@\n+const added = 1;\n+const more = 2;\n';
    h.state.selection = { active: { line: 19 }, start: { line: 19, character: 0 }, end: { line: 19, character: 0 }, isEmpty: true }; // line 20
    await feedbackHunk();
    expect(commentCalls()[0].args[3]).toEqual({ start: 20, end: 21 });
    expect(h.state.statusMessages).toHaveLength(0);
  });

  it('no box open: a hunk press with no changed lines anchors the whole file with an honest note (#1534)', async () => {
    h.state.gitStdout = ''; // a fresh parse that records no ranges
    h.state.selection = { active: { line: 0 }, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true }; // line 1 ∉ any hunk
    await feedbackHunk();
    expect(commentCalls()[0].args[3]).toBeNull();
    expect(h.state.statusMessages.join('\n')).toContain('no changed lines at the cursor');
    expect(h.state.statusMessages.join('\n')).not.toContain('place the cursor in a changed hunk');
  });

  it('no box open: a selection press opens the input anchored to the selected range', async () => {
    h.state.selection = { active: { line: 2 }, start: { line: 2, character: 0 }, end: { line: 5, character: 4 }, isEmpty: false };
    await feedbackSelection();
    expect(commentCalls()[0].args[3]).toEqual({ start: 3, end: 6 });
  });

  it('no box open: warns instead of doing nothing when the focused editor is not a builder diff', async () => {
    h.state.activeFsPath = '/some/unrelated/file.ts';
    await feedbackFile();
    expect(commentCalls()).toHaveLength(0);
    expect(h.state.warnings.join('\n')).toContain('focus a builder diff first');
  });

  it('box open: a hunk press SUBMITS the open composer and opens nothing new', async () => {
    h.state.composerOpen = true;
    await feedbackHunk();
    expect(h.state.submitCalls).toBe(1);
    expect(h.state.cancelCalls).toBe(0);
    expect(commentCalls()).toHaveLength(0);
  });

  it('box open: a file press CANCELS the open composer and opens nothing new', async () => {
    h.state.composerOpen = true;
    await feedbackFile();
    expect(h.state.cancelCalls).toBe(1);
    expect(h.state.submitCalls).toBe(0);
    expect(commentCalls()).toHaveLength(0);
  });

  it('box open: a selection press SUBMITS (open-or-submit) — so the dial that opened the box can also submit it', async () => {
    h.state.composerOpen = true;
    await feedbackSelection();
    expect(h.state.submitCalls).toBe(1);
    expect(h.state.cancelCalls).toBe(0);
    expect(commentCalls()).toHaveLength(0);
  });
});
