/**
 * `codev check deploy <N>…` (Spec 1951): whether each merged PR reached the deploy branch
 * and, where a deploy workflow is configured, the latest green deploy run.
 *
 * Per PR, from `pr-view`:
 *
 *   merged        the PR is merged and the forge names its merge commit
 *   on-branch     the merge commit is an ancestor of the live tip of `check.deploy.branch`,
 *                 or of the PR's base when that is unset (`ls-remote`, never `origin/<branch>`)
 *   deploy-run    with `check.deploy.workflow`: the merge commit is an ancestor of the head of
 *                 the newest green run of that workflow on the branch (`workflow-runs`);
 *                 without it, `off`
 *   merge-checks  only without a deploy workflow: CI on the merge commit (`commit-checks`)
 *
 * A PR that cannot be read is a per-PR `not run`, and the other PRs are still reported.
 * Missing commits are fetched ref-neutrally, as in `check pr`. The verdict is the worst
 * across all PRs.
 */

import type { WorkflowRunItem } from '../../lib/forge-contracts.js';
import { ancestry, ensureCommits, gitVersion, liveTip, type GitVersion, type Lookup } from './git-facts.js';
import { lookupRuns } from './porch-only.js';
import { normalizeState } from './pr.js';
import { defaultLabel, renderHuman, short, type RenderOptions } from './render.js';
import {
  check,
  describeRuns,
  errorReport,
  exitCodeOf,
  needsAttention,
  notRun,
  off,
  skipped,
  verdictOf,
  type Check,
  type CommandOptions,
  type CommandResult,
  type CommitRuns,
  type DeployReport,
} from './report.js';
import { requireOrigin, resolveRoots } from './roots.js';
import { createRunner, type Runner } from './runner.js';
import { loadCheckSettings, type CheckSettings } from './settings.js';
import { InputError, isFullSha, isRefName, validatePrNumber } from './validate.js';

type DeployPr = DeployReport['prs'][number];

/** The `pr-view` fields this command reads. Each is null when the forge did not return it usably. */
interface DeployView {
  state: string | null;
  mergedAt: string | null;
  /** The validated base branch, or why there is none. */
  base: Lookup<string>;
  /** The validated merge commit, or why there is none to look for. */
  merge: Lookup<string>;
}

/** Validate a `pr-view` result for `check deploy`. Only a non-object is a failure; a missing field fails the check that needs it. */
export function parseDeployView(data: unknown): Lookup<DeployView> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'pr-view returned something other than a JSON object' };
  }
  const raw = data as Record<string, unknown>;
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  const state = text(raw.state);
  const mergedAt = text(raw.mergedAt);
  const base: Lookup<string> =
    raw.baseRefName === undefined || raw.baseRefName === null || raw.baseRefName === ''
      ? { ok: false, reason: 'pr-view did not return baseRefName' }
      : typeof raw.baseRefName === 'string' && isRefName(raw.baseRefName)
        ? { ok: true, value: raw.baseRefName }
        : { ok: false, reason: `pr-view returned baseRefName ${JSON.stringify(raw.baseRefName)}, not a valid branch name` };

  let merge: Lookup<string>;
  if (state === null) merge = { ok: false, reason: 'pr-view did not return state' };
  else if (normalizeState(state, mergedAt) !== 'MERGED') merge = { ok: false, reason: `the PR is not merged (${normalizeState(state, mergedAt)})` };
  else if (raw.mergeCommit === undefined) merge = { ok: false, reason: 'pr-view did not return mergeCommit' };
  else if (raw.mergeCommit === null) merge = { ok: false, reason: 'pr-view returned no merge commit for a merged PR' };
  else {
    const oid = typeof raw.mergeCommit === 'object' ? (raw.mergeCommit as Record<string, unknown>).oid : undefined;
    merge =
      typeof oid === 'string' && isFullSha(oid)
        ? { ok: true, value: oid }
        : { ok: false, reason: `pr-view returned mergeCommit ${JSON.stringify(raw.mergeCommit)}, not { oid: <full commit SHA> }` };
  }
  return { ok: true, value: { state, mergedAt, base, merge } };
}

