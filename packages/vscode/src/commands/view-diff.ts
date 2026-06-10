/**
 * Codev: View Diff — open a builder worktree's delta vs the default branch
 * as a single in-window multi-file diff editor (file list on the left,
 * matching VSCode's built-in "Working Tree" view).
 *
 * This replaces the previously-removed `review-diff.ts`, which drove the
 * same `vscode.changes` editor but resolved file content through `git:`
 * URIs. The `git:` scheme is owned by VSCode's built-in Git extension, and
 * that extension never discovers a worktree living inside the host repo's
 * `.gitignore`d `.builders/<id>/` directory — so it returned empty content
 * ("(N files)" in the title, "No Changed Files" in the body).
 *
 * The fix: never touch the `git:` scheme. The *base* (left) side is backed
 * by our own read-only `codev-diff:` TextDocumentContentProvider (the same
 * pattern as `view-issue.ts`'s `codev-issue:` scheme), populated by running
 * `git` directly against the worktree path; the *worktree* (right) side is
 * a plain `file:` URI. Nothing depends on the Git extension's repository
 * discovery.
 *
 * Base content is keyed by the immutable merge-base SHA, so VSCode's
 * content cache stays correct without a manual `onDidChange`. The right
 * side reads live from disk, so it always reflects committed + uncommitted
 * tracked changes (the full builder delta a reviewer wants mid-flight).
 */

import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { ConnectionManager } from '../connection-manager.js';
import { setDiffInjectSession, upsertDiffInjectEntry, type DiffInjectSessionEntry } from '../diff-inject-codelens.js';

const execFileAsync = promisify(execFile);

export const DIFF_SCHEME = 'codev-diff';

// ── Pure helpers (exported for unit testing — no vscode/git dependency) ──

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface ChangeEntry {
  status: ChangeStatus;
  /** Source path for renames/copies; null otherwise. */
  oldPath: string | null;
  /** Current path (the file as it lives in the worktree). */
  path: string;
}

/**
 * Parse `git diff --name-status -M <ref>` output. Rename/copy lines are
 * `R<score>\told\tnew`; everything else is `<status>\tpath`.
 */
export function parseNameStatus(stdout: string): ChangeEntry[] {
  return stdout
    .split('\n')
    .map(l => l.replace(/\r$/, ''))
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      const status = parts[0]![0]! as ChangeStatus;
      if ((status === 'R' || status === 'C') && parts.length >= 3) {
        return { status, oldPath: parts[1]!, path: parts[parts.length - 1]! };
      }
      return { status, oldPath: null, path: parts[parts.length - 1]! };
    });
}

/**
 * Strip git's rename rendering from a `--numstat` path field:
 *   `src/{old => new}/f.ts` → `src/new/f.ts`
 *   `old/path => new/path`  → `new/path`
 */
export function normalizeNumstatPath(raw: string): string {
  const brace = raw.replace(/\{[^}]*? => ([^}]*?)\}/g, '$1');
  const arrow = brace.includes(' => ') ? brace.split(' => ').pop()! : brace;
  return arrow.trim();
}

/**
 * Paths whose `git diff --numstat -M <ref>` row is `-\t-\t…` (binary).
 */
export function parseBinaryPaths(numstat: string): Set<string> {
  const out = new Set<string>();
  for (const line of numstat.split('\n')) {
    const parts = line.split('\t');
    if (parts.length >= 3 && parts[0] === '-' && parts[1] === '-') {
      out.add(normalizeNumstatPath(parts.slice(2).join('\t')));
    }
  }
  return out;
}

export interface SideSpec {
  /** `base` → git blob at merge-base; `file` → on-disk worktree file;
   *  `empty` → empty doc; `binary` → "not shown" placeholder. */
  kind: 'base' | 'file' | 'empty' | 'binary';
  /** Repo-relative path for `base`/`file` sides. */
  path?: string;
}

export interface ResourcePlan {
  /** New path — drives the file-list icon/label. */
  resourcePath: string;
  left: SideSpec;
  right: SideSpec;
}

/**
 * Decide, per changed file, what the left (original) and right (modified)
 * sides of the diff should be. Pure — no vscode/git.
 */
