/**
 * The `checks` check of `codev check pr` (Spec 1951 § Porch-only heads): CI on the commit
 * that carries the code.
 *
 * A builder's last commits are usually porch bookkeeping. A commit is **porch-only** when it
 * has exactly one parent and changes nothing outside `codev/projects/`. The **last code
 * commit** C is the first commit that is not porch-only on the head's first-parent chain,
 * walking toward the merge-base. Every commit from C to head has the same code, so the
 * **code runs** are the newest complete runs in that range.
 *
 * Finding C reads at most 11 commits; more than 10 porch-only commits and the check is not
 * run. The selection of the code runs is pure: it takes the lookup as a function, and asks
 * for at most 10 commits, newest first, C always among them.
 */

import type { CommitCheckItem, CommitCheckState } from '../../lib/forge-contracts.js';
import type { Lookup } from './git-facts.js';
import { short } from './render.js';
import { check, CheckCommandError, describeRuns, notRun, summarizeRuns, type Check, type CommitRuns } from './report.js';
import type { Runner } from './runner.js';
import { isFullSha } from './validate.js';

/** Porch state lives here; a commit that changes only paths under it is porch-only. */
export const PORCH_STATE_DIR = 'codev/projects/';
/** More porch-only commits than this above the code, and the check is not run. */
export const MAX_PORCH_ONLY = 10;
/** At most this many `commit-checks` lookups per run. */
export const MAX_LOOKUPS = 10;

// =============================================================================
// Finding the last code commit
// =============================================================================

export interface ChainCommit {
  sha: string;
  parents: string[];
}

/** Parse `rev-list --parents`: each line a commit, then its parents. */
export function parseParents(output: string): ChainCommit[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [sha, ...parents] = line.split(' ');
      const bad = [sha, ...parents].find((s) => !isFullSha(s));
      if (bad !== undefined) throw new CheckCommandError(`unexpected git rev-list output: ${JSON.stringify(bad)} is not a commit SHA`);
      return { sha, parents };
    });
}

/** Porch-only: exactly one parent, and every changed path under `codev/projects/`. */
export function isPorchOnly(parentCount: number, changed: readonly string[]): boolean {
  return parentCount === 1 && changed.every((path) => path.startsWith(PORCH_STATE_DIR));
}

export type CodeCommit =
  /** `above`: the porch-only commits from head down to C, newest first (empty when head is C). */
  | { kind: 'found'; sha: string; above: string[] }
  /** The walk reached the merge-base: every commit on the branch is porch-only. */
  | { kind: 'none'; porchOnly: string[] }
  | { kind: 'too-many' };

/** Walk the head's first-parent chain toward the merge-base and find C. */
export async function findCodeCommit(runner: Runner, head: string, mergeBase: string): Promise<CodeCommit> {
  const walk = await runner.git(['rev-list', '--first-parent', '--parents', `--max-count=${MAX_PORCH_ONLY + 1}`, head, '--not', mergeBase]);
  if (walk.exitCode !== 0) throw new CheckCommandError(`git rev-list ${head} --not ${mergeBase} failed`, walk.stderr.trim());
  const chain = parseParents(walk.stdout);
  const above: string[] = [];
  for (const commit of chain) {
    if (commit.parents.length === 1 && isPorchOnly(commit.parents.length, await changedInCommit(runner, commit.parents[0], commit.sha))) {
      above.push(commit.sha);
      continue;
    }
    return { kind: 'found', sha: commit.sha, above };
  }
  return chain.length > MAX_PORCH_ONLY ? { kind: 'too-many' } : { kind: 'none', porchOnly: above };
}

