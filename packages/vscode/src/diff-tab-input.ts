import * as vscode from 'vscode';

/**
 * True when a tab input is a **plain text editor tab** (a file opened as a
 * normal editor), as opposed to a diff editor — the per-file builder diff
 * (`TabInputTextDiff`, from `vscode.diff`) or the multi-file diff editor (from
 * `vscode.changes`, the View Diff editor).
 *
 * The Builders active-file reveal (#1066) skips these. The diff-inject registry
 * is keyed by the right-side worktree file path, and a standalone open of that
 * same file shares that path — so without this gate, opening a worktree file in
 * a normal editor tab would hijack the sidebar selection (consultation finding).
 *
 * Gating on "is a plain text tab" rather than "is a diff tab" is deliberate: it
 * avoids `TabInputTextMultiDiff` (absent from the stable `@types/vscode`), and
 * stays correct for the multi-file View Diff — whatever its non-text input type
 * is, it is not `TabInputText`, so the reveal still fires there.
 *
 * Pure (takes the input, not the window) so it unit-tests without a live editor.
 */
export function isStandaloneTextTab(input: unknown): boolean {
  return input instanceof vscode.TabInputText;
}
