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
import { resolveAgentName } from '@cluesmith/codev-core/agent-names';
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

  // Look up the human-friendly builder name from workspace state — same
  // source and matching strategy the builder tab uses (openBuilderByRoleOrId
  // in terminal-manager.ts). OverviewBuilder.id and Builder.id can differ in
  // shape (one may include the worktree slug, the other not), so we use
  // resolveAgentName for the tail-match fallback rather than strict ===.
  const workspaceState = await client.getWorkspaceState(workspacePath);
  const { builder: namedBuilder } = resolveAgentName(builder.id, workspaceState?.builders ?? []);
  const builderName = namedBuilder?.name ?? builder.id;

  // Swap detection. Source of truth for "what dev terminals exist" is
  // TerminalManager's local map — Tower's label filter would be brittle
  // and wouldn't catch terminals across VSCode instances anyway (a #690
  // non-goal). For now we assume one VSCode instance per workspace.
  const existing = terminalManager.listDevTerminals();
  const sameBuilder = existing.find(d => d.builderId === builder.id);
  if (sameBuilder) {
    vscode.window.showInformationMessage(`Codev: Dev server is already running for ${builderName}`);
    await terminalManager.openDevTerminal(sameBuilder.terminalId, builder.id, builderName, true);
    return;
  }
  if (existing.length > 0) {
    const other = existing[0]!;
    const choice = await vscode.window.showWarningMessage(
      `Stop dev for ${other.builderId} and start for ${builderName}?`,
      { modal: true },
      'Yes', 'No',
    );
    if (choice !== 'Yes') { return; }
    await client.killTerminal(other.terminalId);
    terminalManager.closeDevTerminal(other.builderId);
    try {
      await waitForTerminalGone(client, other.terminalId);
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
    vscode.window.showErrorMessage(`Codev: Failed to spawn dev terminal for ${builderName}`);
    return;
  }

  await terminalManager.openDevTerminal(terminal.id, builder.id, builderName, true);
  vscode.window.showInformationMessage(`Codev: Dev server started for ${builderName}`);
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
