/**
 * The `codev check` report model, schema 1 (Spec 1951 § JSON schema), with the verdict and
 * exit-code rules (§ Output and exit codes).
 */

import type { CommitCheckItem } from '../../lib/forge-contracts.js';
import type { SpawnFn } from './runner.js';
import { InputError } from './validate.js';
import { RunnerRefusal } from './allow-list.js';

/** What every command function takes. Tests call the functions in process with these. */
export interface CommandOptions {
  /** Directory the command was run from. */
  cwd: string;
  /** Limit for each forge call and networked git call; default 30 s. */
  timeoutMs?: number;
  /** Extra environment for every subprocess (tests isolate git config and put stubs on PATH). */
  env?: Record<string, string>;
  /** Injected for tests; defaults to `child_process.spawn` inside the runner. */
  spawn?: SpawnFn;
}

/** A command's outcome: the report (or the exit-2 error report) and the exit code. */
export interface CommandResult<R extends Report> {
  report: R | ErrorReport;
  exitCode: 0 | 1 | 2;
}

export type Status = 'ok' | 'attention' | 'info' | 'not-run' | 'off' | 'skip';
export type CommandName = 'pr' | 'deploy' | 'worktree';
export type Verdict = 'clear' | 'attention';

export interface Check {
  /** A check id from the lists below. */
  id: string;
  status: Status;
  /** The one-line text the human form prints (continuation lines separated by `\n`). */
  summary: string;
  /** Per-id shape (spec § JSON schema); `{}` when there is nothing more. */
  details: Record<string, unknown>;
  /** For not-run / off / skip: why, naming the concept, key or git version. */
  reason?: string;
}

export interface Report {
  schema: 1;
  command: CommandName;
  verdict: Verdict;
  generatedAt: string;
}

export interface PrReport extends Report {
  command: 'pr';
  pr: {
    number: number;
    title: string;
    url?: string;
    state: string;
    draft: boolean | null;
    headRef: string;
    head: string;
    baseRef: string;
    /** The live tip `ls-remote` reported; null when it could not be read (the base checks are then not run). */
    baseTip: string | null;
    localBranch: { name: string; sha: string } | null;
  };
  checks: Check[];
}

export interface DeployReport extends Report {
  command: 'deploy';
  deployBranch: string | null;
  workflow: string | null;
  prs: Array<{
    number: number;
    mergedAt: string | null;
    mergeCommit: string | null;
    baseRef: string | null;
    verdict: Verdict;
    checks: Check[];
  }>;
}

export type Removable = 'removable' | 'removable-after-keeping' | 'not-removable';

export interface WorktreeReport extends Report {
  command: 'worktree';
  removable: Removable;
  worktree: {
    /** The worktree's real path. */
    path: string;
    builderId: string | null;
    branch: string;
    /** The PR's base, else origin's default branch; null when neither could be read. */
    baseRef: string | null;
    /** The live tip `ls-remote` reported; null when it could not be read (`commits` is then not run). */
    baseTip: string | null;
  };
  checks: Check[];
}

export interface ErrorReport {
  schema: 1;
  command: CommandName;
  error: { message: string; cause?: string };
}

export const PR_CHECK_IDS = [
  'head', 'state', 'forge', 'attribution', 'trial-merge', 'checks', 'watched', 'linked-issue',
  'overlap', 'size', 'to-read',
] as const;
export const DEPLOY_CHECK_IDS = ['merged', 'on-branch', 'deploy-run', 'merge-checks'] as const;
export const WORKTREE_CHECK_IDS = ['uncommitted', 'commits', 'remote', 'pr', 'ignored'] as const;
export const ALL_CHECK_IDS: ReadonlySet<string> = new Set([...PR_CHECK_IDS, ...DEPLOY_CHECK_IDS, ...WORKTREE_CHECK_IDS]);

/** The command failed and produced no report: exit 2. */
export class CheckCommandError extends Error {
  constructor(message: string, public readonly causeText?: string) {
    super(message);
    this.name = 'CheckCommandError';
  }
}