export function planResources(
  changes: ChangeEntry[],
  binaryPaths: Set<string>,
): ResourcePlan[] {
  return changes.map(c => {
    const resourcePath = c.path;
    if (binaryPaths.has(c.path) || (c.oldPath && binaryPaths.has(c.oldPath))) {
      return { resourcePath, left: { kind: 'binary' }, right: { kind: 'binary' } };
    }
    switch (c.status) {
      case 'A':
        return { resourcePath, left: { kind: 'empty' }, right: { kind: 'file', path: c.path } };
      case 'D':
        return { resourcePath, left: { kind: 'base', path: c.path }, right: { kind: 'empty' } };
      case 'R':
      case 'C':
        return {
          resourcePath,
          left: { kind: 'base', path: c.oldPath ?? c.path },
          right: { kind: 'file', path: c.path },
        };
      default: // M, T, U
        return {
          resourcePath,
          left: { kind: 'base', path: c.path },
          right: { kind: 'file', path: c.path },
        };
    }
  });
}

interface DiffQuery {
  wt: string;
  ref: string;
  path: string;
  empty?: true;
  binary?: true;
}

export function encodeDiffQuery(q: DiffQuery): string {
  return JSON.stringify(q);
}

export function decodeDiffQuery(query: string): DiffQuery {
  return JSON.parse(query) as DiffQuery;
}

// ── codev-diff: content provider ────────────────────────────────────────

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let q: DiffQuery;
    try {
      q = decodeDiffQuery(uri.query);
    } catch {
      return '';
    }
    if (q.empty) { return ''; }
    if (q.binary) { return '// Binary file — not shown\n'; }
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', q.wt, 'show', `${q.ref}:${q.path}`],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      // File didn't exist at the base ref (e.g. added file) → empty side.
      return '';
    }
  }
}

const provider = new DiffContentProvider();

export function activateDiffView(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, provider),
  );
}

// ── URI construction (thin wrappers over the pure encoder) ──────────────

