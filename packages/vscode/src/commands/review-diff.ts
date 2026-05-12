/**
 * Codev: View Diff — open `main...HEAD` for a builder's worktree as a
 * single multi-file diff editor (matches VSCode's built-in "Working Tree"
 * view in the Source Control panel).
 *
 * Right-click a builder row → "View Diff". Opens ONE tab with a file
 * list on the left and a diff that updates as the reviewer clicks each
 * file. Handles added / modified / deleted files uniformly via VSCode's
 * `vscode.changes` command.
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

  // Resolve the builder. Quick-pick fallback for command-palette invocation.
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

  // Enumerate changed files with status letters so we can handle
  // added (A) / deleted (D) files distinctly from modified (M).
  let changes: Array<{ status: string; path: string }>;
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', builder.worktreePath,
      'diff', '--name-status', 'main...HEAD',
    ]);
    changes = stdout
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .map(line => {
        // Status letter, then tab(s), then the path. For renames/copies the
        // line is "R100\told\tnew" — take the new (last) path.
        const parts = line.split('\t');
        return { status: parts[0]![0]!, path: parts[parts.length - 1]! };
      });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Codev: git diff failed — ${message}`);
    return;
  }

  if (changes.length === 0) {
    vscode.window.showInformationMessage(`Codev: No changes to review yet for ${builder.id}`);
    return;
  }

  // Build the resources array for vscode.changes. Each entry is a tuple of
  // [resourceUri, leftUri, rightUri]:
  //   - resourceUri: the file as it lives in the worktree (used for icon /
  //     file-list display)
  //   - leftUri: main's version (empty for added files)
  //   - rightUri: worktree's version (empty for deleted files)
  // Empty sides are signalled with the `git:` URI at a non-existent ref —
  // VSCode's diff editor renders that as a one-sided view.
  const resources: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = changes.map(({ status, path: rel }) => {
    const abs = path.join(builder.worktreePath, rel);
    const resourceUri = vscode.Uri.file(abs);
    const mainUri = toGitUri(abs, rel, 'main');
    const headUri = vscode.Uri.file(abs);

    if (status === 'A') {
      // Added: no main version. Left = empty, right = file.
      return [resourceUri, emptyGitUri(abs, rel), headUri];
    }
    if (status === 'D') {
      // Deleted: no worktree version. Left = main, right = empty.
      return [resourceUri, mainUri, emptyGitUri(abs, rel)];
    }
    // Modified / renamed / copied / unmerged → side-by-side diff
    return [resourceUri, mainUri, headUri];
  });

  await vscode.commands.executeCommand(
    'vscode.changes',
    `Reviewing ${builder.id} (main ↔ HEAD)`,
    resources,
  );
}

/**
 * Build a `git:` URI VSCode's built-in Git extension resolves against the
 * worktree's shared object database. Matches the Git extension's canonical
 * `toGitUri` shape: scheme=git, path=fsPath, query=JSON of `{ path, ref }`.
 */
function toGitUri(absPath: string, relPath: string, ref: string): vscode.Uri {
  return vscode.Uri.file(absPath).with({
    scheme: 'git',
    query: JSON.stringify({ path: relPath, ref }),
  });
}

/**
 * URI that renders as empty content in the diff editor. Used for the
 * "missing" side of added/deleted files. We use a `git:` URI at a known
 * empty ref (`HEAD~0` resolves but the file doesn't exist for added files;
 * the Git extension returns empty content for unresolved paths at a valid
 * ref). If that ever becomes flaky, the alternative is a `data:` URI or
 * an untitled scheme.
 */
function emptyGitUri(absPath: string, relPath: string): vscode.Uri {
  return vscode.Uri.file(absPath).with({
    scheme: 'git',
    query: JSON.stringify({ path: relPath, ref: '' }),
  });
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
