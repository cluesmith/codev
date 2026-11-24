/**
 * Git plumbing shared by the `codev check` commands (Spec 1951), all through the runner.
 *
 * Live tips come from `ls-remote` (no remote-tracking ref is updated). Missing objects are
 * fetched in the ref-neutral form, which adds objects to the store and moves no ref, writes
 * no FETCH_HEAD and runs no housekeeping. Path filters are git pathspecs with `:(glob)`
 * magic, so git does the matching; an empty include list never becomes a bare `--`.
 */

import { CheckCommandError } from './report.js';
import type { GitResult, Runner } from './runner.js';
import { isFullSha, isRefName } from './validate.js';

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  text: string;
}

/** `merge-tree --write-tree` (the trial merge). */
export const TRIAL_MERGE_MIN = { major: 2, minor: 38 } as const;
/** `fetch --no-write-fetch-head` (the ref-neutral fetch). */
export const REF_NEUTRAL_FETCH_MIN = { major: 2, minor: 29 } as const;

export type Lookup<T> = { ok: true; value: T } | { ok: false; reason: string };

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

/** Why a git call failed, for a `not run` reason. */
export function failureReason(call: string, result: GitResult, timeoutLabel: string): string {
  if (result.timedOut) return `${call} timed out after ${timeoutLabel}`;
  const detail = firstLine(result.stderr);
  return detail ? `${call} failed: ${detail}` : `${call} failed (exit ${result.exitCode})`;
}

export function parseGitVersion(output: string): GitVersion | null {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(output);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0), text: output.trim() };
}

export async function gitVersion(runner: Runner): Promise<GitVersion> {
  const result = await runner.git(['version']);
  const version = result.exitCode === 0 ? parseGitVersion(result.stdout) : null;
  if (!version) throw new CheckCommandError('could not determine the git version', result.stderr.trim() || result.stdout.trim());
  return version;
}

export function atLeast(version: GitVersion, min: { major: number; minor: number }): boolean {
  return version.major > min.major || (version.major === min.major && version.minor >= min.minor);
}

export function versionLabel(version: GitVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/** The live tip of `origin/<branch>`, or null when the branch does not exist there. */
export async function liveTip(runner: Runner, branch: string): Promise<Lookup<string | null>> {
  if (!isRefName(branch)) return { ok: false, reason: `invalid branch name ${JSON.stringify(branch)}` };
  const ref = `refs/heads/${branch}`;
  const result = await runner.git(['ls-remote', 'origin', ref]);
  if (result.exitCode !== 0) return { ok: false, reason: failureReason('ls-remote', result, runner.timeoutLabel) };
  for (const line of result.stdout.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && sha && isFullSha(sha)) return { ok: true, value: sha };
  }
  return { ok: true, value: null };
}

/** The branch `origin`'s HEAD points at, or null when the remote does not say. */
export async function remoteDefaultBranch(runner: Runner): Promise<Lookup<string | null>> {
  const result = await runner.git(['ls-remote', '--symref', 'origin', 'HEAD']);
  if (result.exitCode !== 0) return { ok: false, reason: failureReason('ls-remote', result, runner.timeoutLabel) };
  const match = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(result.stdout);
  if (!match) return { ok: true, value: null };
  if (!isRefName(match[1])) return { ok: false, reason: `origin's HEAD names an invalid branch ${JSON.stringify(match[1])}` };
  return { ok: true, value: match[1] };
}

export async function hasCommit(runner: Runner, sha: string): Promise<boolean> {
  const result = await runner.git(['cat-file', '-e', `${sha}^{commit}`]);
  return result.exitCode === 0;
}

/**
 * Make each commit available locally, fetching only the missing ones, ref-neutrally.
 * Returns, per SHA, null when it is available or the reason it is not.
 */