/** The runs `workflow-runs` returned, newest first. A failure reason names the concept and the item. */
export function parseWorkflowRuns(data: unknown): Lookup<WorkflowRunItem[]> {
  if (!Array.isArray(data)) return { ok: false, reason: 'workflow-runs returned something other than a JSON array' };
  const runs: WorkflowRunItem[] = [];
  for (const [index, raw] of data.entries()) {
    const where = `workflow-runs item ${index + 1}`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: `${where} is not an object` };
    const { headSha, status, conclusion, url, createdAt } = raw as Record<string, unknown>;
    if (typeof status !== 'string') return { ok: false, reason: `${where} has no status` };
    if (conclusion !== null && conclusion !== undefined && typeof conclusion !== 'string') {
      return { ok: false, reason: `${where} has a conclusion that is not a string` };
    }
    runs.push({
      headSha: typeof headSha === 'string' ? headSha : '',
      status,
      conclusion: typeof conclusion === 'string' ? conclusion : null,
      url: typeof url === 'string' ? url : '',
      createdAt: typeof createdAt === 'string' ? createdAt : '',
    });
  }
  return { ok: true, value: runs };
}

/** `2026-11-22 18:04` (UTC) for an ISO 8601 time, or null when it does not parse. */
function minutes(iso: string): string | null {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 16).replace('T', ' ');
}

// =============================================================================
// The checks
// =============================================================================

/** What every PR's checks share: the runner, the settings, and the reads made once per branch. */
interface Context {
  runner: Runner;
  settings: CheckSettings;
  version: GitVersion;
  /** By branch. */
  tips: Map<string, Promise<Lookup<string | null>>>;
  /** By workflow and branch. */
  runs: Map<string, Promise<Lookup<WorkflowRunItem[]>>>;
}

function tipOf(ctx: Context, branch: string): Promise<Lookup<string | null>> {
  let tip = ctx.tips.get(branch);
  if (!tip) ctx.tips.set(branch, (tip = liveTip(ctx.runner, branch)));
  return tip;
}

function runsOf(ctx: Context, workflow: string, branch: string): Promise<Lookup<WorkflowRunItem[]>> {
  const key = JSON.stringify([workflow, branch]);
  let runs = ctx.runs.get(key);
  if (!runs) {
    runs = ctx.runner
      .forge('workflow-runs', { CODEV_WORKFLOW: workflow, CODEV_BRANCH: branch })
      .then((outcome) => (outcome.ok ? parseWorkflowRuns(outcome.data) : { ok: false, reason: outcome.reason }));
    ctx.runs.set(key, runs);
  }
  return runs;
}

function checkMerged(view: DeployView): Check {
  const details = {
    state: view.state === null ? null : normalizeState(view.state, view.mergedAt),
    mergedAt: view.mergedAt,
    mergeCommit: view.merge.ok ? view.merge.value : null,
  };
  if (view.merge.ok) {
    const when = view.mergedAt ? ` ${view.mergedAt.slice(0, 10)}` : '';
    return check('merged', 'ok', `merged${when} as ${short(view.merge.value)}`, details);
  }
  if (details.state !== null && details.state !== 'MERGED') return check('merged', 'attention', `${details.state}: not merged`, details);
  return notRun('merged', view.merge.reason, details);
}

/** The merge commit and the branch it should reach. */
interface Target {
  merge: string;
  branch: string;
}

/** `check.deploy.branch`, else the PR's base. */
function branchFor(ctx: Context, view: DeployView): Lookup<string> {
  const { branch } = ctx.settings.deploy;
  return branch === null ? view.base : { ok: true, value: branch };
}

