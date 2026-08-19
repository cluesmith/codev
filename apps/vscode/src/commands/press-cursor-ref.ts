/**
 * Shared cursor resolution for the "forward the change under the cursor" press
 * verbs (#1534).
 *
 * The two press paths — `codev.forwardCurrentHunkToBuilder` (extension.ts) and
 * the feedback-queue mirror `hunkAnchor` (review-queue/feedback.ts) — used to
 * validate the cursor against `entry.hunks`, a snapshot of `git diff` parsed
 * ONCE when the diff opened and never refreshed. Two things made a press fail
 * with the cursor visibly inside a green change:
 *
 *   1. Staleness — the builder keeps committing after the reviewer opens the
 *      diff, so the frozen ranges no longer cover the live green regions.
 *   2. A deletion-only change has no new-side line, so `parseHunkRanges` records
 *      no range for it; the dial rotation (VS Code's live change model) stops on
 *      it, then the press against our model finds nothing.
 *
 * This helper collapses both press paths onto the SAME resolution the keyboard
 * path (Cmd/Ctrl+K H, `resolveCursorRef`, #1073) already uses — symbol → hunk →
 * file — but against a FRESHLY re-parsed hunk snapshot: a single-file
 * `git diff -M --unified=3 <baseRef> -- <relPath>` at press time (cheap: one
 * file, one git call). Staleness is gone; a deletion-only or otherwise
 * unrepresentable cursor degrades to the enclosing symbol or the file instead of
 * erroring. On git failure it falls back to the frozen `entry.hunks`, so the
 * worst case is exactly the old behavior — never worse.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import {
  parseHunkRanges,
  resolveCursorRef,
  type ChangedRange,
  type CursorRef,
} from '../diff-inject-ref.js';
import { toSymbolNode, type DiffInjectSessionEntry } from '../diff-inject-codelens.js';

const execFileAsync = promisify(execFile);

/** Re-parse the entry's single file live, so the resolution never trusts the
 *  open-time snapshot. Falls back to the frozen ranges on any git failure. */
async function freshHunks(entry: DiffInjectSessionEntry): Promise<ChangedRange[]> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', entry.worktreePath, 'diff', '-M', '--unified=3', entry.baseRef, '--', entry.relPath],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return parseHunkRanges(stdout);
  } catch {
    return entry.hunks;
  }
}

/** The active editor's document symbols, empty on any failure (same tolerance as
 *  the codelens provider and the Cmd/Ctrl+K H handler). */
async function documentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
  try {
    return (
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri,
      )) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * Resolve the reference a press should forward for `cursorLine` (1-based,
 * new-side), degrading symbol → hunk → file against a freshly re-parsed diff.
 * Never throws for a "no changed hunk" cursor — it returns the `file` kind, which
 * the callers surface with an honest note rather than the old misleading error.
 */
export async function resolvePressCursorRef(
  entry: DiffInjectSessionEntry,
  uri: vscode.Uri,
  cursorLine: number,
): Promise<CursorRef> {
  const [hunks, symbols] = await Promise.all([freshHunks(entry), documentSymbols(uri)]);
  return resolveCursorRef(entry.relPath, symbols.map(toSymbolNode), hunks, cursorLine);
}