export async function ensureCommits(runner: Runner, shas: readonly string[], version: GitVersion): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const missing: string[] = [];
  for (const sha of new Set(shas)) {
    if (await hasCommit(runner, sha)) result.set(sha, null);
    else missing.push(sha);
  }
  if (missing.length === 0) return result;

  const unavailable = (reason: string): void => {
    for (const sha of missing) result.set(sha, `${sha.slice(0, 7)} not available locally (${reason})`);
  };
  if (!atLeast(version, REF_NEUTRAL_FETCH_MIN)) {
    unavailable(`git ${versionLabel(version)} cannot fetch without moving a ref; needs ${REF_NEUTRAL_FETCH_MIN.major}.${REF_NEUTRAL_FETCH_MIN.minor}`);
    return result;
  }
  const notFull = missing.filter((sha) => !isFullSha(sha));
  if (notFull.length > 0) throw new CheckCommandError(`cannot fetch abbreviated SHA ${notFull[0]}; a full 40-hex SHA is needed`);

  const fetch = await runner.git([
    '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
    'fetch', '--no-write-fetch-head', '--refmap=', '--no-tags', '--no-recurse-submodules', '--quiet', 'origin', ...missing,
  ]);
  if (fetch.exitCode !== 0) {
    unavailable(failureReason('fetch', fetch, runner.timeoutLabel));
    return result;
  }
  for (const sha of missing) {
    result.set(sha, (await hasCommit(runner, sha)) ? null : `${sha.slice(0, 7)} not available locally (origin did not provide it)`);
  }
  return result;
}

/** Resolve a revision to its full commit SHA, or null when it does not name a commit. */
export async function resolveCommit(runner: Runner, revision: string): Promise<string | null> {
  const result = await runner.git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`]);
  const sha = result.stdout.trim();
  return result.exitCode === 0 && isFullSha(sha) ? sha : null;
}

export async function mergeBase(runner: Runner, a: string, b: string): Promise<string | null> {
  const result = await runner.git(['merge-base', a, b]);
  if (result.exitCode === 1) return null;
  if (result.exitCode !== 0) throw new CheckCommandError(`git merge-base ${a} ${b} failed`, result.stderr.trim());
  return result.stdout.trim();
}

/** Whether `ancestor` is reachable from `descendant` (a commit is its own ancestor). */
export async function isAncestor(runner: Runner, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runner.git(['merge-base', '--is-ancestor', ancestor, descendant]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new CheckCommandError(`git merge-base --is-ancestor ${ancestor} ${descendant} failed`, result.stderr.trim());
}

// =============================================================================
// Pathspecs
// =============================================================================

export interface PathFilter {
  /** Globs a path must match one of. An empty list matches nothing. Absent: all paths. */
  include?: readonly string[];
  /** Globs that remove a path. */
  exclude?: readonly string[];
}

/**
 * The pathspec arguments for a filter, or null when the filter matches nothing (an empty
 * include list). `top` magic anchors every pattern at the repository root, whatever the
 * directory git runs in.
 */
export function pathspecArgs(filter: PathFilter): string[] | null {
  if (filter.include !== undefined && filter.include.length === 0) return null;
  const include = filter.include?.map((p) => `:(top,glob)${p}`) ?? [];
  const exclude = filter.exclude?.map((p) => `:(top,exclude,glob)${p}`) ?? [];
  if (include.length === 0 && exclude.length === 0) return [];
  return ['--', ...(include.length > 0 ? include : [':(top)']), ...exclude];
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** Files that differ between two commits, sorted, renames shown as delete plus add. */
export async function changedFiles(runner: Runner, from: string, to: string, filter: PathFilter = {}): Promise<string[]> {
  const pathspecs = pathspecArgs(filter);
  if (pathspecs === null) return [];
  const result = await runner.git(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--no-renames', from, to, ...pathspecs]);
  if (result.exitCode !== 0) throw new CheckCommandError(`git diff ${from} ${to} failed`, result.stderr.trim());
  return splitNul(result.stdout).sort();
}

export interface FileStat {
  path: string;
  additions: number;
  deletions: number;
  /** Git reported the file as binary (no line counts). */
  binary: boolean;
}

/** Line counts per changed file between two commits. */
export async function numstat(runner: Runner, from: string, to: string, filter: PathFilter = {}): Promise<FileStat[]> {
  const pathspecs = pathspecArgs(filter);
  if (pathspecs === null) return [];
  const result = await runner.git(['diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', '--no-renames', from, to, ...pathspecs]);
  if (result.exitCode !== 0) throw new CheckCommandError(`git diff --numstat ${from} ${to} failed`, result.stderr.trim());
  const stats: FileStat[] = [];
  for (const entry of splitNul(result.stdout)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    if (!match) throw new CheckCommandError(`unexpected git diff --numstat output ${JSON.stringify(entry)}`);
    const binary = match[1] === '-';
    stats.push({ path: match[3], additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary });
  }
  return stats.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