function baseUri(wt: string, ref: string, repoPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/${repoPath}`,
    query: encodeDiffQuery({ wt, ref, path: repoPath }),
  });
}

function placeholderUri(repoPath: string, kind: 'empty' | 'binary'): vscode.Uri {
  const q: DiffQuery = { wt: '', ref: '', path: repoPath, [kind]: true };
  return vscode.Uri.from({
    scheme: DIFF_SCHEME,
    path: `/${repoPath}`,
    query: encodeDiffQuery(q),
  });
}

function sideUri(side: SideSpec, ctx: { wt: string; ref: string; resourcePath: string }): vscode.Uri {
  switch (side.kind) {
    case 'file':
      return vscode.Uri.file(path.join(ctx.wt, side.path!));
    case 'base':
      return baseUri(ctx.wt, ctx.ref, side.path!);
    case 'binary':
      return placeholderUri(ctx.resourcePath, 'binary');
    default:
      return placeholderUri(ctx.resourcePath, 'empty');
  }
}

/**
 * Left/right URIs for one changed file — the shared seam used by both the
 * multi-file `vscode.changes` editor and the per-file `vscode.diff` opened
 * from the Builders tree. Left = base blob (or empty/binary placeholder);
 * right = the on-disk worktree file (or placeholder for deletes/binary).
 */
export function diffUrisForChange(
  plan: ResourcePlan,
  ctx: { wt: string; ref: string },
): { left: vscode.Uri; right: vscode.Uri } {
  const sideCtx = { wt: ctx.wt, ref: ctx.ref, resourcePath: plan.resourcePath };
  return {
    left: sideUri(plan.left, sideCtx),
    right: sideUri(plan.right, sideCtx),
  };
}

// ── Git: a builder's delta vs the default branch ────────────────────────

export interface BuilderChanges {
  /** Branch name resolved from origin/HEAD (e.g. `main`); for titles. */
  defaultBranch: string;
  /** Immutable merge-base SHA used as the base-content cache key. */
  baseRef: string;
  changes: ChangeEntry[];
  binaryPaths: Set<string>;
}

/**
 * Resolve a builder worktree's full delta vs its default branch:
 * default branch (origin/HEAD, fallback `main`) → merge-base SHA (fallback
 * branch name) → `git diff --name-status -M` + `--numstat` against the
 * working tree (committed + uncommitted tracked changes).
 *
 * Throws on git failure so each caller picks its own UX — the command
 * surfaces a toast; the Builders tree shows a placeholder row.
 */
export async function getBuilderChanges(wt: string): Promise<BuilderChanges> {
  // Default branch from origin/HEAD; fall back to `main`.
  let defaultBranch = 'main';
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', wt, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD',
    ]);
    const ref = stdout.trim().replace(/^origin\//, '');
    if (ref) { defaultBranch = ref; }
  } catch {
    // origin/HEAD not set — keep `main`.
  }

  // Merge-base SHA → immutable cache key for base content. Fall back to the
  // branch name if merge-base fails (e.g. unrelated histories).
  let baseRef = defaultBranch;
  try {
    const { stdout } = await execFileAsync('git', [
      '-C', wt, 'merge-base', defaultBranch, 'HEAD',
    ]);
    const sha = stdout.trim();
    if (sha) { baseRef = sha; }
  } catch {
    // keep defaultBranch
  }

  const [nameStatus, numstat] = await Promise.all([
    execFileAsync('git', ['-C', wt, 'diff', '--name-status', '-M', baseRef], { maxBuffer: 64 * 1024 * 1024 }),
    execFileAsync('git', ['-C', wt, 'diff', '--numstat', '-M', baseRef], { maxBuffer: 64 * 1024 * 1024 }),
  ]);
  return {
    defaultBranch,
    baseRef,
    changes: parseNameStatus(nameStatus.stdout),
    binaryPaths: parseBinaryPaths(numstat.stdout),
  };
}

// ── Command ─────────────────────────────────────────────────────────────

export async function viewDiff(
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
  const wt = builder.worktreePath;

  let delta: BuilderChanges;
  try {
    delta = await getBuilderChanges(wt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Codev: git diff failed — ${message}`);
    return;
  }
  const { defaultBranch, baseRef, changes, binaryPaths } = delta;

  if (changes.length === 0) {
    vscode.window.showInformationMessage(
      `Codev: No changes to review yet for #${builder.issueId ?? builder.id}`,
    );
    return;
  }

  const plans = planResources(changes, binaryPaths);

  const resources: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = plans.map(plan => {
    const { left, right } = diffUrisForChange(plan, { wt, ref: baseRef });
    return [
      vscode.Uri.file(path.join(wt, plan.resourcePath)),
      left,
      right,
    ];
  });

  // CodeLens "Forward to Builder" actions (#789): register the right-side fs
  // paths + owning builder for the files just opened. The lenses themselves
  // come from document symbols, resolved lazily by the provider — no git here.
  const entries: DiffInjectSessionEntry[] = plans
    .filter(plan => plan.right.kind === 'file')
    .map(plan => ({
      fsPath: path.join(wt, plan.resourcePath),
      builderId: builder.id,
      relPath: plan.resourcePath,
    }));
  setDiffInjectSession(entries);

  await vscode.commands.executeCommand(
    'vscode.changes',
    `Reviewing #${builder.issueId ?? builder.id} (${defaultBranch} ↔ HEAD)`,
    resources,
  );
}

/**
 * Register the inject-codelens entry for a single changed file — the per-file
 * `vscode.diff` opened from the Builders tree (`openBuilderFileDiff`). Mirrors
 * what `viewDiff` does for the whole delta, but for one file, so the "Forward
 * to Builder" lenses appear even when the reviewer opens a file diff without
 * first running View Diff. The lenses come from document symbols, so no git is
 * needed here — just the path → builder mapping.
 */
export function registerFileInjectSession(args: {
  worktreePath: string;
  builderId: string;
  plan: ResourcePlan;
}): void {
  // Deleted/binary files have no right-side `file:` document to host a lens.
  if (args.plan.right.kind !== 'file') { return; }
  const relPath = args.plan.resourcePath;
  upsertDiffInjectEntry({
    fsPath: path.join(args.worktreePath, relPath),
    builderId: args.builderId,
    relPath,
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
    { placeHolder: 'Select builder to diff against the default branch' },
  );
  return picked?.builder;
}