async function checkOnBranch(ctx: Context, { merge, branch }: Target): Promise<Check> {
  const tip = await tipOf(ctx, branch);
  if (!tip.ok) return notRun('on-branch', tip.reason, { branch });
  if (tip.value === null) return notRun('on-branch', `origin has no branch ${branch}`, { branch });
  const problems = await ensureCommits(ctx.runner, [merge, tip.value], ctx.version);
  const problem = problems.get(merge) ?? problems.get(tip.value);
  if (problem) return notRun('on-branch', problem, { branch, tip: tip.value });
  const answer = await ancestry(ctx.runner, merge, tip.value);
  if (!answer.ok) return notRun('on-branch', answer.reason, { branch, tip: tip.value });
  const contains = answer.value;
  const words = `origin/${branch} @ ${short(tip.value)} ${contains ? 'contains' : 'does not contain'} ${short(merge)}`;
  return check('on-branch', contains ? 'ok' : 'attention', words, { branch, tip: tip.value, contains });
}

async function checkDeployRun(ctx: Context, { merge, branch }: Target, workflow: string): Promise<Check> {
  const runs = await runsOf(ctx, workflow, branch);
  if (!runs.ok) return notRun('deploy-run', runs.reason, { workflow });
  const green = runs.value.find((r) => r.status === 'completed' && r.conclusion === 'success');
  if (!green) {
    const among = runs.value.length === 0 ? `no ${workflow} run on ${branch}` : `no green ${workflow} run on ${branch} among the ${runs.value.length} returned`;
    return check('deploy-run', 'attention', among, { workflow });
  }
  if (!isFullSha(green.headSha)) {
    return notRun('deploy-run', `workflow-runs returned invalid headSha ${JSON.stringify(green.headSha)}`, { workflow });
  }
  const run = { headSha: green.headSha, url: green.url, createdAt: green.createdAt };
  const problems = await ensureCommits(ctx.runner, [merge, green.headSha], ctx.version);
  const problem = problems.get(green.headSha) ?? problems.get(merge);
  if (problem) return notRun('deploy-run', problem, { workflow, run });
  const answer = await ancestry(ctx.runner, merge, green.headSha);
  if (!answer.ok) return notRun('deploy-run', answer.reason, { workflow, run });
  const contains = answer.value;
  const when = minutes(green.createdAt);
  const which = `latest green ${workflow} run (${when ? `${when}, ` : ''}${short(green.headSha)})`;
  return check('deploy-run', contains ? 'ok' : 'attention', `${which} ${contains ? 'contains' : 'does not contain'} ${short(merge)}`, {
    workflow,
    run,
    contains,
  });
}

/** What keeps a commit's runs from `ok`, or null when they all passed. */
export function runsProblem(runs: CommitRuns): 'failed' | 'running' | 'no runs' | null {
  if (runs.failed > 0) return 'failed';
  if (runs.pending > 0) return 'running';
  return runs.runs.length === 0 ? 'no runs' : null;
}

async function checkMergeChecks(ctx: Context, merge: string): Promise<Check> {
  const runs = await lookupRuns(ctx.runner, merge);
  if (!runs.ok) return notRun('merge-checks', runs.reason);
  const status = runsProblem(runs.value) === null ? 'ok' : 'attention';
  return check('merge-checks', status, `${short(merge)}: ${describeRuns(runs.value)}`, { ...runs.value });
}

/**
 * A check, or its `skip` entry when `check.skip` names it. Tested before the check runs, so a
 * skipped check asks neither git nor the forge anything.
 */
async function unlessSkipped(ctx: Context, id: string, run: () => Check | Promise<Check>): Promise<Check> {
  return ctx.settings.skip.has(id) ? skipped(id) : run();
}

const NO_WORKFLOW = 'no deploy workflow configured (check.deploy.workflow)';

async function deployChecks(ctx: Context, view: DeployView): Promise<Check[]> {
  const { workflow } = ctx.settings.deploy;
  const branch = branchFor(ctx, view);
  // The merge commit and its branch, or why the checks that need them cannot run.
  const target: Lookup<Target> = !view.merge.ok
    ? view.merge
    : !branch.ok
      ? branch
      : { ok: true, value: { merge: view.merge.value, branch: branch.value } };
  const where = branch.ok ? { branch: branch.value } : {};

  const checks = [
    await unlessSkipped(ctx, 'merged', () => checkMerged(view)),
    await unlessSkipped(ctx, 'on-branch', () => (target.ok ? checkOnBranch(ctx, target.value) : notRun('on-branch', target.reason, where))),
    await unlessSkipped(ctx, 'deploy-run', () => {
      if (workflow === null) return off('deploy-run', NO_WORKFLOW);
      return target.ok ? checkDeployRun(ctx, target.value, workflow) : notRun('deploy-run', target.reason, { workflow });
    }),
  ];
  if (workflow === null) {
    const merge = view.merge;
    checks.push(await unlessSkipped(ctx, 'merge-checks', () => (merge.ok ? checkMergeChecks(ctx, merge.value) : notRun('merge-checks', merge.reason))));
  }
  return checks;
}