export function check(id: string, status: Status, summary: string, details: Record<string, unknown> = {}, reason?: string): Check {
  return reason === undefined ? { id, status, summary, details } : { id, status, summary, details, reason };
}

/**
 * A check that could not run. Always counts as attention. The human line reads
 * `not run  <check>  <reason>`, so the summary is the reason alone.
 */
export function notRun(id: string, reason: string, details: Record<string, unknown> = {}): Check {
  return check(id, 'not-run', reason, details, reason);
}

/** A check with no configuration. Does not count as attention. */
export function off(id: string, reason: string): Check {
  return check(id, 'off', reason, {}, reason);
}

/** A check the project declared skipped in `check.skip`. Does not count as attention. */
export function skipped(id: string): Check {
  return check(id, 'skip', 'skipped (check.skip)', {}, 'check.skip');
}

/** Replace every check named in `check.skip` with a `skip` entry. */
export function applySkips(checks: Check[], skip: ReadonlySet<string>): Check[] {
  return checks.map((c) => (skip.has(c.id) ? skipped(c.id) : c));
}

export function needsAttention(c: Check): boolean {
  return c.status === 'attention' || c.status === 'not-run';
}

export function verdictOf(checks: readonly Check[]): Verdict {
  return checks.some(needsAttention) ? 'attention' : 'clear';
}

export function exitCodeOf(verdict: Verdict): 0 | 1 {
  return verdict === 'clear' ? 0 : 1;
}

// =============================================================================
// Check runs on one commit
// =============================================================================

export interface CommitRuns {
  sha: string;
  runs: CommitCheckItem[];
  passed: number;
  failed: number;
  pending: number;
}

/** Count a commit's check results. Skipped and neutral count as passed. */
export function summarizeRuns(sha: string, runs: readonly CommitCheckItem[]): CommitRuns {
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const run of runs) {
    if (run.state === 'fail') failed++;
    else if (run.state === 'pending') pending++;
    else passed++;
  }
  return { sha, runs: [...runs], passed, failed, pending };
}

/** `8 passed`, `7 passed, 1 failed (unit)`, `5 passed, 3 still running`, or `no runs`. */
export function describeRuns(runs: CommitRuns): string {
  if (runs.runs.length === 0) return 'no runs';
  const parts: string[] = [];
  if (runs.passed > 0) parts.push(`${runs.passed} passed`);
  if (runs.failed > 0) {
    const names = runs.runs.filter((r) => r.state === 'fail').map((r) => r.name);
    parts.push(`${runs.failed} failed (${truncateList(names, 3)})`);
  }
  if (runs.pending > 0) parts.push(`${runs.pending} still running`);
  return parts.join(', ');
}

// =============================================================================
// Errors → exit 2
// =============================================================================

/** The `ErrorReport` for a failure that prevented any report. */
export function errorReport(command: CommandName, err: unknown): ErrorReport {
  if (err instanceof CheckCommandError) {
    return { schema: 1, command, error: err.causeText ? { message: err.message, cause: err.causeText } : { message: err.message } };
  }
  if (err instanceof InputError || err instanceof RunnerRefusal) {
    return { schema: 1, command, error: { message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { schema: 1, command, error: { message: `unexpected failure: ${message}` } };
}

/**
 * As many items as fit in `width` characters (always at least one), then `… +N` for the
 * rest. Keeps a check's line on one screen line however long the paths are.
 */
export function fitList(items: readonly string[], width: number): string {
  if (items.length === 0) return '';
  let shown = 1;
  let length = items[0].length;
  while (shown < items.length && length + 2 + items[shown].length <= width) {
    length += 2 + items[shown].length;
    shown++;
  }
  return shown === items.length ? items.join(', ') : `${items.slice(0, shown).join(', ')}, … +${items.length - shown}`;
}

/** `a, b, c, … +N` */
export function truncateList(items: readonly string[], max: number): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')}, … +${items.length - max}`;
}
