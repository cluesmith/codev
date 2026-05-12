/**
 * Codev: Run Dev Server — start a Tower-managed dev PTY for a builder's worktree.
 *
 * Right-click a builder row → "Run Dev Server". Reads `worktree.devCommand`
 * from `.codev/config.json`, asks Tower to spawn the PTY (type='dev', label
 * 'Dev: <id>'), and auto-opens it as a VSCode terminal tab.
 *
 * Mirrors the swap-detection logic from the CLI's `afx dev` (commands/dev.ts)
 * but uses a VSCode modal instead of a readline prompt.
 */

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';

/** Match the CLI's swap-sequencing values from packages/codev/src/agent-farm/commands/dev.ts */
const KILL_WAIT_TIMEOUT_MS = 7000;
const KILL_POLL_INTERVAL_MS = 200;
const SWAP_GRACE_MS = 250;

export async function runWorktreeDev(
  connectionManager: ConnectionManager,
  terminalManager: TerminalManager,
  builderIdArg: string | undefined,
): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  // Resolve the builder. Quick-pick fallback when invoked from the palette.
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

  // Read worktree.devCommand from .codev/config.json
  const devCommand = await readDevCommand(workspacePath);
  if (!devCommand) {
    vscode.window.showErrorMessage(
      'Codev: Configure worktree.devCommand in .codev/config.json to use this action. ' +
      'See "Runnable Worktrees" in CLAUDE.md for stack-specific recipes.',
    );
    return;
  }

  // Swap detection. Tower terminal `label` carries the "Dev: <id>" marker.
  const all = await client.listTerminals();
  const existing = all.find(t => t.label?.startsWith('Dev: '));
  if (existing) {
    const existingBuilderId = existing.label.slice('Dev: '.length);
    if (existingBuilderId === builder.id) {
      vscode.window.showInformationMessage(`Codev: Dev server is already running for ${builder.id}`);
      await terminalManager.openDevTerminal(existing.id, builder.id, true);
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Stop dev for ${existingBuilderId} and start for ${builder.id}?`,
      { modal: true },
      'Yes', 'No',
    );
    if (choice !== 'Yes') { return; }
    await client.killTerminal(existing.id);
    terminalManager.closeDevTerminal(existingBuilderId);
    try {
      await waitForTerminalGone(client, existing.id);
    } catch (err) {
      vscode.window.showErrorMessage(`Codev: ${(err as Error).message}`);
      return;
    }
    await new Promise((r) => setTimeout(r, SWAP_GRACE_MS));
  }

  // Spawn the new dev PTY
  const terminal = await client.createTerminal({
    command: '/bin/sh',
    args: ['-lc', devCommand],
    cwd: builder.worktreePath,
    workspacePath,
    type: 'dev',
    roleId: builder.id,
    label: `Dev: ${builder.id}`,
    persistent: false,
  });
  if (!terminal) {
    vscode.window.showErrorMessage(`Codev: Failed to spawn dev terminal for ${builder.id}`);
    return;
  }

  await terminalManager.openDevTerminal(terminal.id, builder.id, true);
  vscode.window.showInformationMessage(`Codev: Dev server started for ${builder.id}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function readDevCommand(workspacePath: string): Promise<string | null> {
  const configPath = path.join(workspacePath, '.codev', 'config.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { worktree?: { devCommand?: unknown } };
    const cmd = parsed.worktree?.devCommand;
    return typeof cmd === 'string' && cmd.length > 0 ? cmd : null;
  } catch {
    return null;
  }
}

async function waitForTerminalGone(
  client: NonNullable<ReturnType<ConnectionManager['getClient']>>,
  terminalId: string,
): Promise<void> {
  const deadline = Date.now() + KILL_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const terminals = await client.listTerminals();
    if (!terminals.some(t => t.id === terminalId)) { return; }
    await new Promise((r) => setTimeout(r, KILL_POLL_INTERVAL_MS));
  }
  throw new Error(`Dev terminal ${terminalId} did not exit within ${KILL_WAIT_TIMEOUT_MS}ms`);
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
    { placeHolder: 'Select builder to run dev for' },
  );
  return picked?.builder;
}
