/**
 * Codev: Run Dev Server — start a Tower-managed dev PTY for a builder's
 * worktree. Right-click a builder row (or palette quick-pick) resolves the
 * builder from Tower's overview, then delegates to the shared dev core
 * (dev-shared.ts), which handles the devCommand read, swap, spawn, and tab
 * open — identical to every other dev front-end; only target resolution
 * differs (see run-workspace-dev.ts).
 */

import * as vscode from 'vscode';
import { resolveAgentName } from '@cluesmith/codev-core/agent-names';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';
import { startDevForTarget } from './dev-shared.js';

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

  // Human-friendly builder name — same source and matching strategy the
  // builder tab uses (openBuilderByRoleOrId in terminal-manager.ts).
  // OverviewBuilder.id and Builder.id can differ in shape, so resolveAgentName
  // does the tail-match fallback rather than strict ===.
  const workspaceState = await client.getWorkspaceState(workspacePath);
  const { builder: namedBuilder } = resolveAgentName(builder.id, workspaceState?.builders ?? []);
  const builderName = namedBuilder?.name ?? builder.id;

  await startDevForTarget(connectionManager, terminalManager, {
    id: builder.id,
    cwd: builder.worktreePath,
    name: builderName,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

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
