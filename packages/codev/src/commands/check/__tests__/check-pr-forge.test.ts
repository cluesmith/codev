/**
 * Spec 1951 — `codev check pr`: the checks that need the forge (POSIX).
 *
 * `state`, `forge`, `checks` (with the porch-only walk on real commits) and `linked-issue`.
 * `pr-view` and `commit-checks` come from overrides that answer per call and per commit; a
 * stub `git` first on PATH records every git call, so each case also proves nothing off the
 * read-only list ran, and the repository state is compared before and after.
 */

import { spawn as realSpawn } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPr, renderPrHuman } from '../pr.js';
import type { Check, CommandOptions, PrReport } from '../report.js';
import type { SpawnFn } from '../runner.js';
import { useFakeHome } from './helpers/fake-home.js';
import { createFixture, snapshotRepoState, type Fixture } from './helpers/git-fixture.js';
import {
  commitChecksOverride,
  passing,
  PR_BRANCH,
  prView,
  prViewOverride,
  pushBranch,
  writeConfig,
  type CommitChecksOverride,
  type PrViewOverride,
  type Run,
} from './helpers/pr-fixture.js';
import { expectPrReportShape } from './helpers/report-shape.js';
import { createStubBin, type StubBin } from './helpers/stub-bin.js';

const isWindows = process.platform === 'win32';

useFakeHome();

let fx: Fixture;
let stub: StubBin;
let forge: PrViewOverride;
let ci: CommitChecksOverride;
let uninstall: () => void;

function configure(extra: { forge?: Record<string, unknown>; check?: Record<string, unknown> } = {}): void {
  writeConfig(fx, { forge: { 'pr-view': forge.script, 'commit-checks': ci.script, ...extra.forge }, ...(extra.check ? { check: extra.check } : {}) });
}

beforeEach(() => {
  fx = createFixture();
  stub = createStubBin(path.join(fx.root, 'bin'));
  uninstall = stub.install();
  forge = prViewOverride(fx);
  ci = commitChecksOverride(fx);
  configure();
});

afterEach(() => {
  uninstall();
  fx.cleanup();
});

async function runReadOnly(extra: Partial<CommandOptions> = {}): Promise<{ report: PrReport; exitCode: number }> {
  const before = snapshotRepoState(fx, fx.main);
  const result = await checkPr('7', { cwd: fx.main, env: { ...fx.env, ...stub.env }, timeoutMs: 20_000, ...extra });
  if ('error' in result.report) throw new Error(`unexpected exit 2: ${result.report.error.message}`);
  expect(snapshotRepoState(fx, fx.main)).toEqual(before);
  expect(stub.violations()).toEqual([]);
  expectPrReportShape(result.report);
  return { report: result.report, exitCode: result.exitCode };
}

