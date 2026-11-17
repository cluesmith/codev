import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseBuilderWorktreePath } from '@cluesmith/codev-sdk/builder-worktree';

/**
 * Whether a directory is itself a codev workspace root: it directly
 * contains a `.codev/` or `codev/` entry.
 *
 * Deliberately NO ancestor walk (#1144). Detection used to traverse
 * upward to the filesystem root looking for these markers, which made
 * every folder under a codev-enabled home directory silently inherit
 * that workspace — and with `onStartupFinished` activation, detection
 * is now an inertness gate that runs in every window, so it must be
 * exactly as predictable as "the folder you opened is the workspace".
 * Builder worktrees carry their own `codev/` copy so they match here too;
 * `detectWorkspace` classifies them separately (#1809) so the window never
 * activates them as workspaces of their own.
 * Layouts where the marker genuinely lives above the opened folder are
 * served by the `codev.workspacePath` setting override.
 */
export function isCodevWorkspaceRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.codev'))
    || fs.existsSync(path.join(dir, 'codev'));
}

/**
 * What this window is rooted at, as far as Codev is concerned.
 *
 * - `root`: a codev workspace root; the window activates it in Tower.
 * - `builder-worktree` (#1809): a `<root>/.builders/<id>` worktree. Codev never
 *   activates a worktree; the window attaches read-only to `workspaceRoot`.
 */
export type DetectedWorkspace =
  | { kind: 'root'; path: string }
  | { kind: 'builder-worktree'; path: string; workspaceRoot: string; builderId: string };

/**
 * Classify this window. Priority: setting override > first workspace folder
 * (if it is a codev workspace root). Returns null when neither applies — the
 * caller treats that as "not a codev window". An override pointing into a
 * worktree is classified as a worktree too.
 */
export function detectWorkspace(): DetectedWorkspace | null {
  const override = vscode.workspace.getConfiguration('codev').get<string>('workspacePath');
  if (override) {
    return classify(override);
  }

  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return null;
  }

  const root = folders[0].uri.fsPath;
  if (isCodevWorkspaceRoot(root)) {
    return classify(root);
  }
  return null;
}

function classify(dir: string): DetectedWorkspace {
  const worktree = parseBuilderWorktreePath(dir);
  if (worktree) {
    return {
      kind: 'builder-worktree',
      path: worktree.worktreePath,
      workspaceRoot: worktree.workspaceRoot,
      builderId: worktree.builderId,
    };
  }
  return { kind: 'root', path: dir };
}

/**
 * The workspace path this window talks to Tower about: the root itself, or a
 * worktree's parent root (#1809). Null when this is not a codev window.
 */
export function towerWorkspacePath(detected: DetectedWorkspace | null): string | null {
  if (!detected) {
    return null;
  }
  if (detected.kind === 'builder-worktree') {
    return detected.workspaceRoot;
  }
  return detected.path;
}

/** Shorthand for `towerWorkspacePath(detectWorkspace())`. */
export function detectWorkspacePath(): string | null {
  return towerWorkspacePath(detectWorkspace());
}

/** Whether this window is rooted at a builder worktree (#1809). */
export function detectIsBuilderWorktree(): boolean {
  return detectWorkspace()?.kind === 'builder-worktree';
}

/**
 * Get Tower host and port from VS Code settings.
 */
export function getTowerAddress(): { host: string; port: number } {
  const config = vscode.workspace.getConfiguration('codev');
  return {
    host: config.get<string>('towerHost', 'localhost'),
    port: config.get<number>('towerPort', 4100),
  };
}
