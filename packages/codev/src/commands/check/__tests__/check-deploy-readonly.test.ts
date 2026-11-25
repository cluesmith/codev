/**
 * Spec 1951 — `codev check deploy` against real repositories, on every platform.
 *
 * The forge comes from `pr-view`, `workflow-runs` and `commit-checks` concept overrides
 * (`.sh` scripts Git Bash runs on Windows), so neither `gh` nor a network is needed. These
 * tests prove that no ref, `HEAD`, index byte, `FETCH_HEAD` or status line changes
 * (Scenario 23), including runs that must fetch the deploy-branch tip and a run's head; that
 * the command reports the same from a builder worktree; and the exit-2 paths.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkDeploy } from '../deploy.js';
import type { Check, CommandOptions, DeployReport, ErrorReport } from '../report.js';
import type { SpawnFn } from '../runner.js';
import { green, mergedView, mergePr, setRemoteBranch, workflowRunsOverride, type MergedPr, type WorkflowRunsOverride } from './helpers/deploy-fixture.js';
import { useFakeHome } from './helpers/fake-home.js';
import { createFixture, DISCOVERY_ARGV, recordingSpawn, snapshotRepoState, type Fixture } from './helpers/git-fixture.js';
import {
  commitChecksOverride,
  passing,
  prViewOverride,
  pushFromElsewhere,
  writeConfig,
  type CommitChecksOverride,
  type PrViewOverride,
} from './helpers/pr-fixture.js';

useFakeHome();

const DEPLOYED = { deploy: { branch: 'production', workflow: 'deploy.yml' } };

let fx: Fixture;
let forge: PrViewOverride;
let runs: WorkflowRunsOverride;
let ci: CommitChecksOverride;

beforeEach(() => {
  fx = createFixture();
  forge = prViewOverride(fx);
  runs = workflowRunsOverride(fx);
  ci = commitChecksOverride(fx);
  ci.answerAll(passing(3));
});

afterEach(() => {
  fx.cleanup();
});

function configure(check: Record<string, unknown> = {}): string {
  return writeConfig(fx, { forge: { 'pr-view': forge.script, 'workflow-runs': runs.script, 'commit-checks': ci.script }, check });
}

async function runReport(numbers: string[] = ['8'], extra: Partial<CommandOptions> = {}): Promise<DeployReport> {
  const result = await checkDeploy(numbers, { cwd: fx.main, env: fx.env, timeoutMs: 20_000, ...extra });
  if ('error' in result.report) throw new Error(`unexpected exit 2: ${result.report.error.message}`);
  return result.report;
}

function byId(report: DeployReport, id: string, number = 8): Check {
  const found = report.prs.find((p) => p.number === number)?.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check for #${number}`);
  return found;
}

function withoutTime(report: DeployReport): Omit<DeployReport, 'generatedAt'> {
  const { generatedAt: _ignored, ...rest } = report;
  return rest;
}

interface SnapshotCase {
  name: string;
  check: Record<string, unknown>;
  /** Merge the PR and arrange the remote; returns the commits the run must fetch. */
  setup: (pr: MergedPr) => string[];
  expected: Record<string, string>;
}

const SNAPSHOT_CASES: SnapshotCase[] = [
  {
    name: 'a deploy branch and green run already local',
    check: DEPLOYED,
    setup: (pr) => {
      setRemoteBranch(fx, 'production', pr.merge);
      runs.answer([green(pr.merge)]);
      return [];
    },
    expected: { 'on-branch': 'ok', 'deploy-run': 'ok' },
  },
  {
    name: 'a deploy-branch tip that must be fetched',
    check: DEPLOYED,
    setup: (pr) => {
      setRemoteBranch(fx, 'production', pr.merge);
      const tip = pushFromElsewhere(fx, 'production', { 'deployed.txt': 'x\n' });
      runs.answer([green(pr.merge)]);
      return [tip];
    },
    expected: { 'on-branch': 'ok', 'deploy-run': 'ok' },
  },
  {
    name: 'a green run whose head must be fetched',
    check: DEPLOYED,
    setup: (pr) => {
      setRemoteBranch(fx, 'production', pr.before);
      const runHead = pushFromElsewhere(fx, 'deploy-candidate', { 'candidate.txt': 'x\n' });
      runs.answer([green(runHead)]);
      return [runHead];
    },
    expected: { 'on-branch': 'attention', 'deploy-run': 'ok' },
  },
  {
    name: 'nothing configured, with main moved on since the merge',
    check: {},
    setup: () => [pushFromElsewhere(fx, 'main', { 'later.txt': 'later\n' })],
    expected: { 'on-branch': 'ok', 'deploy-run': 'off', 'merge-checks': 'ok' },
  },
];

