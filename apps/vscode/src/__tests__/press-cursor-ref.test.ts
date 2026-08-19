/**
 * `resolvePressCursorRef` (#1534) — the shared resolver behind the two
 * "forward the change under the cursor" press verbs. It re-parses the file's
 * diff LIVE at press time and degrades symbol → hunk → file, so the press never
 * errors on a stale snapshot or a deletion-only change. These tests drive the
 * two seams it depends on — the `git diff` call and the document-symbol
 * provider — through mocks, so the resolution is exercised deterministically.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    // Stdout the fresh `git diff` returns; null → the call rejects (→ fallback).
    gitStdout: null as string | null,
    // Document symbols the provider returns (vscode.DocumentSymbol shape).
    symbols: [] as unknown[],
  };
  return { state };
});

vi.mock('vscode', () => ({
  EventEmitter: class { event = (): { dispose(): void } => ({ dispose() {} }); fire(): void {} dispose(): void {} },
  commands: { executeCommand: vi.fn(async () => h.state.symbols) },
}));

vi.mock('node:child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, r?: { stdout: string; stderr: string }) => void) => {
    if (h.state.gitStdout === null) { cb(new Error('no repo')); return; }
    cb(null, { stdout: h.state.gitStdout, stderr: '' });
  },
}));

const { resolvePressCursorRef } = await import('../commands/press-cursor-ref.js');

/** A `vscode.DocumentSymbol`-shaped node (0-based lines) for the symbol seam. */
function symbol(kind: number, startLine: number, endLine: number): unknown {
  return { kind, range: { start: { line: startLine }, end: { line: endLine } }, children: [] };
}

const ENTRY = {
  fsPath: '/wt/src/a.ts',
  builderId: 'pir-1',
  relPath: 'src/a.ts',
  hunks: [{ start: 5, end: 9 }], // the STALE frozen snapshot
  baseRef: 'main',
  worktreePath: '/wt',
};
const URI = { fsPath: ENTRY.fsPath } as never;

describe('resolvePressCursorRef', () => {
  beforeEach(() => {
    h.state.gitStdout = null;
    h.state.symbols = [];
  });

  it('resolves against the FRESH parse, catching a change the frozen snapshot missed', async () => {
    // Live diff records a change at lines 20-21 that the stale entry.hunks [{5,9}] lacks.
    h.state.gitStdout = '@@ -0,0 +20,2 @@\n+const added = 1;\n+const more = 2;\n';
    const ref = await resolvePressCursorRef(ENTRY, URI, 20);
    expect(ref).toEqual({ kind: 'hunk', refText: 'src/a.ts:L20-L21 ', range: { start: 20, end: 21 } });
  });

  it('degrades a deletion-only change (no new-side range) to the enclosing symbol, not an error', async () => {
    // A pure deletion: parseHunkRanges yields no range, but a symbol covers the cursor.
    h.state.gitStdout = '@@ -10,3 +9,0 @@\n-gone one\n-gone two\n-gone three\n';
    h.state.symbols = [symbol(11 /* Function */, 10, 20)]; // 1-based 11..21
    const ref = await resolvePressCursorRef(ENTRY, URI, 15);
    expect(ref).toEqual({ kind: 'symbol', refText: 'src/a.ts:L11-L21 ', range: { start: 11, end: 21 } });
  });

  it('degrades to the whole file when neither a fresh hunk nor a symbol covers the cursor', async () => {
    h.state.gitStdout = ''; // a valid parse that records no ranges
    const ref = await resolvePressCursorRef(ENTRY, URI, 3);
    expect(ref).toEqual({ kind: 'file', refText: 'src/a.ts ' });
  });

  it('falls back to the frozen entry.hunks when the git re-parse fails (never worse than before)', async () => {
    h.state.gitStdout = null; // execFile rejects
    const ref = await resolvePressCursorRef(ENTRY, URI, 7); // 7 ∈ the frozen [5,9]
    expect(ref).toEqual({ kind: 'hunk', refText: 'src/a.ts:L5-L9 ', range: { start: 5, end: 9 } });
  });
});
