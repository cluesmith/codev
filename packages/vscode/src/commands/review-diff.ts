/**
 * Codev: View Diff — open `main...HEAD` diff for a builder's worktree.
 *
 * Right-click a builder row in the Codev sidebar → "View Diff". Opens one
 * native VSCode diff tab per changed file: left = file at `main`'s tip
 * (resolved via the Git extension's `git:` URI scheme), right = the
 * worktree's current working-tree file.
 *
 * Why this works across worktrees: each `.builders/<id>/` is a real git
 * worktree linked to the parent repo's `.git`, so all branches live in the
 * shared object database. `git -C <wt> rev-parse main` resolves the same
 * SHA as from the parent repo, and `git:?ref=main` reads from that object
 * database regardless of which repo VSCode attributes the file to.
 */

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { ConnectionManager } from '../connection-manager.js';

const execFileAsync = promisify(execFile);

/** Guard against opening too many diff tabs in one shot. */
const MAX_FILES_WITHOUT_CONFIRM = 30;

export async function reviewDiff(
  connectionManager: ConnectionManager,
  builderIdArg: string | undefined,
): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  // Resolve the builder. If no id was passed (palette invocation), show a quick-pick.
  const overview = await client.getOverview(workspacePath);
  const builders = overview?.builders ?? [];
  if (builders.length === 0) {
    vscode.window.showInformationMessage('Codev: No builders to diff');
    return;
  }

  const builder = builderIdArg
    ? builders.find(b => b.id === builderIdArg)
    : await pickBuilder(builders);
  if (!builder) {
    if (builderIdArg) {
      vscode.window.showErrorMessage(`Codev: No builder found for "${builderIdArg}"`);
    }
    return;
  }
  if (!builder.worktreePath) {
    vscode.window.showErrorMessage(`Codev: Builder ${builder.id} has no worktree on record`);
    return;
  }

  // Enumerate changed files via git.
  let files: string[];
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', builder.worktreePath,
      'diff', '--name-only', 'main...HEAD',
    ]);
    files = stdout.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Codev: git diff failed — ${message}`);
    return;
  }

  if (files.length === 0) {
    vscode.window.showInformationMessage(`Codev: No changes to review yet for ${builder.id}`);
    return;
  }

  if (files.length > MAX_FILES_WITHOUT_CONFIRM) {
    const proceed = await vscode.window.showWarningMessage(
      `Open ${files.length} diff tabs for ${builder.id}?`,
      { modal: true },
      'Open All',
    );
    if (proceed !== 'Open All') { return; }
  }

  for (const rel of files) {
    const abs = path.join(builder.worktreePath, rel);
    const query = encodeURIComponent(JSON.stringify({ ref: 'main', path: rel }));
    const left = vscode.Uri.parse(`git:${abs}?${query}`);
    const right = vscode.Uri.file(abs);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${rel} (main ↔ ${builder.id})`,
    );
  }
}

interface BuilderLike {
  id: string;
  issueId: string | null;
  issueTitle: string | null;
}

async function pickBuilder<T extends BuilderLike>(builders: T[]): Promise<T | undefined> {
  const picked = await vscode.window.showQuickPick(
    builders.map(b => ({
      label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
      builder: b,
    })),
    { placeHolder: 'Select builder to diff against main' },
  );
  return picked?.builder;
}