// Each case builds real repositories and runs the command at least once.
describe('Spec 1951 — check deploy on real repositories', { timeout: 30_000 }, () => {
  it.each(SNAPSHOT_CASES)('Scenario 23: $name leaves refs, HEAD, index, FETCH_HEAD and status unchanged', async (c) => {
    const pr = mergePr(fx, 8);
    const fetched = c.setup(pr);
    forge.answerFor(8, mergedView(pr));
    configure(c.check);
    for (const sha of fetched) expect(() => fx.git(fx.main, 'cat-file', '-e', sha)).toThrow();
    const before = snapshotRepoState(fx, fx.main);

    const report = await runReport();

    expect(snapshotRepoState(fx, fx.main)).toEqual(before);
    for (const [id, status] of Object.entries(c.expected)) expect(byId(report, id).status, id).toBe(status);
    for (const sha of fetched) expect(fx.git(fx.main, 'cat-file', '-t', sha).trim()).toBe('commit');
  });

  it('a linked worktree is left unchanged, and the report is the same from it as from the main checkout', async () => {
    const pr = mergePr(fx, 8);
    const worktree = path.join(fx.main, '.builders', 'builder-spir-8');
    setRemoteBranch(fx, 'production', pr.merge);
    pushFromElsewhere(fx, 'production', { 'deployed.txt': 'x\n' });
    forge.answerFor(8, mergedView(pr));
    runs.answer([green(pr.merge)]);
    configure(DEPLOYED);
    const before = snapshotRepoState(fx, worktree);

    const fromWorktree = await runReport(['8'], { cwd: worktree });
    const fromMain = await runReport();

    expect(snapshotRepoState(fx, worktree)).toEqual(before);
    expect(withoutTime(fromWorktree)).toEqual(withoutTime(fromMain));
    expect(fromMain.verdict).toBe('clear');
  });

  it('Scenario 15a: check deploy 8 99999 reports #8 in full, #99999 not run, and exits 1', async () => {
    const pr = mergePr(fx, 8);
    forge.answerFor(8, mergedView(pr));
    forge.failFor(99999, 'GraphQL: Could not resolve to a PullRequest with the number of 99999.');
    configure();

    const result = await checkDeploy(['8', '99999'], { cwd: fx.main, env: fx.env, timeoutMs: 20_000 });

    expect(result.exitCode).toBe(1);
    const report = result.report as DeployReport;
    expect(report.prs.map((p) => [p.number, p.verdict])).toEqual([[8, 'clear'], [99999, 'attention']]);
    expect(byId(report, 'merged', 99999)).toMatchObject({
      status: 'not-run',
      reason: 'pr-view failed: GraphQL: Could not resolve to a PullRequest with the number of 99999.',
    });
  });

  it('Scenario 28a: an invalid PR number among several is exit 2 before any subprocess starts', async () => {
    const spawn = vi.fn<SpawnFn>();
    for (const numbers of [['8', '12a'], ['0'], []]) {
      const result = await checkDeploy(numbers, { cwd: fx.main, spawn });
      expect(result.exitCode, numbers.join(' ')).toBe(2);
      expect((result.report as ErrorReport).command).toBe('deploy');
    }
    const result = await checkDeploy(['8', '12a'], { cwd: fx.main, spawn });
    expect((result.report as ErrorReport).error.message).toBe('invalid PR number "12a": expected a positive integer');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('Scenario 28a: check.deploy.workflow "--repo=x" is exit 2 naming the value and the file; only the two discovery calls ran', async () => {
    const file = configure({ deploy: { workflow: '--repo=x' } });
    const recorder = recordingSpawn();

    const result = await checkDeploy(['8'], { cwd: fx.main, env: fx.env, spawn: recorder.spawn });

    expect(result).toEqual({
      exitCode: 2,
      report: { schema: 1, command: 'deploy', error: { message: `check.deploy.workflow "--repo=x" may not begin with '-' (in ${file})` } },
    });
    expect(recorder.calls).toEqual(DISCOVERY_ARGV);
    expect(forge.calls()).toBe(0);
  });

  it('outside a git repository is exit 2', async () => {
    const plain = path.join(fx.root, 'plain');
    fs.mkdirSync(plain);
    const result = await checkDeploy(['8'], { cwd: plain, env: { ...fx.env, GIT_CEILING_DIRECTORIES: fx.root } });
    expect(result.exitCode).toBe(2);
    expect((result.report as ErrorReport).error.message).toBe('not in a git repository');
  });
});