function byId(report: PrReport, id: string): Check {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check`);
  return found;
}

function verdictLine(report: PrReport): string {
  return renderPrHuman(report).split('\n')[0];
}

const PORCH_FILE = 'codev/projects/7-feature/status.yaml';

/** A code commit, then `porch` porch-only commits, pushed. `tail` is newest first. */
function prWithPorchTail(porch: number): { dir: string; code: string; tail: string[]; head: string } {
  const { dir, head: code } = pushBranch(fx, [{ files: { 'src/a.ts': 'export const a = 1;\n' }, message: 'the code' }]);
  const tail: string[] = [];
  for (let i = 0; i < porch; i++) tail.unshift(fx.commit(dir, { [PORCH_FILE]: `step: ${i}\n` }, `chore(porch): 7 step ${i}`));
  if (porch > 0) fx.git(dir, 'push', '-q', 'origin', PR_BRANCH);
  return { dir, code, tail, head: tail[0] ?? code };
}

const running = (n: number): Run[] => Array.from({ length: n }, (_, i) => ({ name: `ci-${i + 1}`, state: 'pending' as const }));

describe.skipIf(isWindows)('Spec 1951 — check pr: forge state and CI (stub git)', { timeout: 30_000 }, () => {
  it('Scenario 1: a clean PR, all runs green on head, is CLEAR in under 25 lines', async () => {
    const { head } = pushBranch(fx, [{ files: { 'src/a.ts': 'a\n' }, message: 'a' }]);
    forge.answer(prView(head));
    ci.answer(head, passing(8));

    const { report, exitCode } = await runReadOnly();

    expect(exitCode).toBe(0);
    expect(report.verdict).toBe('clear');
    for (const c of report.checks) expect(['ok', 'info', 'off'], c.id).toContain(c.status);
    expect(byId(report, 'state')).toMatchObject({ status: 'ok', details: { state: 'OPEN', draft: false } });
    expect(byId(report, 'forge')).toMatchObject({ status: 'ok', summary: 'MERGEABLE, CLEAN', details: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } });
    expect(byId(report, 'checks')).toMatchObject({
      status: 'ok',
      summary: `head ${head.slice(0, 7)}: 8 passed`,
      details: { lastCodeCommit: head, porchOnlyAbove: 0, head: { sha: head, passed: 8 }, code: { sha: head } },
    });
    expect(byId(report, 'linked-issue')).toMatchObject({ status: 'info', summary: `"Fixes #7" — matches ${PR_BRANCH}` });
    expect(ci.calls()).toEqual([head]);

    const human = renderPrHuman(report);
    expect(human.split('\n')[0]).toBe('CLEAR  PR #7 — ready to recommend');
    expect(human.trimEnd().split('\n').length).toBeLessThanOrEqual(25);
    // An ok head and state read in the header, not as lines of their own.
    expect(human).toContain('OPEN   builder/spir-7 → main');
    expect(human).not.toMatch(/\n {2}ok +state /);
    expect(human).toMatch(/\n {2}ok +checks +head [0-9a-f]{7}: 8 passed\n/);
  });

  describe('Scenario 7: porch-only commits above the code', () => {
    it('runs only on the code commit: the walk finds it past the porch commits', async () => {
      const { code, tail, head } = prWithPorchTail(2);
      forge.answer(prView(head));
      ci.answer(code, passing(8));

      const { report, exitCode } = await runReadOnly();

      expect(exitCode).toBe(0);
      expect(byId(report, 'checks')).toMatchObject({
        status: 'ok',
        summary: `code ${code.slice(0, 7)}: 8 passed\nhead ${head.slice(0, 7)}: no runs — 2 porch-state commits above the code`,
        details: { lastCodeCommit: code, porchOnlyAbove: 2 },
      });
      expect(ci.calls()).toEqual([...tail, code]);
      expect(renderPrHuman(report)).toContain(`checks         code ${code.slice(0, 7)}: 8 passed\n`);
    });

    it('runs only on head, all passed: one line, head alone looked up', async () => {
      const { head } = prWithPorchTail(1);
      forge.answer(prView(head));
      ci.answer(head, passing(8));

      const { report } = await runReadOnly();

      expect(byId(report, 'checks')).toMatchObject({ status: 'ok', summary: `head ${head.slice(0, 7)}: porch-only, 8 passed` });
      expect(ci.calls()).toEqual([head]);
    });

    it('runs on a push tip between them', async () => {
      const { code, tail, head } = prWithPorchTail(3);
      forge.answer(prView(head));
      ci.answer(tail[1], passing(8));

      const { report } = await runReadOnly();

      expect(byId(report, 'checks')).toMatchObject({
        status: 'ok',
        summary: `code ${tail[1].slice(0, 7)}: 8 passed\nhead ${head.slice(0, 7)}: no runs — 3 porch-state commits above the code`,
        details: { code: { sha: tail[1] }, lastCodeCommit: code },
      });
      expect(ci.calls()).toEqual([head, tail[1]]);
    });

    it('no runs anywhere is attention: checks (none)', async () => {
      const { code, head } = prWithPorchTail(1);
      forge.answer(prView(head));

      const { report, exitCode } = await runReadOnly();

      expect(exitCode).toBe(1);
      expect(byId(report, 'checks')).toMatchObject({
        status: 'attention',
        summary: `code ${code.slice(0, 7)}: no runs\nhead ${head.slice(0, 7)}: no runs — 1 porch-state commit above the code`,
      });
      expect(verdictLine(report)).toBe('ATTENTION  PR #7 — checks (none)');
    });

    it('a failure on head while the code commit is green: checks (failed)', async () => {
      const { code, head } = prWithPorchTail(1);
      forge.answer(prView(head));
      ci.answer(head, [...passing(7), { name: 'unit', state: 'fail' }]);
      ci.answer(code, passing(8));

      const { report } = await runReadOnly();

      expect(byId(report, 'checks').summary).toBe(`code ${code.slice(0, 7)}: 8 passed\nhead ${head.slice(0, 7)}: porch-only, 7 passed, 1 failed (unit)`);
      expect(verdictLine(report)).toBe('ATTENTION  PR #7 — checks (failed)');
    });

    it('head pending while the code is green: "still running" on head, checks (running)', async () => {
      const { code, head } = prWithPorchTail(1);
      forge.answer(prView(head));
      ci.answer(head, running(8));
      ci.answer(code, passing(8));

      const { report } = await runReadOnly();

      expect(byId(report, 'checks')).toMatchObject({
        status: 'attention',
        summary: `code ${code.slice(0, 7)}: 8 passed\nhead ${head.slice(0, 7)}: porch-only, 8 still running`,
      });
      expect(verdictLine(report)).toBe('ATTENTION  PR #7 — checks (running)');
    });

    it('head pending while the code failed: checks (failed)', async () => {
      const { code, head } = prWithPorchTail(1);
      forge.answer(prView(head));
      ci.answer(head, running(8));
      ci.answer(code, [...passing(7), { name: 'unit', state: 'fail' }]);

      const { report } = await runReadOnly();

      expect(byId(report, 'checks').summary).toBe(`code ${code.slice(0, 7)}: 7 passed, 1 failed (unit)\nhead ${head.slice(0, 7)}: porch-only, 8 still running`);
      expect(verdictLine(report)).toBe('ATTENTION  PR #7 — checks (failed)');
    });

    it('a commit touching anything outside codev/projects/ is code, a thread log included', async () => {
      const { dir, head: porch } = prWithPorchTail(1);
      const thread = fx.commit(dir, { 'codev/state/spir-7_thread.md': 'log\n' }, 'thread log');
      fx.git(dir, 'push', '-q', 'origin', PR_BRANCH);
      forge.answer(prView(thread));
      ci.answer(thread, passing(2));

      const { report } = await runReadOnly();

      expect(byId(report, 'checks').details).toMatchObject({ lastCodeCommit: thread, porchOnlyAbove: 0 });
      expect(porch).not.toBe(thread);
    });

    it('a merge commit at head is never porch-only', async () => {
      const { dir } = prWithPorchTail(1);
      fx.commit(fx.main, { 'later.txt': 'later\n' }, 'main moves on');
      fx.git(fx.main, 'push', '-q', 'origin', 'main');
      fx.git(dir, 'merge', '-q', '--no-ff', '-m', 'merge main', 'origin/main');
      const merge = fx.git(dir, 'rev-parse', 'HEAD').trim();
      fx.git(dir, 'push', '-q', 'origin', PR_BRANCH);
      forge.answer(prView(merge));
      ci.answer(merge, passing(2));

      const { report } = await runReadOnly();

      expect(byId(report, 'checks')).toMatchObject({ status: 'ok', details: { lastCodeCommit: merge, porchOnlyAbove: 0 } });
    });

    it('main merged into a porch-only branch: the merge is the code commit, never a commit of main', async () => {
      const { dir } = pushBranch(fx, [{ files: { [PORCH_FILE]: 'step: 0\n' }, message: 'chore(porch): 7 init' }]);
      const onMain = fx.commit(fx.main, { 'later.txt': 'later\n' }, 'main moves on');
      fx.git(fx.main, 'push', '-q', 'origin', 'main');
      fx.git(dir, 'merge', '-q', '--no-ff', '-m', 'merge main', 'origin/main');
      const merge = fx.git(dir, 'rev-parse', 'HEAD').trim();
      const head = fx.commit(dir, { [PORCH_FILE]: 'step: 1\n' }, 'chore(porch): 7 next');
      fx.git(dir, 'push', '-q', 'origin', PR_BRANCH);
      forge.answer(prView(head));
      ci.answer(onMain, passing(5));

      const { report } = await runReadOnly();

      expect(byId(report, 'checks')).toMatchObject({ status: 'attention', details: { lastCodeCommit: merge, porchOnlyAbove: 1 } });
      expect(ci.calls()).toEqual([head, merge]);
    });

    it('a git call in the walk that fails leaves checks not run by name; the other checks are still reported', async () => {
      const { head } = prWithPorchTail(1);
      forge.answer(prView(head));
      ci.answer(head, passing(2));
      const failingDiffTree: SpawnFn = (command, args, options) =>
        args[0] === 'diff-tree'
          ? realSpawn(process.execPath, ['-e', 'process.stderr.write("fatal: simulated failure\\n"); process.exit(128)'], options)
          : realSpawn(command, args, options);

      const { report, exitCode } = await runReadOnly({ spawn: failingDiffTree });

      expect(exitCode).toBe(1);
      expect(byId(report, 'checks')).toMatchObject({ status: 'not-run', reason: 'git diff-tree failed: fatal: simulated failure' });
      expect(byId(report, 'trial-merge').status).toBe('ok');
      expect(ci.calls()).toEqual([]);
    });

    it('more than 10 porch-only commits: not run, nothing looked up', async () => {
      const { head } = prWithPorchTail(11);
      forge.answer(prView(head));

      const { report, exitCode } = await runReadOnly();

      expect(exitCode).toBe(1);
      expect(byId(report, 'checks')).toMatchObject({ status: 'not-run', reason: 'more than 10 porch-only commits' });
      expect(ci.calls()).toEqual([]);
    });

    it('exactly 10 porch-only commits: at most 10 lookups, the code commit among them', async () => {
      const { code, head } = prWithPorchTail(10);
      forge.answer(prView(head));
      ci.answer(code, passing(3));

      const { report } = await runReadOnly();

      expect(byId(report, 'checks')).toMatchObject({ status: 'ok', details: { lastCodeCommit: code, porchOnlyAbove: 10 } });
      expect(ci.calls()).toHaveLength(10);
      expect(ci.calls().at(-1)).toBe(code);
    });

    it('a branch of porch-only commits has no code commit: attention', async () => {
      const { dir } = pushBranch(fx, [{ files: { [PORCH_FILE]: 'step: 0\n' }, message: 'chore(porch): 7 init' }]);
      const head = fx.commit(dir, { [PORCH_FILE]: 'step: 1\n' }, 'chore(porch): 7 next');
      fx.git(dir, 'push', '-q', 'origin', PR_BRANCH);
      forge.answer(prView(head));
      ci.answer(head, passing(2));

      const { report } = await runReadOnly();

      expect(byId(report, 'checks')).toMatchObject({
        status: 'attention',
        summary: `head ${head.slice(0, 7)}: 2 passed — no code commit: all 2 commits since the branch point are porch-only`,
        details: { lastCodeCommit: null, porchOnlyAbove: 2 },
      });
    });
  });

  describe('Scenario 10: state', () => {
    it.each([
      ['a draft', { isDraft: true }, 'OPEN but a draft: it must be marked ready for review first', 'state (draft)'],
      ['a closed PR', { state: 'CLOSED' }, 'CLOSED: only an open PR can be recommended', 'state (closed)'],
      ['a merged PR', { state: 'MERGED', mergedAt: '2026-11-20T10:00:00Z' }, 'MERGED: only an open PR can be recommended', 'state (merged)'],
      ['a merged PR a forge calls closed', { state: 'closed', mergedAt: '2026-11-20T10:00:00Z' }, 'MERGED: only an open PR can be recommended', 'state (merged)'],
    ])('%s needs attention and can never read CLEAR', async (_name, fields, summary, named) => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      forge.answer(prView(head, fields));
      ci.answer(head, passing(2));

      const { report, exitCode } = await runReadOnly();

      expect(exitCode).toBe(1);
      expect(byId(report, 'state')).toMatchObject({ status: 'attention', summary });
      expect(verdictLine(report)).toBe(`ATTENTION  PR #7 — ${named}`);
      expect(renderPrHuman(report)).toMatch(/\n {2}ATTN +state +/);
    });

    it("GitLab's lower-case 'opened' is OPEN", async () => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      forge.answer(prView(head, { state: 'opened' }));
      ci.answer(head, passing(2));

      const { report } = await runReadOnly();

      expect(byId(report, 'state')).toMatchObject({ status: 'ok', details: { state: 'OPEN' } });
      expect(report.pr.state).toBe('OPEN');
      expect(report.verdict).toBe('clear');
    });
  });

  describe('forge mergeability', () => {
    it('CONFLICTING needs attention', async () => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      forge.answer(prView(head, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
      ci.answer(head, passing(2));

      const { report } = await runReadOnly();

      expect(byId(report, 'forge')).toMatchObject({ status: 'attention', summary: 'CONFLICTING, DIRTY' });
      expect(verdictLine(report)).toBe('ATTENTION  PR #7 — forge (conflicts)');
    });

    it('BLOCKED by a required review is still MERGEABLE: ok, with the reason', async () => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      forge.answer(prView(head, { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }));
      ci.answer(head, passing(2));

      const { report } = await runReadOnly();

      expect(byId(report, 'forge')).toMatchObject({
        status: 'ok',
        summary: 'MERGEABLE, BLOCKED (review required)',
        details: { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' },
      });
      expect(report.verdict).toBe('clear');
    });

    it('UNKNOWN at the first read takes the re-read', async () => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      forge.answer(prView(head));
      forge.answerOn(1, prView(head, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }));
      ci.answer(head, passing(2));

      const { report } = await runReadOnly();

      expect(forge.calls()).toBe(2);
      expect(byId(report, 'forge')).toMatchObject({ status: 'ok', summary: 'MERGEABLE, CLEAN' });
    });

    it('UNKNOWN twice: the forge has not computed it yet', async () => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      forge.answer(prView(head, { mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }));
      ci.answer(head, passing(2));

      const { report } = await runReadOnly();

      expect(byId(report, 'forge')).toMatchObject({ status: 'attention', summary: 'forge has not computed mergeability yet; re-run shortly' });
      expect(verdictLine(report)).toBe('ATTENTION  PR #7 — forge (not computed)');
    });
  });

  it('Scenario 12a: a closing keyword for another issue needs attention', async () => {
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    forge.answer(prView(head, { body: 'Fixes #8' }));
    ci.answer(head, passing(2));

    const { report } = await runReadOnly();

    expect(byId(report, 'linked-issue')).toMatchObject({ status: 'attention', summary: `"Fixes #8", but ${PR_BRANCH} is for #7` });
    expect(verdictLine(report)).toBe('ATTENTION  PR #7 — linked issue (wrong issue)');
  });

  describe('Scenario 24: a field or concept the forge cannot provide is not run, never ok', () => {
    it.each([
      ['state', 'state', 'pr-view did not return state'],
      ['isDraft', 'state', 'pr-view did not return isDraft'],
      ['mergeable', 'forge', 'pr-view did not return mergeable'],
    ])('pr-view without %s', async (field, id, reason) => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      const view = prView(head);
      delete view[field];
      forge.answer(view);
      ci.answer(head, passing(2));

      const { report, exitCode } = await runReadOnly();

      expect(exitCode).toBe(1);
      expect(byId(report, id)).toMatchObject({ status: 'not-run', reason });
      expect(verdictLine(report)).toContain(`${id} (not run)`);
    });

    it('pr-view without mergeStateStatus (as the gitea preset): the verdict follows mergeable, and the line says so', async () => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      const view = prView(head);
      delete view.mergeStateStatus;
      forge.answer(view);
      ci.answer(head, passing(2));

      const { report } = await runReadOnly();

      expect(byId(report, 'forge')).toMatchObject({
        status: 'ok',
        summary: 'MERGEABLE (merge state not reported)',
        details: { mergeable: 'MERGEABLE', mergeStateStatus: null },
      });
    });

    it('commit-checks disabled', async () => {
      configure({ forge: { 'commit-checks': null } });
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      forge.answer(prView(head));

      const { report, exitCode } = await runReadOnly();

      expect(exitCode).toBe(1);
      expect(byId(report, 'checks')).toMatchObject({ status: 'not-run', reason: 'commit-checks unavailable on github' });
    });

    it('commit-checks failing', async () => {
      ci.fail();
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      forge.answer(prView(head));

      const { report, exitCode } = await runReadOnly();

      expect(exitCode).toBe(1);
      expect(byId(report, 'checks')).toMatchObject({ status: 'not-run', reason: 'commit-checks failed: commit-checks stub: forge unreachable' });
    });

    it('commit-checks returning something off the contract', async () => {
      const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
      forge.answer(prView(head));
      ci.answer(head, '[{"name": "unit", "state": "success"}]');

      const { report } = await runReadOnly();

      expect(byId(report, 'checks')).toMatchObject({ status: 'not-run', reason: expect.stringMatching(/^commit-checks item 1 \(unit\) has state "success"/) });
    });
  });

  it('Scenario 12b: a commit-checks that never answers leaves checks not run within the time limit', async () => {
    ci.hang();
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    forge.answer(prView(head));
    const started = Date.now();

    const { report, exitCode } = await runReadOnly({ timeoutMs: 1_000 });

    expect(exitCode).toBe(1);
    expect(byId(report, 'checks')).toMatchObject({ status: 'not-run', reason: 'commit-checks timed out after 1s' });
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('check.skip ["checks"] skips it by name without asking the forge', async () => {
    configure({ check: { skip: ['checks'] } });
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    forge.answer(prView(head));

    const { report } = await runReadOnly();

    expect(byId(report, 'checks')).toMatchObject({ status: 'skip', reason: 'check.skip' });
    expect(ci.calls()).toEqual([]);
    expect(report.verdict).toBe('clear');
  });
});
