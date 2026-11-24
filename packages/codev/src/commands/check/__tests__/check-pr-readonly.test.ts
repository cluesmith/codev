/**
 * Spec 1951 — `codev check pr` against real repositories, on every platform.
 *
 * The forge comes from a `pr-view` concept override (a `.sh` script Git Bash runs on
 * Windows), so neither `gh` nor a network is needed. These tests prove that no ref, `HEAD`,
 * index byte, `FETCH_HEAD` or status line changes (Scenario 23), that a head or base moving
 * during the run is caught (Scenario 11), that a hanging anchor read is exit 2 (Scenario
 * 12b), and that the command reports the same from a builder worktree as from the main
 * checkout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkPr } from '../pr.js';
import type { Check, CommandOptions, ErrorReport, PrReport } from '../report.js';
import type { SpawnFn } from '../runner.js';
import { useFakeHome } from './helpers/fake-home.js';
import { createFixture, snapshotRepoState, type Fixture } from './helpers/git-fixture.js';
import {
  otherClone,
  PR_BRANCH,
  prView,
  prViewOverride,
  pushBranch,
  pushFromElsewhere,
  shPath,
  writeConfig,
  type PrViewOverride,
} from './helpers/pr-fixture.js';

useFakeHome();

let fx: Fixture;
let forge: PrViewOverride;

beforeEach(() => {
  fx = createFixture();
  forge = prViewOverride(fx);
});

afterEach(() => {
  fx.cleanup();
});

function configure(check: Record<string, unknown> = {}): string {
  return writeConfig(fx, { forge: { 'pr-view': forge.script }, check });
}

async function run(extra: Partial<CommandOptions> = {}, number = '7') {
  return checkPr(number, { cwd: fx.main, env: fx.env, timeoutMs: 20_000, ...extra });
}

async function runReport(extra: Partial<CommandOptions> = {}): Promise<PrReport> {
  const result = await run(extra);
  if ('error' in result.report) throw new Error(`unexpected exit 2: ${result.report.error.message}`);
  return result.report;
}

function byId(report: PrReport, id: string): Check {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check`);
  return found;
}

function withoutTime(report: PrReport): Omit<PrReport, 'generatedAt'> {
  const { generatedAt: _ignored, ...rest } = report;
  return rest;
}

interface SnapshotCase {
  name: string;
  /** Build the PR; returns its head. */
  setup: () => string;
  trialMerge: 'ok' | 'attention';
}

const SNAPSHOT_CASES: SnapshotCase[] = [
  {
    name: 'a clean run',
    setup: () => pushBranch(fx, [{ files: { 'src/a.ts': 'a\n' }, message: 'a' }]).head,
    trialMerge: 'ok',
  },
  {
    name: 'a conflicting trial merge',
    setup: () => {
      const { head } = pushBranch(fx, [{ files: { 'README.md': 'ours\n' }, message: 'ours' }]);
      fx.commit(fx.main, { 'README.md': 'theirs\n' }, 'theirs');
      fx.git(fx.main, 'push', '-q', 'origin', 'main');
      return head;
    },
    trialMerge: 'attention',
  },
  {
    name: 'a stale local origin/main',
    setup: () => {
      const { head } = pushBranch(fx, [{ files: { 'README.md': 'ours\n' }, message: 'ours' }]);
      pushFromElsewhere(fx, 'main', { 'README.md': 'theirs\n' });
      return head;
    },
    trialMerge: 'attention',
  },
  {
    name: 'a head that must be fetched',
    setup: () => pushFromElsewhere(fx, PR_BRANCH, { 'src/remote.ts': 'r\n' }),
    trialMerge: 'ok',
  },
];