/** A PR that could not be read: `merged` says why, and every check that needs the PR is not run. */
function unreadChecks(ctx: Context, reason: string): Check[] {
  const { workflow, branch } = ctx.settings.deploy;
  const unread = 'the PR could not be read';
  const checks = [
    notRun('merged', reason),
    notRun('on-branch', unread, branch === null ? {} : { branch }),
    workflow === null ? off('deploy-run', NO_WORKFLOW) : notRun('deploy-run', unread, { workflow }),
  ];
  if (workflow === null) checks.push(notRun('merge-checks', unread));
  return checks.map((c) => (ctx.settings.skip.has(c.id) ? skipped(c.id) : c));
}

async function deployPr(ctx: Context, number: number): Promise<DeployPr> {
  const outcome = await ctx.runner.forge('pr-view', { CODEV_PR_NUMBER: String(number) });
  const read: Lookup<DeployView> = outcome.ok ? parseDeployView(outcome.data) : { ok: false, reason: outcome.reason };
  if (!read.ok) {
    const checks = unreadChecks(ctx, read.reason);
    return { number, mergedAt: null, mergeCommit: null, baseRef: null, verdict: verdictOf(checks), checks };
  }
  const view = read.value;
  const checks = await deployChecks(ctx, view);
  return {
    number,
    mergedAt: view.mergedAt,
    mergeCommit: view.merge.ok ? view.merge.value : null,
    baseRef: view.base.ok ? view.base.value : null,
    verdict: verdictOf(checks),
    checks,
  };
}

// =============================================================================
// The command
// =============================================================================

async function buildDeployReport(numbers: readonly number[], options: CommandOptions): Promise<DeployReport> {
  const runnerOptions = { timeoutMs: options.timeoutMs, env: options.env, spawn: options.spawn };
  const roots = await resolveRoots(createRunner({ cwd: options.cwd, workspaceRoot: options.cwd, ...runnerOptions }));
  const runner = createRunner({ cwd: roots.mainRoot, workspaceRoot: roots.mainRoot, ...runnerOptions });
  const settings = loadCheckSettings(roots.mainRoot);
  await requireOrigin(runner);
  const ctx: Context = { runner, settings, version: await gitVersion(runner), tips: new Map(), runs: new Map() };

  const prs: DeployPr[] = [];
  for (const number of numbers) prs.push(await deployPr(ctx, number));
  return {
    schema: 1,
    command: 'deploy',
    verdict: prs.some((p) => p.verdict === 'attention') ? 'attention' : 'clear',
    generatedAt: new Date().toISOString(),
    deployBranch: settings.deploy.branch,
    workflow: settings.deploy.workflow,
    prs,
  };
}

/** `codev check deploy <N>…`. Never throws: a failure that prevents a report is exit 2 with an `ErrorReport`. */
export async function checkDeploy(rawNumbers: readonly string[], options: CommandOptions): Promise<CommandResult<DeployReport>> {
  try {
    if (rawNumbers.length === 0) throw new InputError('no PR number given');
    const numbers = [...new Set(rawNumbers.map(validatePrNumber))];
    const report = await buildDeployReport(numbers, options);
    return { report, exitCode: exitCodeOf(report.verdict) };
  } catch (err) {
    return { report: errorReport('deploy', err), exitCode: 2 };
  }
}

// =============================================================================
// Human form
// =============================================================================

