/**
 * Pull-request head commits, kept reachable in the main checkout under a
 * Codev-owned hidden ref namespace (#2008).
 *
 * A PR from another contributor (often a fork) has no local branch and no
 * worktree. To diff it, its head commit's objects are fetched **by SHA** into
 * `refs/codev/pr/<id>/head`, and its base branch into `refs/codev/pr/<id>/base`.
 * Refs outside `refs/heads/` create no local branch, never touch the index or
 * the working tree (so `git status` is unchanged), and nothing is checked out
 * or executed — `git fetch` runs no hooks.
 *
 * Forge-neutral by construction: the head SHA comes from the forge contract
 * (`PRView.headRefOid`) and the base is a plain branch name; no forge-specific
 * ref layout (`refs/pull/N/head`, `refs/merge-requests/N/head`) is used. A host
 * that refuses SHA wants surfaces as `fetch-failed`, never a silent fallback.
 *
 * Every git call goes through `execFile` (no shell) with interactive auth
 * prompts disabled, and every input that lands in a refspec is validated first.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The namespace Codev owns. Everything under it is ours to create and delete. */
export const PR_REF_NAMESPACE = 'refs/codev/pr/';

/** The remote PR heads are fetched from — the same assumption the builder diff makes (`origin/HEAD`). */
export const PR_REMOTE = 'origin';

export function pullRequestHeadRef(prId: string): string {
  return `${PR_REF_NAMESPACE}${prId}/head`;
}

export function pullRequestBaseRef(prId: string): string {
  return `${PR_REF_NAMESPACE}${prId}/base`;
}

/** A PR id safe to embed in a ref name: forge ids are numbers, allow a conservative superset. */
export function isSafePullRequestId(prId: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(prId);
}

/** A full commit id: SHA-1 (40) or SHA-256 (64) hex. Abbreviated ids are rejected. */
export function isFullCommitSha(sha: unknown): sha is string {
  return typeof sha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha);
}

export type PullRequestHeadFailure =
  | 'invalid-input'
  | 'shallow'
  | 'fetch-failed'
  | 'base-missing'
  | 'no-merge-base';

export type PullRequestHeadResult =
  | { ok: true; mergeBase: string }
  | { ok: false; kind: PullRequestHeadFailure; detail: string };

function git(repo: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', ['-C', repo, ...args], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function errorDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  if (typeof stderr === 'string' && stderr.trim() !== '') { return stderr.trim(); }
  if (error instanceof Error) { return error.message; }
  return String(error);
}

async function resolveRef(repo: string, ref: string): Promise<string | undefined> {
  try {
    const { stdout } = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = stdout.trim();
    if (sha === '') { return undefined; }
    return sha;
  } catch {
    return undefined;
  }
}

async function isValidBranchName(repo: string, name: string): Promise<boolean> {
  if (name === '' || name.startsWith('-')) { return false; }
  try {
    await git(repo, ['check-ref-format', '--branch', name]);
    return true;
  } catch {
    return false;
  }
}

async function isShallow(repo: string): Promise<boolean> {
  try {
    const { stdout } = await git(repo, ['rev-parse', '--is-shallow-repository']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Concurrent calls for the same PR + head share one run (two expansions, a refresh mid-fetch). */
const inFlight = new Map<string, Promise<PullRequestHeadResult>>();

/**
 * Make the PR's head commit and base branch present under the hidden refs and
 * return the merge-base. Fetches only when the head ref is missing or points at
 * a different commit; the base is fetched alongside, because with the head
 * unchanged a newer base tip cannot change `merge-base(base, head)`.
 */
export function ensurePullRequestHead(
  repo: string,
  pr: { prId: string; headSha: string; baseRefName: string },
): Promise<PullRequestHeadResult> {
  const key = `${repo}\0${pr.prId}\0${pr.headSha}`;
  const pending = inFlight.get(key);
  if (pending) { return pending; }
  const run = runEnsure(repo, pr).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

async function runEnsure(
  repo: string,
  pr: { prId: string; headSha: string; baseRefName: string },
): Promise<PullRequestHeadResult> {
  if (!isSafePullRequestId(pr.prId)) {
    return { ok: false, kind: 'invalid-input', detail: `unsupported pull request id ${JSON.stringify(pr.prId)}` };
  }
  if (!isFullCommitSha(pr.headSha)) {
    return { ok: false, kind: 'invalid-input', detail: `head commit ${JSON.stringify(pr.headSha)} is not a full commit id` };
  }
  if (!(await isValidBranchName(repo, pr.baseRefName))) {
    return { ok: false, kind: 'invalid-input', detail: `base branch ${JSON.stringify(pr.baseRefName)} is not a valid branch name` };
  }
  if (await isShallow(repo)) {
    return { ok: false, kind: 'shallow', detail: 'this checkout is a shallow clone' };
  }

  const headRef = pullRequestHeadRef(pr.prId);
  const baseRef = pullRequestBaseRef(pr.prId);
  const haveHead = (await resolveRef(repo, headRef)) === pr.headSha;
  const haveBase = (await resolveRef(repo, baseRef)) !== undefined;

  if (!haveHead) {
    try {
      await git(repo, ['fetch', '--no-tags', '--quiet', PR_REMOTE, `+${pr.headSha}:${headRef}`]);
    } catch (error) {
      return { ok: false, kind: 'fetch-failed', detail: errorDetail(error) };
    }
  }
  if (!haveHead || !haveBase) {
    try {
      await git(repo, ['fetch', '--no-tags', '--quiet', PR_REMOTE, `+refs/heads/${pr.baseRefName}:${baseRef}`]);
    } catch (error) {
      return { ok: false, kind: 'base-missing', detail: errorDetail(error) };
    }
  }

  try {
    const { stdout } = await git(repo, ['merge-base', baseRef, pr.headSha]);
    const mergeBase = stdout.trim();
    if (!isFullCommitSha(mergeBase)) {
      return { ok: false, kind: 'no-merge-base', detail: `no common history with ${pr.baseRefName}` };
    }
    return { ok: true, mergeBase };
  } catch {
    return { ok: false, kind: 'no-merge-base', detail: `no common history with ${pr.baseRefName}` };
  }
}

/** PR ids that currently own refs under the namespace. */
export async function listPullRequestRefIds(repo: string): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    const { stdout } = await git(repo, ['for-each-ref', '--format=%(refname)', PR_REF_NAMESPACE]);
    for (const line of stdout.split('\n')) {
      const rest = line.trim().slice(PR_REF_NAMESPACE.length);
      const id = rest.split('/')[0];
      if (line.trim().startsWith(PR_REF_NAMESPACE) && id) { ids.add(id); }
    }
  } catch {
    // Not a git repo / git missing: nothing to prune.
  }
  return ids;
}

/**
 * Delete the hidden refs of every PR not in `openIds` — the cleanup once a PR
 * is no longer open. Returns the ids removed. Only refs under
 * `refs/codev/pr/` are ever touched.
 */
export async function prunePullRequestRefs(repo: string, openIds: ReadonlySet<string>): Promise<string[]> {
  const removed: string[] = [];
  for (const id of await listPullRequestRefIds(repo)) {
    if (openIds.has(id) || !isSafePullRequestId(id)) { continue; }
    for (const ref of [pullRequestHeadRef(id), pullRequestBaseRef(id)]) {
      try {
        await git(repo, ['update-ref', '-d', ref]);
      } catch {
        // Already gone.
      }
    }
    removed.push(id);
  }
  return removed;
}
