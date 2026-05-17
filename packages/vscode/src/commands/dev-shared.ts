/**
 * Shared core for Codev dev-server commands. There is exactly one underlying
 * action — "spawn a Tower dev PTY for a {id, cwd} target and open its tab" —
 * with two front-ends that differ only in how they resolve the target:
 *
 *   - run-worktree-dev.ts : target picked from Tower's builder overview
 *     (right-click a Builders row / palette quick-pick).
 *   - run-workspace-dev.ts: target = whatever folder *this VSCode window* is
 *     rooted at (main checkout → `main`; a `.builders/<id>/` worktree → that
 *     builder), via resolveWorkspaceDevTarget().
 *
 * Swap-sequencing constants mirror the CLI's `afx dev`
 * (packages/codev/src/agent-farm/commands/dev.ts).
 */

import * as vscode from 'vscode';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';

export const KILL_WAIT_TIMEOUT_MS = 7000;
export const KILL_POLL_INTERVAL_MS = 200;
export const SWAP_GRACE_MS = 250;

/** A resolved dev target: which id to run under, where, and how to label it. */
export interface DevTarget {
  /** roleId + swap key + `Dev: <id>` label suffix (e.g. `main`, `pir-1467`). */
  id: string;
  /** Working directory the dev command runs in. */
  cwd: string;
  /** Human-facing name for toasts / the terminal tab (e.g. `Workspace`). */
  name: string;
}

/**
 * Resolve the dev target from the folder *this VSCode window* is rooted at.
 *
 * Path-sniffing against the fixed `<root>/.builders/<id>/` layout that
 * `afx spawn` creates (the same invariant findProjectRoot / openWorktreeWindow
 * already rely on) — deterministic, offline, no Tower round-trip:
 *   - parent dir is `.builders` → builder worktree, id = basename
 *   - otherwise                 → the main checkout, id = `main`
 */
export function resolveWorkspaceDevTarget(workspacePath: string): DevTarget {
  if (path.basename(path.dirname(workspacePath)) === '.builders') {
    const id = path.basename(workspacePath);
    return { id, cwd: workspacePath, name: id };
  }
  return { id: 'main', cwd: workspacePath, name: 'Workspace' };
}

/** Read `worktree.devCommand` from `.codev/config.json`; null if unset/unreadable. */
export async function readDevCommand(workspacePath: string): Promise<string | null> {
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

/** Poll `listTerminals` until the killed terminal disappears (or timeout). */
export async function waitForTerminalGone(
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

/**
 * Start (or focus) the dev PTY for a resolved target. Single-dev-slot model:
 * one dev at a time across {main + all builders} because they all bind main's
 * ports — a different running target prompts for swap. Identical for every
 * front-end; only target resolution differs.
 */
export async function startDevForTarget(
  connectionManager: ConnectionManager,
  terminalManager: TerminalManager,
  target: DevTarget,
): Promise<void> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }

  const devCommand = await readDevCommand(workspacePath);
  if (!devCommand) {
    vscode.window.showErrorMessage(
      'Codev: Configure worktree.devCommand in .codev/config.json to use this action. ' +
      'See "Runnable Worktrees" in CLAUDE.md for stack-specific recipes.',
    );
    return;
  }

  // Swap detection (per-VSCode-instance; cross-instance is a #690 non-goal).
  const existing = terminalManager.listDevTerminals();
  const same = existing.find(d => d.builderId === target.id);
  if (same) {
    vscode.window.showInformationMessage(`Codev: Dev server is already running for ${target.name}`);
    await terminalManager.openDevTerminal(same.terminalId, target.id, target.name, true);
    return;
  }
  if (existing.length > 0) {
    const other = existing[0]!;
    const choice = await vscode.window.showWarningMessage(
      `Stop dev for ${other.builderId} and start ${target.name}?`,
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

  const terminal = await client.createTerminal({
    command: '/bin/sh',
    args: ['-lc', devCommand],
    cwd: target.cwd,
    workspacePath,
    type: 'dev',
    roleId: target.id,
    label: `Dev: ${target.id}`,
    persistent: false,
  });
  if (!terminal) {
    vscode.window.showErrorMessage(`Codev: Failed to spawn dev terminal for ${target.name}`);
    return;
  }

  await terminalManager.openDevTerminal(terminal.id, target.id, target.name, true);
  vscode.window.showInformationMessage(`Codev: Dev server started for ${target.name}`);
}

/** Stop the dev PTY for a single target id (scoped — does not touch others). */
export async function stopDevForTarget(
  connectionManager: ConnectionManager,
  terminalManager: TerminalManager,
  targetId: string,
  name: string,
): Promise<void> {
  const client = connectionManager.getClient();
  if (!client || connectionManager.getState() !== 'connected') {
    vscode.window.showErrorMessage('Codev: Not connected to Tower');
    return;
  }
  const found = terminalManager.listDevTerminals().find(d => d.builderId === targetId);
  if (!found) {
    vscode.window.showInformationMessage(`Codev: No dev server is running for ${name}`);
    return;
  }
  await client.killTerminal(found.terminalId);
  terminalManager.closeDevTerminal(targetId);
  vscode.window.showInformationMessage(`Codev: Dev server stopped for ${name}`);
}
