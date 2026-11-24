/**
 * Spec 1951 — `codev check deploy` (Scenarios 13, 14, 15; POSIX).
 *
 * PRs are merged into the fixture's origin for real. `pr-view`, `workflow-runs` and
 * `commit-checks` come from overrides; a stub `git` first on PATH records every git call, so
 * each case also proves nothing off the read-only list ran, and the repository state is
 * compared before and after. The parsers are tested on every platform.
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDeploy, parseDeployView, parseWorkflowRuns, renderDeployHuman, runsProblem } from '../deploy.js';
import { summarizeRuns, type Check, type CommandOptions, type DeployReport } from '../report.js';
import { useFakeHome } from './helpers/fake-home.js';
import { createFixture, snapshotRepoState, type Fixture } from './helpers/git-fixture.js';
import { green, mergedView, mergePr, run, setRemoteBranch, workflowRunsOverride, type WorkflowRunsOverride } from './helpers/deploy-fixture.js';
import {
  commitChecksOverride,
  passing,
  prView,
  prViewOverride,
  pushBranch,
  pushFromElsewhere,
  writeConfig,
  type CommitChecksOverride,
  type PrViewOverride,
} from './helpers/pr-fixture.js';
import { expectDeployReportShape } from './helpers/report-shape.js';
import { createStubBin, type StubBin } from './helpers/stub-bin.js';

const isWindows = process.platform === 'win32';
const SHA = 'a'.repeat(40);
const DEPLOYED = { branch: 'production', workflow: 'deploy.yml' };

describe('Spec 1951 — check deploy: parsers', () => {
  it('parseDeployView: a merged PR carries its merge commit and base', () => {
    const parsed = parseDeployView({ state: 'MERGED', mergedAt: '2026-11-22T17:30:00Z', mergeCommit: { oid: SHA }, baseRefName: 'main' });
    expect(parsed).toEqual({
      ok: true,
      value: { state: 'MERGED', mergedAt: '2026-11-22T17:30:00Z', base: { ok: true, value: 'main' }, merge: { ok: true, value: SHA } },
    });
  });

  it.each([
    ['an open PR', { state: 'OPEN', mergeCommit: null }, 'the PR is not merged (OPEN)'],
    ['a closed PR', { state: 'closed', mergeCommit: null }, 'the PR is not merged (CLOSED)'],
    ['no state', { mergeCommit: { oid: SHA } }, 'pr-view did not return state'],
    ['a preset without mergeCommit', { state: 'MERGED' }, 'pr-view did not return mergeCommit'],
    ['a merged PR with a null merge commit', { state: 'MERGED', mergeCommit: null }, 'pr-view returned no merge commit for a merged PR'],
    ['an abbreviated merge commit', { state: 'MERGED', mergeCommit: { oid: 'abc1234' } }, 'pr-view returned mergeCommit {"oid":"abc1234"}, not { oid: <full commit SHA> }'],
    ['a bare-string merge commit', { state: 'MERGED', mergeCommit: SHA }, `pr-view returned mergeCommit "${SHA}", not { oid: <full commit SHA> }`],
  ])('parseDeployView: %s has no merge commit to look for', (_name, raw, reason) => {
    const parsed = parseDeployView({ baseRefName: 'main', ...raw });
    expect(parsed.ok && parsed.value.merge).toEqual({ ok: false, reason });
  });

  it('parseDeployView: a merge time makes the state MERGED, as gitlab reports it', () => {
    const parsed = parseDeployView({ state: 'merged', mergedAt: '2026-11-22T17:30:00Z', mergeCommit: { oid: SHA }, baseRefName: 'main' });
    expect(parsed.ok && parsed.value.merge).toEqual({ ok: true, value: SHA });
  });

  it('parseDeployView: a missing or invalid base, and a non-object', () => {
    const missing = parseDeployView({ state: 'MERGED', mergeCommit: { oid: SHA } });
    expect(missing.ok && missing.value.base).toEqual({ ok: false, reason: 'pr-view did not return baseRefName' });
    const invalid = parseDeployView({ state: 'MERGED', mergeCommit: { oid: SHA }, baseRefName: '--main' });
    expect(invalid.ok && invalid.value.base).toEqual({ ok: false, reason: 'pr-view returned baseRefName "--main", not a valid branch name' });
    expect(parseDeployView([])).toEqual({ ok: false, reason: 'pr-view returned something other than a JSON object' });
  });

  it('parseWorkflowRuns: the contract, and what is off it', () => {
    expect(parseWorkflowRuns([run(SHA, 'success'), run(SHA, null, undefined, 'in_progress')])).toEqual({
      ok: true,
      value: [run(SHA, 'success'), run(SHA, null, undefined, 'in_progress')],
    });
    expect(parseWorkflowRuns({})).toEqual({ ok: false, reason: 'workflow-runs returned something other than a JSON array' });
    expect(parseWorkflowRuns([1])).toEqual({ ok: false, reason: 'workflow-runs item 1 is not an object' });
    expect(parseWorkflowRuns([{ headSha: SHA }])).toEqual({ ok: false, reason: 'workflow-runs item 1 has no status' });
    expect(parseWorkflowRuns([{ headSha: SHA, status: 'completed', conclusion: 1 }])).toEqual({
      ok: false,
      reason: 'workflow-runs item 1 has a conclusion that is not a string',
    });
  });

  it('runsProblem: failed first, then running, then no runs', () => {
    expect(runsProblem(summarizeRuns(SHA, [{ name: 'a', state: 'pass' }, { name: 'b', state: 'skipped' }]))).toBeNull();
    expect(runsProblem(summarizeRuns(SHA, [{ name: 'a', state: 'pending' }, { name: 'b', state: 'fail' }]))).toBe('failed');
    expect(runsProblem(summarizeRuns(SHA, [{ name: 'a', state: 'pending' }]))).toBe('running');
    expect(runsProblem(summarizeRuns(SHA, []))).toBe('no runs');
  });
});

useFakeHome();

let fx: Fixture;
let stub: StubBin;
let forge: PrViewOverride;
let runs: WorkflowRunsOverride;
let ci: CommitChecksOverride;
let uninstall: () => void;

function configure(extra: { forge?: Record<string, unknown>; check?: Record<string, unknown> } = {}): void {
  writeConfig(fx, {
    forge: { 'pr-view': forge.script, 'workflow-runs': runs.script, 'commit-checks': ci.script, ...extra.forge },
    ...(extra.check ? { check: extra.check } : {}),
  });
}

async function runReadOnly(numbers: string[], extra: Partial<CommandOptions> = {}): Promise<{ report: DeployReport; exitCode: number }> {
  const before = snapshotRepoState(fx, fx.main);
  const result = await checkDeploy(numbers, { cwd: fx.main, env: { ...fx.env, ...stub.env }, timeoutMs: 20_000, ...extra });
  if ('error' in result.report) throw new Error(`unexpected exit 2: ${result.report.error.message}`);
  expect(snapshotRepoState(fx, fx.main)).toEqual(before);
  expect(stub.violations()).toEqual([]);
  expectDeployReportShape(result.report);
  return { report: result.report, exitCode: result.exitCode };
}

function byId(report: DeployReport, number: number, id: string): Check {
  const found = report.prs.find((p) => p.number === number)?.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check for #${number}`);
  return found;
}

const s = (sha: string): string => sha.slice(0, 7);

describe.skipIf(isWindows)('Spec 1951 — check deploy (stub git)', { timeout: 30_000 }, () => {
  beforeEach(() => {
    fx = createFixture();
    stub = createStubBin(path.join(fx.root, 'bin'));
    uninstall = stub.install();
    forge = prViewOverride(fx);
    runs = workflowRunsOverride(fx);
    ci = commitChecksOverride(fx);
  });

  afterEach(() => {
    uninstall();
    fx.cleanup();
  });

  describe('Scenario 13: a deploy branch and workflow', () => {
    beforeEach(() => configure({ check: { deploy: DEPLOYED } }));

    it('merged, on the deploy branch and inside the latest green run: CLEAR, laid out as the spec sample', async () => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      forge.answerFor(8, mergedView(pr));
      runs.answer([run(SHA, null, '2026-11-23T09:00:00Z', 'in_progress'), run(SHA, 'failure', '2026-11-23T08:00:00Z'), green(pr.merge)]);

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(0);
      expect(report).toMatchObject({ verdict: 'clear', deployBranch: 'production', workflow: 'deploy.yml' });
      expect(report.prs[0]).toMatchObject({ number: 8, mergedAt: '2026-11-22T17:30:00Z', mergeCommit: pr.merge, baseRef: 'main', verdict: 'clear' });
      expect(byId(report, 8, 'merged')).toMatchObject({ status: 'ok', details: { state: 'MERGED', mergedAt: '2026-11-22T17:30:00Z', mergeCommit: pr.merge } });
      expect(byId(report, 8, 'on-branch')).toMatchObject({ status: 'ok', details: { branch: 'production', tip: pr.merge, contains: true } });
      expect(byId(report, 8, 'deploy-run')).toMatchObject({
        status: 'ok',
        details: { workflow: 'deploy.yml', contains: true, run: { headSha: pr.merge, url: `https://example.invalid/runs/${s(pr.merge)}`, createdAt: '2026-11-22T18:04:00Z' } },
      });
      expect(runs.calls()).toEqual(['deploy.yml production']);
      expect(ci.calls()).toEqual([]);

      expect(renderDeployHuman(report)).toBe(
        [
          'CLEAR  #8 on production; in the latest green deploy.yml run',
          '',
          `#8  merged 2026-11-22 → main   merge ${s(pr.merge)}`,
          `  ok      on production   origin/production @ ${s(pr.merge)} contains ${s(pr.merge)}`,
          `  ok      deploy run      latest green deploy.yml run (2026-11-22 18:04, ${s(pr.merge)}) contains ${s(pr.merge)}`,
          '',
        ].join('\n'),
      );
    });

    it('not on the deploy branch, and not in its latest green run: attention, "not deployed"', async () => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.before);
      forge.answerFor(8, mergedView(pr));
      runs.answer([green(pr.before)]);

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(1);
      expect(byId(report, 8, 'on-branch')).toMatchObject({
        status: 'attention',
        summary: `origin/production @ ${s(pr.before)} does not contain ${s(pr.merge)}`,
        details: { contains: false },
      });
      expect(byId(report, 8, 'deploy-run')).toMatchObject({
        status: 'attention',
        summary: `latest green deploy.yml run (2026-11-22 18:04, ${s(pr.before)}) does not contain ${s(pr.merge)}`,
        details: { contains: false },
      });
      expect(renderDeployHuman(report).split('\n')[0]).toBe('ATTENTION  #8 not deployed');
    });

    it('on the deploy branch but newer than the latest green run: deploy-run attention only', async () => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      forge.answerFor(8, mergedView(pr));
      runs.answer([run(pr.merge, null, '2026-11-23T09:00:00Z', 'in_progress'), green(pr.before)]);

      const { report } = await runReadOnly(['8']);

      expect(byId(report, 8, 'on-branch').status).toBe('ok');
      expect(byId(report, 8, 'deploy-run')).toMatchObject({ status: 'attention', details: { run: { headSha: pr.before }, contains: false } });
      expect(renderDeployHuman(report).split('\n')[0]).toBe('ATTENTION  #8 not deployed');
    });

    it('on the deploy branch with no green run: "not deployed", naming how many runs came back', async () => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      forge.answerFor(8, mergedView(pr));
      runs.answer([run(pr.merge, 'failure'), run(pr.before, 'cancelled')]);

      const { report } = await runReadOnly(['8']);
      expect(byId(report, 8, 'deploy-run')).toMatchObject({ status: 'attention', summary: 'no green deploy.yml run on production among the 2 returned' });

      runs.answer([]);
      const { report: none } = await runReadOnly(['8']);
      expect(byId(none, 8, 'deploy-run')).toMatchObject({ status: 'attention', summary: 'no deploy.yml run on production' });
    });

    it('a deploy branch and a green run whose commits are not local are fetched ref-neutrally and judged', async () => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      const later = pushFromElsewhere(fx, 'production', { 'deployed.txt': 'x\n' });
      forge.answerFor(8, mergedView(pr));
      runs.answer([green(later)]);
      expect(() => fx.git(fx.main, 'cat-file', '-e', later)).toThrow();

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(0);
      expect(byId(report, 8, 'on-branch')).toMatchObject({ status: 'ok', details: { tip: later } });
      expect(byId(report, 8, 'deploy-run')).toMatchObject({ status: 'ok', details: { run: { headSha: later }, contains: true } });
      expect(stub.gitCalls().filter((c) => c.includes('fetch'))).toHaveLength(1);
      expect(fx.git(fx.main, 'cat-file', '-t', later).trim()).toBe('commit');
    });

    it('a green run whose head cannot be fetched is not run, never ok', async () => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      forge.answerFor(8, mergedView(pr));
      runs.answer([green('f'.repeat(40))]);

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(1);
      expect(byId(report, 8, 'deploy-run')).toMatchObject({
        status: 'not-run',
        reason: expect.stringMatching(/^fffffff not available locally \(fetch failed/),
        details: { workflow: 'deploy.yml', run: { headSha: 'f'.repeat(40) } },
      });
      expect(renderDeployHuman(report).split('\n')[0]).toBe('ATTENTION  #8 deploy run not run');
    });

    it('a green run whose headSha is not a SHA is not run', async () => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      forge.answerFor(8, mergedView(pr));
      runs.answer([green('abc1234')]);

      const { report } = await runReadOnly(['8']);

      expect(byId(report, 8, 'deploy-run')).toMatchObject({ status: 'not-run', reason: 'workflow-runs returned invalid headSha "abc1234"' });
    });

    it.each([
      ['disabled', () => configure({ forge: { 'workflow-runs': null }, check: { deploy: DEPLOYED } }), 'workflow-runs unavailable on github'],
      ['failing', () => runs.fail(), 'workflow-runs failed: workflow-runs stub: forge unreachable'],
      ['off the contract', () => runs.answer('{"runs": []}'), 'workflow-runs returned something other than a JSON array'],
    ])('workflow-runs %s: deploy-run not run, exit 1', async (_name, arrange, reason) => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      forge.answerFor(8, mergedView(pr));
      arrange();

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(1);
      expect(byId(report, 8, 'deploy-run')).toMatchObject({ status: 'not-run', reason });
      expect(byId(report, 8, 'on-branch').status).toBe('ok');
    });

    it('a workflow-runs that never answers leaves deploy-run not run within the time limit', async () => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      forge.answerFor(8, mergedView(pr));
      runs.hang();
      const started = Date.now();

      const { report } = await runReadOnly(['8'], { timeoutMs: 1_000 });

      expect(byId(report, 8, 'deploy-run')).toMatchObject({ status: 'not-run', reason: 'workflow-runs timed out after 1s' });
      expect(Date.now() - started).toBeLessThan(15_000);
    });

    it('a deploy branch origin does not have: on-branch not run', async () => {
      const pr = mergePr(fx, 8);
      forge.answerFor(8, mergedView(pr));
      runs.answer([green(pr.merge)]);

      const { report } = await runReadOnly(['8']);

      expect(byId(report, 8, 'on-branch')).toMatchObject({ status: 'not-run', reason: 'origin has no branch production', details: { branch: 'production' } });
    });

    it('several PRs: the deploy branch and its runs are read once, and the verdict is the worst', async () => {
      const first = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', first.merge);
      const second = mergePr(fx, 9);
      forge.answerFor(8, mergedView(first));
      forge.answerFor(9, mergedView(second));
      runs.answer([green(first.merge)]);

      const { report, exitCode } = await runReadOnly(['8', '9', '8']);

      expect(exitCode).toBe(1);
      expect(report.prs.map((p) => [p.number, p.verdict])).toEqual([[8, 'clear'], [9, 'attention']]);
      expect(runs.calls()).toEqual(['deploy.yml production']);
      expect(stub.gitCalls().filter((c) => c.startsWith('ls-remote'))).toHaveLength(1);
      const human = renderDeployHuman(report);
      expect(human.split('\n')[0]).toBe('ATTENTION  #9 not deployed');
      expect(human).toContain(`#9  merged 2026-11-22 → main   merge ${s(second.merge)}\n  ATTN    on production`);
    });

    it('check.skip ["deploy-run"] skips it by name without asking the forge', async () => {
      configure({ check: { deploy: DEPLOYED, skip: ['deploy-run'] } });
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      forge.answerFor(8, mergedView(pr));

      const { report } = await runReadOnly(['8']);

      expect(byId(report, 8, 'deploy-run')).toMatchObject({ status: 'skip', reason: 'check.skip' });
      expect(runs.calls()).toEqual([]);
      expect(renderDeployHuman(report).split('\n')[0]).toBe('CLEAR  #8 on production');
    });
  });

  describe('Scenario 14: nothing configured', () => {
    beforeEach(() => configure());

    it('the base branch is used, merge checks are reported and deploy-run is off: the spec sample', async () => {
      const pr = mergePr(fx, 8);
      forge.answerFor(8, mergedView(pr));
      ci.answer(pr.merge, passing(8));

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(0);
      expect(report).toMatchObject({ verdict: 'clear', deployBranch: null, workflow: null });
      expect(byId(report, 8, 'on-branch')).toMatchObject({ status: 'ok', details: { branch: 'main', tip: pr.merge, contains: true } });
      expect(byId(report, 8, 'merge-checks')).toMatchObject({ status: 'ok', details: { sha: pr.merge, passed: 8, failed: 0, pending: 0 } });
      expect(byId(report, 8, 'deploy-run')).toMatchObject({ status: 'off', reason: 'no deploy workflow configured (check.deploy.workflow)' });
      expect(runs.calls()).toEqual([]);
      expect(ci.calls()).toEqual([pr.merge]);

      expect(renderDeployHuman(report)).toBe(
        [
          'CLEAR  #8 on main; checks on the merge commit passed',
          '',
          `#8  merged 2026-11-22 → main   merge ${s(pr.merge)}`,
          `  ok      on main        origin/main @ ${s(pr.merge)} contains ${s(pr.merge)}`,
          `  ok      merge checks   ${s(pr.merge)}: 8 passed`,
          '  off     deploy run     no deploy workflow configured (check.deploy.workflow)',
          '',
        ].join('\n'),
      );
    });

    it('a merge commit since overtaken on main is still on it', async () => {
      const pr = mergePr(fx, 8);
      const later = pushFromElsewhere(fx, 'main', { 'later.txt': 'later\n' });
      forge.answerFor(8, mergedView(pr));
      ci.answer(pr.merge, passing(2));

      const { report } = await runReadOnly(['8']);

      expect(byId(report, 8, 'on-branch')).toMatchObject({ status: 'ok', details: { tip: later, contains: true } });
    });

    it('a squash merge (a merge commit with one parent) is judged the same way', async () => {
      const { head } = pushBranch(fx, [{ files: { 'src/s.ts': 's\n' }, message: 's' }], 'builder/spir-8');
      const squash = fx.commit(fx.main, { 'src/s.ts': 's\n' }, 'Feature 8 (#8)');
      fx.git(fx.main, 'push', '-q', 'origin', 'main');
      forge.answerFor(8, mergedView({ number: 8, branch: 'builder/spir-8', head, merge: squash, before: '' }));
      ci.answer(squash, passing(1));

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(0);
      expect(byId(report, 8, 'on-branch')).toMatchObject({ status: 'ok', details: { contains: true } });
    });

    it.each([
      ['failing', [{ name: 'unit', state: 'fail' as const }, ...passing(3)], 'merge checks failed', '3 passed, 1 failed (unit)'],
      ['still running', [{ name: 'e2e', state: 'pending' as const }], 'merge checks running', '1 still running'],
      ['absent', [], 'merge checks no runs', 'no runs'],
    ])('merge checks %s: attention', async (_name, answer, words, summary) => {
      const pr = mergePr(fx, 8);
      forge.answerFor(8, mergedView(pr));
      ci.answer(pr.merge, answer);

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(1);
      expect(byId(report, 8, 'merge-checks')).toMatchObject({ status: 'attention', summary: `${s(pr.merge)}: ${summary}` });
      expect(renderDeployHuman(report).split('\n')[0]).toBe(`ATTENTION  #8 ${words}`);
    });

    it.each([
      ['disabled', () => configure({ forge: { 'commit-checks': null } }), 'commit-checks unavailable on github'],
      ['failing', () => ci.fail(), 'commit-checks failed: commit-checks stub: forge unreachable'],
    ])('commit-checks %s: merge-checks not run, exit 1', async (_name, arrange, reason) => {
      const pr = mergePr(fx, 8);
      forge.answerFor(8, mergedView(pr));
      arrange();

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(1);
      expect(byId(report, 8, 'merge-checks')).toMatchObject({ status: 'not-run', reason });
    });

    it('check.deploy.branch alone: that branch is used, and merge checks are still reported', async () => {
      configure({ check: { deploy: { branch: 'production' } } });
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.before);
      forge.answerFor(8, mergedView(pr));
      ci.answer(pr.merge, passing(2));

      const { report } = await runReadOnly(['8']);

      expect(report.deployBranch).toBe('production');
      expect(byId(report, 8, 'on-branch')).toMatchObject({ status: 'attention', details: { branch: 'production', contains: false } });
      expect(byId(report, 8, 'merge-checks').status).toBe('ok');
      expect(renderDeployHuman(report).split('\n')[0]).toBe('ATTENTION  #8 not on production');
    });

    it('check.skip ["merge-checks"] skips it without asking the forge', async () => {
      configure({ check: { skip: ['merge-checks'] } });
      const pr = mergePr(fx, 8);
      forge.answerFor(8, mergedView(pr));

      const { report } = await runReadOnly(['8']);

      expect(byId(report, 8, 'merge-checks').status).toBe('skip');
      expect(ci.calls()).toEqual([]);
      expect(renderDeployHuman(report).split('\n')[0]).toBe('CLEAR  #8 on main');
    });
  });

  describe('Scenario 15: unmerged and unreadable PRs', () => {
    beforeEach(() => configure({ check: { deploy: DEPLOYED } }));

    it('a PR not merged: merged attention, the checks that need the merge commit not run', async () => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }], 'builder/spir-8');
      forge.answerFor(8, prView(head, { headRefName: 'builder/spir-8' }));

      const { report, exitCode } = await runReadOnly(['8']);

      expect(exitCode).toBe(1);
      expect(report.prs[0]).toMatchObject({ mergeCommit: null, mergedAt: null, baseRef: 'main', verdict: 'attention' });
      expect(byId(report, 8, 'merged')).toMatchObject({ status: 'attention', summary: 'OPEN: not merged', details: { state: 'OPEN', mergeCommit: null } });
      expect(byId(report, 8, 'on-branch')).toMatchObject({ status: 'not-run', reason: 'the PR is not merged (OPEN)', details: { branch: 'production' } });
      expect(byId(report, 8, 'deploy-run')).toMatchObject({ status: 'not-run', reason: 'the PR is not merged (OPEN)' });
      expect(runs.calls()).toEqual([]);
      const human = renderDeployHuman(report);
      expect(human.split('\n')[0]).toBe('ATTENTION  #8 not merged');
      expect(human).toContain('#8  OPEN → main\n  ATTN    merged          OPEN: not merged\n  not run on production');
    });

    it('a preset that does not return mergeCommit: merged not run, naming the field', async () => {
      const pr = mergePr(fx, 8);
      const view = mergedView(pr);
      delete view.mergeCommit;
      forge.answerFor(8, view);

      const { report } = await runReadOnly(['8']);

      expect(byId(report, 8, 'merged')).toMatchObject({ status: 'not-run', reason: 'pr-view did not return mergeCommit' });
      expect(byId(report, 8, 'on-branch')).toMatchObject({ status: 'not-run', reason: 'pr-view did not return mergeCommit' });
      expect(renderDeployHuman(report).split('\n')[0]).toBe('ATTENTION  #8 merge not read');
    });

    it('Scenario 15a: one PR that cannot be read is a per-PR not run; the others are reported in full', async () => {
      const pr = mergePr(fx, 8);
      setRemoteBranch(fx, 'production', pr.merge);
      forge.answerFor(8, mergedView(pr));
      forge.failFor(99999, 'GraphQL: Could not resolve to a PullRequest with the number of 99999. (repository.pullRequest)');
      runs.answer([green(pr.merge)]);

      const { report, exitCode } = await runReadOnly(['8', '99999']);

      expect(exitCode).toBe(1);
      expect(report.prs[0]).toMatchObject({ number: 8, verdict: 'clear' });
      const reason = 'pr-view failed: GraphQL: Could not resolve to a PullRequest with the number of 99999. (repository.pullRequest)';
      expect(report.prs[1]).toMatchObject({ number: 99999, verdict: 'attention', mergeCommit: null, mergedAt: null, baseRef: null });
      expect(byId(report, 99999, 'merged')).toMatchObject({ status: 'not-run', reason });
      for (const id of ['on-branch', 'deploy-run']) expect(byId(report, 99999, id)).toMatchObject({ status: 'not-run', reason: 'the PR could not be read' });
      const human = renderDeployHuman(report);
      expect(human.split('\n')[0]).toBe('ATTENTION  #99999 not read');
      expect(human).toContain(`\n#99999\n  not run merged          ${reason}\n`);
    });
  });
});
