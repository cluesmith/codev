/**
 * Spec 1951 — `codev check pr`: merge mechanics, scenario by scenario (POSIX).
 *
 * The shipped github `pr-view` script runs against a stub `gh` that answers from fixtures;
 * a stub `git` first on PATH records every git call and passes it to the real git, so each
 * test also proves that nothing off the read-only list ran. Every scenario runs on a real
 * repository with a bare origin, and the repository state is compared before and after.
 */

import { spawn as realSpawn } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunnerRefusal } from '../allow-list.js';
import { checkPr, renderPrHuman } from '../pr.js';
import type { Check, CommandOptions, ErrorReport, PrReport } from '../report.js';
import { createRunner, type SpawnFn } from '../runner.js';
import { useFakeHome } from './helpers/fake-home.js';
import { createFixture, snapshotRepoState, type Fixture } from './helpers/git-fixture.js';
import { otherClone, PR_BRANCH, PR_NUMBER, PR_VIEW_FIELDS, prView, pushBranch, pushFromElsewhere, writeConfig } from './helpers/pr-fixture.js';
import { createStubBin, type StubBin } from './helpers/stub-bin.js';

const isWindows = process.platform === 'win32';

useFakeHome();

let fx: Fixture;
let stub: StubBin;
let uninstall: () => void;

beforeEach(() => {
  fx = createFixture();
  stub = createStubBin(path.join(fx.root, 'bin'));
  uninstall = stub.install();
});

afterEach(() => {
  uninstall();
  fx.cleanup();
});

function answerPrView(view: Record<string, unknown>, number = PR_NUMBER): void {
  stub.answer(['pr', 'view', String(number), '--json', PR_VIEW_FIELDS], JSON.stringify(view));
}

async function run(extra: Partial<CommandOptions> = {}, number = String(PR_NUMBER)) {
  return checkPr(number, { cwd: fx.main, env: { ...fx.env, ...stub.env }, timeoutMs: 20_000, ...extra });
}

async function runReport(extra: Partial<CommandOptions> = {}): Promise<{ report: PrReport; exitCode: number }> {
  const result = await run(extra);
  if ('error' in result.report) throw new Error(`unexpected exit 2: ${result.report.error.message}`);
  return { report: result.report, exitCode: result.exitCode };
}