/** The branch a PR's `on-branch` check looked at, when it got that far. */
function branchOf(pr: DeployPr): string | null {
  const onBranch = pr.checks.find((c) => c.id === 'on-branch');
  return typeof onBranch?.details.branch === 'string' ? onBranch.details.branch : null;
}

const DEPLOY_RENDER: RenderOptions = {
  label: (c) => (c.id === 'on-branch' && typeof c.details.branch === 'string' ? `on ${c.details.branch}` : defaultLabel(c.id)),
};

/** What a PR needing attention lacks, in a few words: `not deployed`, `not merged`, `merge checks failed`. */
function problemWords(pr: DeployPr): string[] {
  const merged = pr.checks.find((c) => c.id === 'merged');
  if (merged?.status === 'attention') return ['not merged'];
  // An unread PR's `merged` carries no state at all; a read one may lack only its state.
  if (merged?.status === 'not-run') {
    if (!('state' in merged.details)) return ['not read'];
    return [merged.details.state === null ? 'state not read' : 'merge not read'];
  }
  const words: string[] = [];
  for (const c of pr.checks.filter(needsAttention)) {
    const label = DEPLOY_RENDER.label!(c);
    if (c.status === 'not-run') words.push(`${label} not run`);
    else if (c.id === 'on-branch') words.push(`not ${label}`);
    else if (c.id === 'deploy-run') words.push('not deployed');
    else if (c.id === 'merge-checks') words.push(`merge checks ${runsProblem(c.details as unknown as CommitRuns) ?? 'failed'}`);
  }
  // `not deployed` says what `not on <branch>` would.
  return words.includes('not deployed') ? words.filter((w) => !w.startsWith('not on ')) : words;
}

/** `#1948 on main; checks on the merge commit passed`: what every PR passed, by check. */
function clearWords(report: DeployReport): string {
  const all = (id: string) => report.prs.every((p) => p.checks.some((c) => c.id === id && c.status === 'ok'));
  const parts: string[] = [];
  if (all('on-branch')) parts.push(`on ${[...new Set(report.prs.map(branchOf))].join(', ')}`);
  if (all('deploy-run')) parts.push(`in the latest green ${report.workflow} run`);
  if (all('merge-checks')) parts.push(`checks on the merge commit${report.prs.length === 1 ? '' : 's'} passed`);
  const numbers = report.prs.map((p) => `#${p.number}`).join(', ');
  return parts.length === 0 ? `${numbers} merged` : `${numbers} ${parts.join('; ')}`;
}

function sectionTitle(pr: DeployPr): string {
  const merged = pr.checks.find((c) => c.id === 'merged');
  const base = pr.baseRef ? ` → ${pr.baseRef}` : '';
  if (pr.mergeCommit) return `#${pr.number}  merged${pr.mergedAt ? ` ${pr.mergedAt.slice(0, 10)}` : ''}${base}   merge ${short(pr.mergeCommit)}`;
  const state = typeof merged?.details.state === 'string' ? `  ${merged.details.state}` : '';
  return `#${pr.number}${state}${state ? base : ''}`;
}

/** The order of the human lines: what was found first, a check with no configuration last. */
const HUMAN_ORDER: readonly string[] = ['merged', 'on-branch', 'merge-checks', 'deploy-run'];

export function renderDeployHuman(report: DeployReport): string {
  const verdictLine =
    report.verdict === 'clear'
      ? `CLEAR  ${clearWords(report)}`
      : `ATTENTION  ${report.prs
          .filter((p) => p.verdict === 'attention')
          .map((p) => `#${p.number} ${problemWords(p).join(', ')}`)
          .join('; ')}`;
  const sections = report.prs.map((pr) => ({
    title: sectionTitle(pr),
    // An ok merge reads in the title; one needing attention gets its own line.
    checks: pr.checks
      .filter((c) => !(c.id === 'merged' && c.status === 'ok'))
      .sort((a, b) => HUMAN_ORDER.indexOf(a.id) - HUMAN_ORDER.indexOf(b.id)),
  }));
  return renderHuman({ verdictLine, header: [], sections }, DEPLOY_RENDER);
}