// Each case builds real repositories and runs the command at least once.
describe('Spec 1951 — check pr on real repositories', { timeout: 30_000 }, () => {
  it.each(SNAPSHOT_CASES)('Scenario 23: $name leaves refs, HEAD, index, FETCH_HEAD and status unchanged', async (c) => {
    const head = c.setup();
    forge.answer(prView(head));
    configure();
    const before = snapshotRepoState(fx, fx.main);

    const report = await runReport();

    expect(snapshotRepoState(fx, fx.main)).toEqual(before);
    expect(report.pr.head).toBe(head);
    expect(byId(report, 'trial-merge').status).toBe(c.trialMerge);
    expect(fx.git(fx.main, 'cat-file', '-t', head).trim()).toBe('commit');
  });

  it('a linked worktree is left unchanged too', async () => {
    const { dir, head } = pushBranch(fx, [{ files: { 'README.md': 'ours\n' }, message: 'ours' }]);
    pushFromElsewhere(fx, 'main', { 'README.md': 'theirs\n' });
    forge.answer(prView(head));
    configure();
    const before = snapshotRepoState(fx, dir);

    await runReport({ cwd: dir });

    expect(snapshotRepoState(fx, dir)).toEqual(before);
  });

  it('reports the same from a builder worktree as from the main checkout, with the main checkout’s config', async () => {
    const { dir, head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a\n\nCo-Authored-By: Bot <b@example.invalid>' }]);
    forge.answer(prView(head));
    configure({ attribution: ['^Co-Authored-By:'] });

    const fromMain = await runReport();
    const fromWorktree = await runReport({ cwd: dir });
    const fromSubdirectory = await runReport({ cwd: path.join(fx.main, '.codev') });

    expect(byId(fromMain, 'attribution').status).toBe('attention');
    expect(withoutTime(fromWorktree)).toEqual(withoutTime(fromMain));
    expect(withoutTime(fromSubdirectory)).toEqual(withoutTime(fromMain));
  });

  it('Scenario 11: a head that moves during the run needs attention, naming both SHAs', async () => {
    const { dir, head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    const next = fx.commit(dir, { 'b.txt': 'b\n' }, 'b');
    forge.answer(prView(head));
    forge.answerOn(2, prView(next));
    configure();

    const report = await runReport();

    expect(forge.calls()).toBe(2);
    expect(report.verdict).toBe('attention');
    const headCheck = byId(report, 'head');
    expect(headCheck.status).toBe('attention');
    expect(headCheck.details.movedTo).toBe(next);
    expect(headCheck.summary.split('\n')).toContain(`head moved during check (${head.slice(0, 7)} → ${next.slice(0, 7)}); re-run`);
  });

  it('Scenario 11: a base that moves during the run needs attention on the trial merge', async () => {
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    const before = fx.git(fx.main, 'rev-parse', 'main').trim();
    const other = otherClone(fx);
    fx.git(other, 'checkout', '-q', '-B', 'main', 'origin/main');
    const later = fx.commit(other, { 'later.txt': 'later\n' }, 'later on main');
    forge.answer(prView(head));
    // The re-read of pr-view comes before the re-read of the base, so a push here moves it.
    forge.runOn(2, `git -C '${shPath(other)}' push -q origin main`);
    configure();

    const report = await runReport();

    const merge = byId(report, 'trial-merge');
    expect(merge.status).toBe('attention');
    expect(merge.details).toMatchObject({ baseTip: before, movedTo: later });
    expect(merge.summary.split('\n')).toEqual([
      `clean into main @ ${before.slice(0, 7)}`,
      `base moved during check (${before.slice(0, 7)} → ${later.slice(0, 7)}); re-run`,
    ]);
  });

  it('a head that cannot be re-read at the end is not reported as confirmed', async () => {
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    forge.answer(prView(head));
    forge.answerOn(2, 'not json');
    configure();

    const report = await runReport();

    expect(byId(report, 'head')).toMatchObject({ status: 'attention', details: { recheck: 'pr-view returned invalid output' } });
    expect(report.verdict).toBe('attention');
  });

  it('Scenario 12b: a hanging anchoring pr-view is exit 2 within the time limit', async () => {
    const hang = path.join(fx.root, 'forge', 'hang.sh');
    fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 10\n', { mode: 0o755 });
    writeConfig(fx, { forge: { 'pr-view': hang } });
    const started = Date.now();

    const result = await run({ timeoutMs: 500 });

    expect(result.exitCode).toBe(2);
    expect((result.report as ErrorReport).error.message).toMatch(/^could not read PR #7: pr-view timed out after 500ms \(provider github, override in /);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it('Scenario 25: an override without headRefOid is exit 2 naming the concept, the field and the file', async () => {
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    const view = prView(head);
    delete view.headRefOid;
    forge.answer(view);
    const file = configure();

    const result = await run();

    expect(result).toEqual({
      exitCode: 2,
      report: {
        schema: 1,
        command: 'pr',
        error: { message: `could not read PR #7: pr-view did not return headRefOid (provider github, override in ${file})` },
      },
    });
  });

  it('a headRefOid that is not a full SHA is exit 2', async () => {
    forge.answer(prView('abc1234'));
    configure();
    const result = await run();
    expect(result.exitCode).toBe(2);
    expect((result.report as ErrorReport).error.message).toContain('pr-view returned headRefOid "abc1234", not a full commit SHA');
  });

  it('check.skip replaces a check by name; a base that moves still shows on a skipped trial merge', async () => {
    const { head } = pushBranch(fx, [{ files: { 'a.txt': 'a\n' }, message: 'a' }]);
    const other = otherClone(fx);
    fx.git(other, 'checkout', '-q', '-B', 'main', 'origin/main');
    fx.commit(other, { 'later.txt': 'later\n' }, 'later');
    forge.answer(prView(head));
    configure({ skip: ['size', 'trial-merge'] });

    const quiet = await runReport();
    expect(byId(quiet, 'size')).toMatchObject({ status: 'skip', summary: 'skipped (check.skip)' });
    expect(byId(quiet, 'trial-merge').status).toBe('skip');
    expect(quiet.verdict).toBe('clear');

    forge.runOn(forge.calls() + 2, `git -C '${shPath(other)}' push -q origin main`);
    const moved = await runReport();
    expect(byId(moved, 'trial-merge')).toMatchObject({ status: 'attention', summary: expect.stringMatching(/^base moved during check/) });
  });

  it('Scenario 28a: an invalid PR number is exit 2 before any subprocess starts', async () => {
    const spawn = vi.fn<SpawnFn>();
    for (const bad of ['12a', '0', '-1', '7.5', '']) {
      const result = await checkPr(bad, { cwd: fx.main, spawn });
      expect(result.exitCode, bad).toBe(2);
      expect((result.report as ErrorReport).error.message, bad).toMatch(/^invalid PR number/);
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('outside a git repository is exit 2', async () => {
    const plain = path.join(fx.root, 'plain');
    fs.mkdirSync(plain);
    const result = await checkPr('7', { cwd: plain, env: { ...fx.env, GIT_CEILING_DIRECTORIES: fx.root } });
    expect(result.exitCode).toBe(2);
    expect((result.report as ErrorReport).error.message).toBe('not in a git repository');
  });
});