function byId(report: PrReport, id: string): Check {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check`);
  return found;
}

function statuses(report: PrReport): Record<string, string> {
  return Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
}

/** Run, and assert the repository is untouched and every subprocess stayed on the read-only list. */
async function runReadOnly(extra: Partial<CommandOptions> = {}) {
  const before = snapshotRepoState(fx, fx.main);
  const result = await runReport(extra);
  expect(snapshotRepoState(fx, fx.main)).toEqual(before);
  expect(stub.violations()).toEqual([]);
  return result;
}

// Each case builds real repositories and runs the command once or twice.
describe.skipIf(isWindows)('Spec 1951 — check pr: merge mechanics (stub gh and git)', { timeout: 30_000 }, () => {
  it('reports a clean PR: exact head, live base, every mechanics check', async () => {
    const { head } = pushBranch(fx, [{ files: { 'src/a.ts': 'export const a = 1;\n' }, message: 'add a' }]);
    answerPrView(prView(head));
    const base = fx.git(fx.main, 'rev-parse', 'main').trim();

    const { report, exitCode } = await runReadOnly();

    expect(exitCode).toBe(0);
    expect(report.verdict).toBe('clear');
    expect(statuses(report)).toEqual({
      head: 'ok',
      attribution: 'off',
      'trial-merge': 'ok',
      watched: 'ok',
      overlap: 'info',
      size: 'info',
      'to-read': 'info',
    });
    expect(report.pr).toMatchObject({ number: 7, head, baseRef: 'main', baseTip: base, headRef: PR_BRANCH, draft: false, state: 'OPEN' });
    expect(report.pr.localBranch).toEqual({ name: PR_BRANCH, sha: head });
    expect(byId(report, 'trial-merge').details).toEqual({ baseTip: base, head, conflicts: 0, files: [] });
    expect(byId(report, 'size').details).toEqual({ additions: 1, deletions: 0, files: 1 });
    // The anchoring read and the end-of-run re-read.
    expect(stub.ghCalls()).toEqual([`pr view 7 --json ${PR_VIEW_FIELDS}`, `pr view 7 --json ${PR_VIEW_FIELDS}`]);
    expect(stub.gitCalls().some((call) => call.startsWith('merge-tree --write-tree'))).toBe(true);

    const human = renderPrHuman(report);
    expect(human.split('\n')[0]).toBe('CLEAR  PR #7 — ready to recommend');
    expect(human).toContain(`head  ${head.slice(0, 7)}  (local ${PR_BRANCH} matches)`);
    expect(human).toContain(`base  main @ ${base.slice(0, 7)} (origin, live)`);
  });

  it('Scenario 2: a conflicting trial merge lists the files and their count; nothing moves', async () => {
    const { head } = pushBranch(fx, [{ files: { 'README.md': 'ours\n', 'src/x.ts': 'x\n' }, message: 'change readme' }]);
    fx.commit(fx.main, { 'README.md': 'theirs\n' }, 'main changes readme');
    fx.git(fx.main, 'push', '-q', 'origin', 'main');
    answerPrView(prView(head));

    const { report, exitCode } = await runReadOnly();

    expect(exitCode).toBe(1);
    const merge = byId(report, 'trial-merge');
    expect(merge.status).toBe('attention');
    expect(merge.details).toMatchObject({ conflicts: 1, files: ['README.md'] });
    expect(merge.summary).toMatch(/^1 conflicting file merging into main @ [0-9a-f]{7}: README\.md$/);
    expect(renderPrHuman(report).split('\n')[0]).toBe('ATTENTION  PR #7 — trial merge (conflicts)');
    // The base also changed README.md since the branch point.
    expect(byId(report, 'overlap').details).toEqual({ files: ['README.md'] });
  });

  it('Scenario 3: a stale local origin/main is not used; the live tip conflicts', async () => {
    const { head } = pushBranch(fx, [{ files: { 'README.md': 'ours\n' }, message: 'change readme' }]);
    const stale = fx.git(fx.main, 'rev-parse', 'refs/remotes/origin/main').trim();
    const live = pushFromElsewhere(fx, 'main', { 'README.md': 'theirs\n' });
    answerPrView(prView(head));

    const { report } = await runReadOnly();

    expect(report.pr.baseTip).toBe(live);
    expect(byId(report, 'trial-merge')).toMatchObject({ status: 'attention', details: { baseTip: live, conflicts: 1 } });
    expect(fx.git(fx.main, 'rev-parse', 'refs/remotes/origin/main').trim()).toBe(stale);
  });

  it('Scenario 4: a head that is not local is fetched ref-neutrally, then checked', async () => {
    const head = pushFromElsewhere(fx, PR_BRANCH, { 'src/remote.ts': 'r\n' });
    expect(() => fx.git(fx.main, 'cat-file', '-e', `${head}^{commit}`)).toThrow();
    answerPrView(prView(head));

    const { report, exitCode } = await runReadOnly();

    expect(exitCode).toBe(0);
    expect(byId(report, 'head')).toMatchObject({ status: 'ok', details: { relation: 'absent' } });
    expect(byId(report, 'trial-merge').status).toBe('ok');
    expect(fx.git(fx.main, 'cat-file', '-t', head).trim()).toBe('commit');
    expect(stub.gitCalls().filter((c) => c.includes(' fetch '))).toEqual([
      `-c gc.auto=0 -c maintenance.auto=false fetch --no-write-fetch-head --refmap= --no-tags --no-recurse-submodules --quiet origin ${head}`,
    ]);
  });

  it('Scenario 5: a head that cannot be fetched leaves the head checks not run (exit 1)', async () => {
    const missing = 'e'.repeat(40);
    answerPrView(prView(missing, { headRefName: 'builder/spir-8' }));

    const { report, exitCode } = await runReadOnly();

    expect(exitCode).toBe(1);
    for (const id of ['trial-merge', 'watched', 'overlap', 'size', 'to-read']) {
      expect(byId(report, id), id).toMatchObject({ status: 'not-run', reason: expect.stringMatching(/^eeeeeee not available locally \(fetch failed/) });
    }
    expect(report.checks.some((c) => c.status === 'ok' && c.id !== 'head')).toBe(false);
  });

  it('a base branch origin does not have leaves the base checks not run', async () => {
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    answerPrView(prView(head, { baseRefName: 'release' }));

    const { report, exitCode } = await runReadOnly();

    expect(exitCode).toBe(1);
    expect(report.pr.baseTip).toBeNull();
    expect(byId(report, 'trial-merge')).toMatchObject({ status: 'not-run', reason: 'origin has no branch release' });
    expect(renderPrHuman(report)).toContain('base  release (live tip not read)');
  });

  it('Scenario 6: attribution in a commit and in the description is reported by place; base commits are not scanned', async () => {
    writeConfig(fx, { check: { attribution: ['^\\s*Co-Authored-By:'] } });
    fx.commit(fx.main, { 'old.txt': 'old\n' }, 'already on main\n\nCo-Authored-By: Someone <x@example.invalid>');
    fx.git(fx.main, 'push', '-q', 'origin', 'main');
    const { head } = pushBranch(fx, [
      { files: { 'a.txt': 'a\n' }, message: 'clean commit' },
      { files: { 'b.txt': 'b\n' }, message: 'add b\n\nCo-Authored-By: Claude <noreply@example.invalid>' },
    ]);
    answerPrView(prView(head, { body: 'Summary\n\nco-authored-by: a bot\nFixes #7' }));

    const { report, exitCode } = await runReadOnly();

    expect(exitCode).toBe(1);
    const attribution = byId(report, 'attribution');
    expect(attribution.status).toBe('attention');
    expect(attribution.details).toEqual({
      patterns: ['^\\s*Co-Authored-By:'],
      hits: [
        { where: 'description', line: 3, text: 'co-authored-by: a bot' },
        { where: 'commit', sha: head, line: 3, text: 'Co-Authored-By: Claude <noreply@example.invalid>' },
      ],
      commitsScanned: 2,
    });
    expect(attribution.summary).toBe(`2 lines: description line 3, commit ${head.slice(0, 7)} "Co-Authored-By: Claude <norep…"`);
  });

  it('attribution with no hits is ok; with no configured patterns it is off', async () => {
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'clean' }]);
    answerPrView(prView(head));
    expect(byId((await runReadOnly()).report, 'attribution')).toMatchObject({
      status: 'off',
      summary: 'no patterns configured (check.attribution)',
    });

    writeConfig(fx, { check: { attribution: ['Generated with \\[Claude Code\\]'] } });
    expect(byId((await runReadOnly()).report, 'attribution')).toMatchObject({ status: 'ok', summary: 'none in the description or 1 commit' });
  });

  it('Scenario 8: a flagged watched file needs attention; an unflagged one is info', async () => {
    writeConfig(fx, { check: { flag: ['CLAUDE.md'] } });
    const { head } = pushBranch(fx, [
      { files: { 'CLAUDE.md': 'rules\n', 'codev/roles/architect.md': 'role\n', 'src/a.ts': 'a\n' }, message: 'instructions' },
    ]);
    answerPrView(prView(head));

    const { report } = await runReadOnly();

    const watched = byId(report, 'watched');
    expect(watched).toMatchObject({
      status: 'attention',
      summary: 'CLAUDE.md (flagged), codev/roles/architect.md',
      details: { files: [{ path: 'CLAUDE.md', flagged: true }, { path: 'codev/roles/architect.md', flagged: false }] },
    });
    expect(renderPrHuman(report).split('\n')[0]).toBe('ATTENTION  PR #7 — watched (flagged)');

    writeConfig(fx, { check: { flag: ['src/**'] } });
    // check.flag applies only to watched files: src/a.ts is flagged but not watched.
    expect(byId((await runReadOnly()).report, 'watched')).toMatchObject({ status: 'info' });
  });

  it('Scenario 9: porch state and lockfiles are not for reading; check.notForReading replaces the default', async () => {
    const big = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const { head } = pushBranch(fx, [
      {
        files: {
          'src/big.ts': `${big}\n`,
          'src/small.ts': 'small\n',
          'pnpm-lock.yaml': 'lock\n',
          'packages/x/package-lock.json': '{}\n',
          'codev/projects/7-feature/status.yaml': 'phase: review\n',
          'codev/state/spir-7_thread.md': 'log\n',
        },
        message: 'work',
      },
    ]);
    answerPrView(prView(head));

    const first = byId((await runReadOnly()).report, 'to-read');
    expect(first.details).toEqual({
      files: [
        { path: 'src/big.ts', additions: 30, deletions: 0 },
        { path: 'src/small.ts', additions: 1, deletions: 0 },
      ],
      excluded: ['codev/projects/7-feature/status.yaml', 'codev/state/spir-7_thread.md', 'packages/x/package-lock.json', 'pnpm-lock.yaml'],
    });
    expect(first.summary).toBe('2 files (4 not for reading): src/big.ts, src/small.ts');

    writeConfig(fx, { check: { notForReading: ['src/small.ts'] } });
    const replaced = byId((await runReadOnly()).report, 'to-read');
    expect((replaced.details.files as Array<{ path: string }>).map((f) => f.path)).toEqual([
      'src/big.ts',
      'codev/projects/7-feature/status.yaml',
      'codev/state/spir-7_thread.md',
      'packages/x/package-lock.json',
      'pnpm-lock.yaml',
    ]);
    expect(replaced.details.excluded).toEqual(['src/small.ts']);
  });

  it('Scenario 12: a local branch ahead of the PR head needs attention (not pushed)', async () => {
    const { dir, head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'pushed' }]);
    const local = fx.commit(dir, { 'b.txt': 'b\n' }, 'not pushed');
    answerPrView(prView(head));

    const { report, exitCode } = await runReadOnly();

    expect(exitCode).toBe(1);
    expect(byId(report, 'head')).toMatchObject({
      status: 'attention',
      summary: `local ${PR_BRANCH} is 1 commit ahead of the PR head (not pushed)`,
      details: { forgeHead: head, localBranchSha: local, aheadOfPr: 1, relation: 'ahead' },
    });
    expect(report.pr.localBranch).toEqual({ name: PR_BRANCH, sha: local });
    const human = renderPrHuman(report);
    expect(human.split('\n')[0]).toBe('ATTENTION  PR #7 — head (not pushed)');
    expect(human).toMatch(/\n {2}ATTN +head +local builder\/spir-7 is 1 commit ahead/);
  });

  it('a local branch behind the PR head is fine; a diverged one needs attention', async () => {
    const { dir, head: first } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'first' }]);
    const head = fx.commit(dir, { 'b.txt': 'b\n' }, 'second');
    fx.git(dir, 'push', '-q', 'origin', PR_BRANCH);
    fx.git(dir, 'reset', '-q', '--hard', first);
    answerPrView(prView(head));
    expect(byId((await runReadOnly()).report, 'head')).toMatchObject({ status: 'ok', details: { relation: 'behind', behindPr: 1 } });

    fx.commit(dir, { 'c.txt': 'c\n' }, 'local only');
    expect(byId((await runReadOnly()).report, 'head')).toMatchObject({ status: 'attention', details: { relation: 'diverged', aheadOfPr: 1, behindPr: 1 } });
  });

  it("a fork's PR is not compared with an unrelated local branch of the same name", async () => {
    // A fork's PR from its own `main`: the head is reachable on origin only through
    // refs/pull/7/head, as GitHub keeps it, and our local main has moved on since.
    const other = otherClone(fx);
    fx.git(other, 'fetch', '-q', 'origin');
    fx.git(other, 'checkout', '-q', '-B', 'fork-main', 'origin/main');
    const head = fx.commit(other, { 'src/fork.ts': 'f\n' }, 'fork work');
    fx.git(other, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    fx.commit(fx.main, { 'later.txt': 'later\n' }, 'main moves on');
    fx.git(fx.main, 'push', '-q', 'origin', 'main');
    const originMain = fx.git(fx.main, 'rev-parse', 'main').trim();
    answerPrView(prView(head, { headRefName: 'main' }));

    const { report } = await runReadOnly();

    expect(byId(report, 'head')).toMatchObject({
      status: 'info',
      summary: `origin's main is at ${originMain.slice(0, 7)}, not the PR head (a fork's PR, or the branch moved): local main not compared`,
      details: { relation: 'not-origin-branch', originBranchSha: originMain },
    });
    expect(byId(report, 'trial-merge').status).toBe('ok');
    expect(report.verdict).toBe('clear');
  });

  it('Scenario 25: pr-view without headRefOid is exit 2 naming the concept and the field', async () => {
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    const view = prView(head);
    delete view.headRefOid;
    answerPrView(view);

    const result = await run();

    expect(result.exitCode).toBe(2);
    expect((result.report as ErrorReport).error.message).toBe('could not read PR #7: pr-view did not return headRefOid (provider github)');
  });

  it('a PR the forge cannot read is exit 2 naming the concept', async () => {
    const result = await run({}, '8');
    expect(result.exitCode).toBe(2);
    expect((result.report as ErrorReport).error.message).toMatch(/^could not read PR #8: pr-view failed: stub gh: no answer for: pr view 8 /);
  });

  it('Scenario 27: git older than 2.38 leaves the trial merge not run, naming the version', async () => {
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    answerPrView(prView(head));
    const oldGit: SpawnFn = (command, args, options) =>
      args.length === 1 && args[0] === 'version'
        ? realSpawn(process.execPath, ['-e', 'process.stdout.write("git version 2.37.1\\n")'], options)
        : realSpawn(command, args, options);

    const { report, exitCode } = await runReadOnly({ spawn: oldGit });

    expect(exitCode).toBe(1);
    expect(byId(report, 'trial-merge')).toMatchObject({ status: 'not-run', reason: 'requires git 2.38+ (found 2.37.1)' });
    expect(stub.gitCalls().some((c) => c.startsWith('merge-tree'))).toBe(false);
  });

  it('Scenario 22: a write is refused by the runner, and a write in a concept is caught by the stub', async () => {
    const runner = createRunner({ cwd: fx.main, workspaceRoot: fx.main, env: { ...fx.env, ...stub.env } });
    await expect(runner.git(['update-ref', 'refs/heads/x', 'a'.repeat(40)])).rejects.toThrow(RunnerRefusal);
    await expect(runner.forge('pr-merge')).rejects.toThrow(RunnerRefusal);
    expect(stub.gitCalls().some((c) => c.startsWith('update-ref'))).toBe(false);

    // A project override is trusted by the runner; in tests the stub still sees what it runs.
    writeConfig(fx, { forge: { 'pr-view': 'gh pr merge "$CODEV_PR_NUMBER"; gh api -X POST repos/o/r/merges' } });
    const result = await run();
    expect(result.exitCode).toBe(2);
    expect(stub.violations()).toEqual(['gh pr merge 7 :: pr merge', 'gh api -X POST repos/o/r/merges :: api write flag -X']);
  });
});
