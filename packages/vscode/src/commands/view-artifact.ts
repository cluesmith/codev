/**
 * Codev: View Plan File — open the plan markdown a gated PIR builder is
 * waiting on directly in a VSCode editor tab.
 *
 * Right-click a builder row → "View Plan File".
 *
 * Strategy: locate `<worktree>/codev/plans/`, filter to files prefixed
 * with the builder ID, and:
 *   - 0 files  → friendly message ("no file yet — the builder hasn't written one")
 *   - 1 file   → open it
 *   - 2+ files → quick-pick (newer files float to the top)
 *
 * View Review File was intentionally not added: the review file is the
 * PR body in PIR's review phase, so reviewers read it on GitHub when
 * it matters.
 */

import * as vscode from 'vscode';
import { resolve } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { ConnectionManager } from '../connection-manager.js';

type ArtifactKind = 'plan';

const ARTIFACT_SUBDIR: Record<ArtifactKind, string> = {
  plan: 'codev/plans',
};

export function viewPlanFile(connectionManager: ConnectionManager, builderIdArg: string | undefined) {
  return viewArtifact(connectionManager, builderIdArg, 'plan');
}

async function viewArtifact(
  connectionManager: ConnectionManager,
  builderIdArg: string | undefined,
  kind: ArtifactKind,
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
    : await pickBuilder(builders, kind);
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

  const artifactDir = resolve(builder.worktreePath, ARTIFACT_SUBDIR[kind]);
  if (!existsSync(artifactDir)) {
    vscode.window.showInformationMessage(
      `Codev: No ${kind} file yet — ${ARTIFACT_SUBDIR[kind]}/ doesn't exist in the worktree.`,
    );
    return;
  }

  // Filter to files belonging to THIS builder. Plan/review files written by
  // PIR builders are named `<builder-id>-<slug>.md` (e.g. `pir-1298-fix-foo.md`),
  // so the builder ID prefix is the natural filter. Other builders' files for
  // the same protocol live in the same dir and would otherwise show up in the
  // quick-pick.
  const builderPrefix = `${builder.id}-`;
  const files = readdirSync(artifactDir)
    .filter(f =>
      f.endsWith('.md') &&
      (f.startsWith(builderPrefix) || f === `${builder.id}.md`)
    )
    .map(f => ({ name: f, path: resolve(artifactDir, f), mtime: safeMtime(resolve(artifactDir, f)) }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    vscode.window.showInformationMessage(
      `Codev: No ${kind} file for builder ${builder.id} yet — the builder hasn't written one.`,
    );
    return;
  }

  let target: string;
  if (files.length === 1) {
    target = files[0].path;
  } else {
    const picked = await vscode.window.showQuickPick(
      files.map(f => ({ label: f.name, description: relativeTime(f.mtime), path: f.path })),
      { placeHolder: `Select ${kind} file to open` },
    );
    if (!picked) {
      return;
    }
    target = picked.path;
  }

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  await vscode.window.showTextDocument(doc, { preview: false });
}

function safeMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function relativeTime(mtime: number): string {
  if (mtime === 0) { return ''; }
  const seconds = Math.floor((Date.now() - mtime) / 1000);
  if (seconds < 60) { return `${seconds}s ago`; }
  if (seconds < 3600) { return `${Math.floor(seconds / 60)}m ago`; }
  if (seconds < 86400) { return `${Math.floor(seconds / 3600)}h ago`; }
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface BuilderLike {
  id: string;
  issueId: string | null;
  issueTitle: string | null;
}

async function pickBuilder<T extends BuilderLike>(builders: T[], kind: ArtifactKind): Promise<T | undefined> {
  const picked = await vscode.window.showQuickPick(
    builders.map(b => ({
      label: `#${b.issueId ?? b.id} ${b.issueTitle ?? ''}`,
      builder: b,
    })),
    { placeHolder: `Select builder whose ${kind} file to open` },
  );
  return picked?.builder;
}
