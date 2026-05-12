/**
 * Codev: Run Worktree Setup — execute `worktree.postSpawn` against an
 * existing builder's worktree, without recreating it.
 *
 * Use cases: lockfile changed and dependencies need reinstalling; a new
 * step was added to `worktree.postSpawn` after the builder spawned;
 * setup aborted mid-spawn and the worktree needs recovery; running
 * setup for the first time on a builder that predates the config.
 *
 * Opens a fresh VSCode terminal in the worktree and chains the configured
 * commands so output streams live (preferable to buffered execution for
 * long-running installs).
 */

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ConnectionManager } from '../connection-manager.js';

export async function runWorktreeSetup(
  connectionManager: ConnectionManager,
  builderIdArg: string | undefined,
): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const overview = await client.getOverview(workspacePath);
  const builders = overview?.builders ?? [];
  if (builders.length === 0) {
    vscode.window.showInformationMessage('Codev: No builders available');
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

  const postSpawn = await readPostSpawn(workspacePath);
  if (postSpawn.length === 0) {
    vscode.window.showInformationMessage(
      'Codev: No worktree.postSpawn configured in .codev/config.json. Nothing to do.',
    );
    return;
  }

  // Open a fresh VSCode integrated terminal scoped to the worktree.
  // sendText streams each command live — for long-running installs the
  // reviewer sees pnpm progress, uv resolver output, etc. in real time.
  const terminal = vscode.window.createTerminal({
    name: `Codev: Setup ${builder.id}`,
    cwd: builder.worktreePath,
  });
  terminal.show();
  for (const cmd of postSpawn) {
    terminal.sendText(cmd);
  }
}

async function readPostSpawn(workspacePath: string): Promise<string[]> {
  const configPath = path.join(workspacePath, '.codev', 'config.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { worktree?: { postSpawn?: unknown } };
    const list = parsed.worktree?.postSpawn;
    if (!Array.isArray(list)) { return []; }
    return list.filter((x): x is string => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
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
    { placeHolder: 'Select builder whose worktree to re-setup' },
  );
  return picked?.builder;
}