async function changedInCommit(runner: Runner, parent: string, sha: string): Promise<string[]> {
  const result = await runner.git(['diff-tree', '--no-ext-diff', '--no-textconv', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', parent, sha]);
  if (result.exitCode !== 0) throw new CheckCommandError(`git diff-tree ${parent} ${sha} failed`, result.stderr.trim());
  return result.stdout.split('\0').filter((path) => path !== '');
}

// =============================================================================
// Lookups
// =============================================================================

const STATES: ReadonlySet<CommitCheckState> = new Set(['pass', 'fail', 'pending', 'skipped', 'neutral']);

/** Validate `commit-checks` output. A failure reason names the concept. */
export function parseCommitChecks(data: unknown): Lookup<CommitCheckItem[]> {
  if (!Array.isArray(data)) return { ok: false, reason: 'commit-checks returned something other than a JSON array' };
  const items: CommitCheckItem[] = [];
  for (const [index, raw] of data.entries()) {
    const where = `commit-checks item ${index + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: `${where} is not an object` };
    const { name, state, url, workflow } = raw as Record<string, unknown>;
    if (typeof name !== 'string' || name === '') return { ok: false, reason: `${where} has no name` };
    if (typeof state !== 'string' || !STATES.has(state as CommitCheckState)) {
      return { ok: false, reason: `${where} (${name}) has state ${JSON.stringify(state)}, not one of ${[...STATES].join('/')}` };
    }
    const item: CommitCheckItem = { name, state: state as CommitCheckState };
    if (url !== undefined) {
      if (typeof url !== 'string') return { ok: false, reason: `${where} (${name}) has a url that is not a string` };
      item.url = url;
    }
    if (workflow !== undefined) {
      if (typeof workflow !== 'string') return { ok: false, reason: `${where} (${name}) has a workflow that is not a string` };
      item.workflow = workflow;
    }
    items.push(item);
  }
  return { ok: true, value: items };
}

/** The runs on one commit, through the runner's `commit-checks`. */
export async function lookupRuns(runner: Runner, sha: string): Promise<Lookup<CommitRuns>> {
  const outcome = await runner.forge('commit-checks', { CODEV_COMMIT_SHA: sha });
  if (!outcome.ok) return { ok: false, reason: outcome.reason };
  const parsed = parseCommitChecks(outcome.data);
  return parsed.ok ? { ok: true, value: summarizeRuns(sha, parsed.value) } : parsed;
}

export type RunsLookup = (sha: string) => Promise<Lookup<CommitRuns>>;

export interface Selection {
  head: CommitRuns;
  /** The code runs, or null when no commit from C to head has any. */
  code: CommitRuns | null;
  /** Every commit looked up, in order. */
  queried: string[];
}

function allPassed(runs: CommitRuns): boolean {
  return runs.runs.length > 0 && runs.failed === 0 && runs.pending === 0;
}

/**
 * Choose the code runs. `range` is C..head, newest first: head is `range[0]`, C the last.
 *
 *   1. Look up head (H).
 *   2. Head is C: the code runs are H.
 *   3. H is non-empty and all passed: the code runs are H.
 *   4. Otherwise walk from head^1 down to C; the first commit whose runs are non-empty and
 *      all complete has the code runs.
 *   5. Failing that, the first commit in the walk with any runs, even pending ones.
 *   6. Failing that, there are no code runs.
 *
 * The walk is cut so the lookups stay within MAX_LOOKUPS, keeping C: with exactly ten
 * porch-only commits above C, the oldest of them is not looked up.
 */
export async function selectCodeRuns(range: readonly string[], lookup: RunsLookup): Promise<Lookup<Selection>> {
  if (range.length === 0) throw new Error('selectCodeRuns needs at least the head');
  const queried: string[] = [];
  const get = async (sha: string): Promise<Lookup<CommitRuns>> => {
    queried.push(sha);
    return lookup(sha);
  };

  const h = await get(range[0]);
  if (!h.ok) return h;
  const head = h.value;
  if (range.length === 1) return { ok: true, value: { head, code: head.runs.length > 0 ? head : null, queried } };
  if (allPassed(head)) return { ok: true, value: { head, code: head, queried } };

  const codeCommit = range[range.length - 1];
  let walk = range.slice(1);
  if (walk.length > MAX_LOOKUPS - 1) walk = [...walk.slice(0, MAX_LOOKUPS - 2), codeCommit];
  let firstWithRuns: CommitRuns | null = null;
  for (const sha of walk) {
    const r = await get(sha);
    if (!r.ok) return r;
    if (r.value.runs.length === 0) continue;
    if (r.value.pending === 0) return { ok: true, value: { head, code: r.value, queried } };
    firstWithRuns ??= r.value;
  }
  return { ok: true, value: { head, code: firstWithRuns, queried } };
}

// =============================================================================
// The check
// =============================================================================

export type ChecksProblem = 'failed' | 'running' | 'none';

/**
 * What keeps the check from `ok`, or null when nothing does. A failure anywhere comes first;
 * then a pending run anywhere (wait and re-run); then no code runs at all.
 */
export function checksProblem(head: CommitRuns, code: CommitRuns | null): ChecksProblem | null {
  if (head.failed > 0 || (code?.failed ?? 0) > 0) return 'failed';
  if (head.pending > 0 || (code?.pending ?? 0) > 0) return 'running';
  if (code === null || code.runs.length === 0) return 'none';
  return null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * The `checks` line. One line when head carries the code runs; otherwise the code runs, then
 * head, so a run still going reads differently than one that failed.
 */
function describeSelection(range: readonly string[], selection: Selection): string {
  const { head, code } = selection;
  const codeCommit = range[range.length - 1];
  const porchOnlyAbove = range.length - 1;
  const headLine = porchOnlyAbove === 0 ? `head ${short(head.sha)}: ${describeRuns(head)}` : `head ${short(head.sha)}: porch-only, ${describeRuns(head)}`;
  if (porchOnlyAbove === 0 || code === head) return headLine;
  const codeLine = code ? `code ${short(code.sha)}: ${describeRuns(code)}` : `code ${short(codeCommit)}: no runs`;
  const tail =
    head.runs.length === 0 ? `head ${short(head.sha)}: no runs — ${plural(porchOnlyAbove, 'porch-state commit')} above the code` : headLine;
  return `${codeLine}\n${tail}`;
}

/**
 * The check for a selection over `range` (C..head, newest first). `ok` only when the code
 * runs exist and all passed (skipped and neutral count as passed) and nothing on head
 * failed or is pending.
 */
export function checksResult(range: readonly string[], selection: Selection): Check {
  const details: Record<string, unknown> = {
    head: selection.head,
    ...(selection.code ? { code: selection.code } : {}),
    lastCodeCommit: range[range.length - 1],
    porchOnlyAbove: range.length - 1,
  };
  const problem = checksProblem(selection.head, selection.code);
  return check('checks', problem === null ? 'ok' : 'attention', describeSelection(range, selection), details);
}

/** The checks the project's CI reported on the PR's code. A failing local git call throws (exit 2). */
export async function checkChecks(runner: Runner, head: string, mergeBase: string): Promise<Check> {
  const lookup: RunsLookup = (sha) => lookupRuns(runner, sha);
  const found = await findCodeCommit(runner, head, mergeBase);
  if (found.kind === 'too-many') return notRun('checks', `more than ${MAX_PORCH_ONLY} porch-only commits`);

  if (found.kind === 'none') {
    const h = await lookup(head);
    if (!h.ok) return notRun('checks', h.reason);
    const count = found.porchOnly.length;
    return check(
      'checks',
      'attention',
      `head ${short(head)}: ${describeRuns(h.value)} — no code commit: ${count === 1 ? 'the one commit' : `all ${count} commits`} since the branch point ${count === 1 ? 'is' : 'are'} porch-only`,
      { head: h.value, lastCodeCommit: null, porchOnlyAbove: count },
    );
  }

  const range = [...found.above, found.sha];
  const selected = await selectCodeRuns(range, lookup);
  return selected.ok ? checksResult(range, selected.value) : notRun('checks', selected.reason);
}
