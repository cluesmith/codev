/**
 * Spec 1951 — `codev check worktree` (Scenarios 16–21, 20a) against real worktrees made with
 * `git worktree add`, on every platform.
 *
 * The forge comes from `pr-search` and `pr-view` concept overrides (`.sh` scripts Git Bash
 * runs on Windows). Every run compares the main checkout and the inspected worktree before
 * and after: refs, HEAD, both index files, FETCH_HEAD and status (Scenario 23). The
 * stub-PATH audit of every git call is in check-worktree-stubs.test.ts (POSIX).
 */

import { spawn as realSpawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnLinkTarget } from '../../../agent-farm/lib/builder-scaffold.js';
import { listKeepCandidates } from '../../../agent-farm/lib/keep-files.js';
import { DEFAULT_KEEP_IGNORED } from '../../../agent-farm/lib/keep-list.js';
import type { Check, CommandOptions, ErrorReport, Status, WorktreeReport } from '../report.js';
import type { SpawnFn } from '../runner.js';
import { checkWorktree, parseStatus, pickPr, removability, renderWorktreeHuman } from '../worktree.js';
import { useFakeHome } from './helpers/fake-home.js';
import { createFixture, linkedSpelling, snapshotRepoState, type Fixture } from './helpers/git-fixture.js';
import { prViewOverride, writeConfig, type PrViewOverride } from './helpers/pr-fixture.js';
import { expectWorktreeReportShape } from './helpers/report-shape.js';
import {
  addBuilder,
  builderView,
  deleteRemoteBranch,
  mergeBuilder,
  prSearchOverride,
  SCAFFOLD_FILES,
  squashBuilder,
  writeFiles,
  type Builder,
  type PrSearchOverride,
} from './helpers/worktree-fixture.js';

const s = (sha: string): string => sha.slice(0, 7);
const isWindows = process.platform === 'win32';

describe('Spec 1951 — check worktree: parsers and the verdict rule', () => {
  it('parseStatus: change words, a rename with its source, and conflicts', () => {
    const output = [' M a.txt', '?? b.txt', 'R  new.txt', 'old.txt', 'UU c.txt', 'A  d.txt', ' D e.txt', ''].join('\0');
    expect(parseStatus(output)).toEqual([
      { path: 'a.txt', change: 'modified' },
      { path: 'b.txt', change: 'untracked' },
      { path: 'new.txt', change: 'renamed' },
      { path: 'c.txt', change: 'conflicted' },
      { path: 'd.txt', change: 'added' },
      { path: 'e.txt', change: 'deleted' },
    ]);
    expect(parseStatus('')).toEqual([]);
    expect(() => parseStatus('garbage\0')).toThrow('unexpected git status output');
  });

  it('pickPr: exact head branch only; OPEN, then the newest MERGED, then CLOSED, then a blank state', () => {
    const branch = 'builder/spir-8';
    const item = (number: number, state?: string, headRefName = branch) => ({ number, headRefName, ...(state === undefined ? {} : { state }) });
    expect(pickPr([item(3, 'MERGED'), item(9, 'OPEN'), item(5, 'CLOSED')], branch)).toEqual({ ok: true, value: 9 });
    expect(pickPr([item(3, 'MERGED'), item(7, 'MERGED'), item(9, 'CLOSED')], branch)).toEqual({ ok: true, value: 7 });
    expect(pickPr([item(9), item(4, 'closed')], branch)).toEqual({ ok: true, value: 4 });
    expect(pickPr([item(80, 'OPEN', 'builder/spir-80')], branch)).toEqual({ ok: true, value: null });
    expect(pickPr([], branch)).toEqual({ ok: true, value: null });
    expect(pickPr({}, branch)).toEqual({ ok: false, reason: 'pr-search returned something other than a JSON array' });
    expect(pickPr([{ number: '8', headRefName: branch }], branch)).toEqual({ ok: false, reason: 'pr-search item 1 has no valid number' });
  });

  it('removability: data only; a data check that could not run is conservative', () => {
    const c = (id: string, status: Status): Check => ({ id, status, summary: '', details: {} });
    const all = (u: Status, k: Status, i: Status, p: Status = 'ok') => [c('uncommitted', u), c('commits', k), c('remote', 'info'), c('pr', p), c('ignored', i)];
    expect(removability(all('ok', 'ok', 'ok', 'attention'), false)).toBe('removable');
    expect(removability(all('ok', 'ok', 'attention'), false)).toBe('removable-after-keeping');
    expect(removability(all('attention', 'ok', 'attention'), false)).toBe('not-removable');
    expect(removability(all('not-run', 'ok', 'ok'), false)).toBe('not-removable');
    expect(removability(all('ok', 'attention', 'ok'), true)).toBe('not-removable');
    expect(removability(all('ok', 'not-run', 'ok'), false)).toBe('not-removable');
    expect(removability(all('ok', 'not-run', 'ok'), true)).toBe('removable');
    expect(removability(all('ok', 'ok', 'not-run'), false)).toBe('not-removable');
    expect(removability(all('skip', 'skip', 'skip'), false)).toBe('removable');
    // Keep-list symlinks are data cleanup cannot keep: with or without keep files, they block removal.
    const withLinks = (keep: string[]) => [...all('ok', 'ok', 'attention').slice(0, 4), { ...c('ignored', 'attention'), details: { keep, regenerable: 0, links: [{ path: 'tmp/link', target: '/x', missing: false }], scaffold: [] } }];
    expect(removability(withLinks([]), false)).toBe('not-removable');
    expect(removability(withLinks(['tmp/notes.md']), false)).toBe('not-removable');
  });
});

useFakeHome();

let fx: Fixture;
let view: PrViewOverride;
let search: PrSearchOverride;

beforeEach(() => {
  fx = createFixture();
  view = prViewOverride(fx);
  search = prSearchOverride(fx);
});

afterEach(() => {
  fx.cleanup();
});

function configure(extra: { forge?: Record<string, unknown>; check?: Record<string, unknown>; cleanup?: Record<string, unknown> } = {}): string {
  return writeConfig(fx, {
    forge: { 'pr-view': view.script, 'pr-search': search.script, ...extra.forge },
    ...(extra.check ? { check: extra.check } : {}),
    ...(extra.cleanup ? { cleanup: extra.cleanup } : {}),
  });
}

/** The builder's PR as the forge reports it: found by `pr-search`, read by `pr-view`. */
function prIs(builder: Builder, number: number, state: 'OPEN' | 'MERGED' | 'CLOSED', head = builder.head, overrides: Record<string, unknown> = {}): void {
  search.answer([{ number, headRefName: builder.branch, baseRefName: 'main', state }]);
  view.answerFor(number, builderView(builder, state, head, overrides));
}

async function runReport(target: string, extra: Partial<CommandOptions> & { inspected?: string } = {}): Promise<{ report: WorktreeReport; exitCode: number }> {
  const { inspected, ...options } = extra;
  const watched = [fx.main, ...(inspected ? [inspected] : [])];
  const before = watched.map((dir) => snapshotRepoState(fx, dir));
  const result = await checkWorktree(target, { cwd: fx.main, env: fx.env, timeoutMs: 20_000, ...options });
  if ('error' in result.report) throw new Error(`unexpected exit 2: ${result.report.error.message}`);
  expect(watched.map((dir) => snapshotRepoState(fx, dir))).toEqual(before);
  expectWorktreeReportShape(result.report);
  return { report: result.report, exitCode: result.exitCode };
}

function byId(report: WorktreeReport, id: string): Check {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no ${id} check`);
  return found;
}

function withoutTime(report: WorktreeReport): Omit<WorktreeReport, 'generatedAt'> {
  const { generatedAt: _ignored, ...rest } = report;
  return rest;
}

const SCAFFOLD_SORTED = [...SCAFFOLD_FILES].sort();

// Each case builds real repositories and worktrees.
describe('Spec 1951 — check worktree on real worktrees', { timeout: 30_000 }, () => {
  it('Scenario 16: clean, merged with a merge commit, remote branch deleted: REMOVABLE, exit 0, laid out as the spec sample', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    mergeBuilder(fx, b);
    deleteRemoteBranch(fx, b.branch);
    prIs(b, 8, 'MERGED');
    const main = fx.git(fx.main, 'rev-parse', 'HEAD').trim();

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(0);
    expect(report).toMatchObject({
      verdict: 'clear',
      removable: 'removable',
      worktree: { path: fs.realpathSync.native(b.dir), builderId: 'spir-8', branch: b.branch, baseRef: 'main', baseTip: main },
    });
    expect(byId(report, 'uncommitted')).toMatchObject({ status: 'ok', details: { files: [], scaffold: SCAFFOLD_SORTED } });
    expect(byId(report, 'commits')).toMatchObject({ status: 'ok', details: { total: 0, notOnBase: [], unsafe: [] } });
    expect(byId(report, 'remote')).toMatchObject({ status: 'info', details: { remoteSha: null, relation: 'absent' } });
    expect(byId(report, 'pr')).toMatchObject({ status: 'ok', details: { number: 8, state: 'MERGED', mergedHead: b.head } });
    expect(byId(report, 'ignored')).toMatchObject({ status: 'ok', details: { keep: [], regenerable: 0 } });
    expect(search.calls()).toEqual([`head:${b.branch}`]);

    expect(renderWorktreeHuman(report)).toBe(
      [
        'REMOVABLE  spir-8',
        '',
        `worktree  .builders/spir-8   branch builder/spir-8   base main @ ${s(main)} (origin, live)`,
        '  ok      uncommitted   nothing uncommitted   [5 scaffold files not counted]',
        '  ok      commits       every commit is on origin/main',
        '  info    remote        origin has no branch builder/spir-8',
        '  ok      pr            #8 MERGED',
        '  ok      ignored       no keep-list files; no other ignored files',
        '',
      ].join('\n'),
    );
  });

  it('Scenario 17: a modified thread file is NOT REMOVABLE; scaffold files are counted apart', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'OPEN');
    fs.appendFileSync(path.join(b.dir, 'codev/state/spir-8_thread.md'), 'more\n');

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(1);
    expect(report.removable).toBe('not-removable');
    expect(byId(report, 'uncommitted')).toMatchObject({
      status: 'attention',
      summary: '1 file: codev/state/spir-8_thread.md (modified)   [5 scaffold files not counted]',
      details: { files: [{ path: 'codev/state/spir-8_thread.md', change: 'modified' }], scaffold: SCAFFOLD_SORTED },
    });
    expect(renderWorktreeHuman(report).split('\n')[0]).toBe('NOT REMOVABLE  spir-8 — 1 uncommitted file, PR #8 open: builder not finished');
  });

  it('Scenario 17: only scaffold files untracked, write guard included: nothing uncommitted', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'OPEN');

    const { report } = await runReport('spir-8', { inspected: b.dir });

    expect(byId(report, 'uncommitted')).toMatchObject({ status: 'ok', details: { files: [], scaffold: SCAFFOLD_SORTED } });
    expect(report.removable).toBe('removable');
  });

  it('Scenario 17: a staged file and an untracked one outside the scaffold are data', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'OPEN');
    writeFiles(b.dir, { 'src/new.ts': 'x\n', 'notes.md': 'n\n', '.claude/other.json': '{}\n' });
    fx.git(b.dir, 'add', 'src/new.ts');

    const { report } = await runReport('spir-8', { inspected: b.dir });

    expect(byId(report, 'uncommitted').details.files).toEqual([
      { path: '.claude/other.json', change: 'untracked' },
      { path: 'notes.md', change: 'untracked' },
      { path: 'src/new.ts', change: 'added' },
    ]);
    expect(report.removable).toBe('not-removable');
  });

  it('Scenario 18: an unpushed commit not on the base is NOT REMOVABLE', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'OPEN');
    const unpushed = fx.commit(b.dir, { 'src/late.ts': 'late\n' }, 'late work');

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(1);
    expect(report.removable).toBe('not-removable');
    expect(byId(report, 'commits')).toMatchObject({
      status: 'attention',
      summary: `1 commit on no remote branch: ${s(unpushed)}`,
      details: { total: 2, notOnBase: [unpushed, b.head], unsafe: [unpushed] },
    });
    expect(byId(report, 'remote')).toMatchObject({
      status: 'info',
      summary: `local ${s(unpushed)} is ahead of origin/builder/spir-8 @ ${s(b.head)} (not pushed)`,
      details: { remoteSha: b.head, relation: 'ahead' },
    });
    expect(renderWorktreeHuman(report).split('\n')[0]).toBe('NOT REMOVABLE  spir-8 — 1 unpushed commit, PR #8 open: builder not finished');
  });

  it('pushed commits not yet on the base are safe: they are on the remote branch', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'OPEN');

    const { report } = await runReport('spir-8', { inspected: b.dir });

    expect(byId(report, 'commits')).toMatchObject({
      status: 'ok',
      summary: '1 commit not on origin/main, all on origin/builder/spir-8',
      details: { total: 1, notOnBase: [b.head], unsafe: [] },
    });
    expect(byId(report, 'remote')).toMatchObject({ status: 'ok', summary: `origin/builder/spir-8 matches local (${s(b.head)})` });
  });

  it('Scenario 19: squash-merged, local tip equal to the merged head: REMOVABLE', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    squashBuilder(fx, b);
    deleteRemoteBranch(fx, b.branch);
    prIs(b, 8, 'MERGED');

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(0);
    expect(report.removable).toBe('removable');
    expect(byId(report, 'commits')).toMatchObject({
      status: 'ok',
      summary: "1 commit not on origin/main; the local tip is PR #8's merged head (squash or rebase merge)",
      details: { total: 1, notOnBase: [b.head], unsafe: [] },
    });
  });

  it('Scenario 19: squash-merged, then one more local commit: NOT REMOVABLE', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    squashBuilder(fx, b);
    deleteRemoteBranch(fx, b.branch);
    prIs(b, 8, 'MERGED');
    const after = fx.commit(b.dir, { 'src/after.ts': 'after\n' }, 'after the merge');

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(1);
    expect(report.removable).toBe('not-removable');
    expect(byId(report, 'commits')).toMatchObject({ status: 'attention', details: { total: 2, unsafe: [after, b.head] } });
  });

  describe('Scenario 20: ignored files', () => {
    beforeEach(() => {
      fx.commit(
        fx.main,
        { '.gitignore': 'node_modules/\n*.log\ntmp/\ncodev/projects/**/*.txt\n', 'codev/projects/8-x/status.yaml': 'phase: x\n' },
        'ignore build output and porch transcripts',
      );
      fx.git(fx.main, 'push', '-q', 'origin', 'main');
    });

    function withIgnored(): Builder {
      const b = addBuilder(fx, 'spir-8');
      writeFiles(b.dir, {
        'codev/projects/8-x/8-specify-iter1-codex.txt': 'review\n',
        'tmp/notes.md': 'notes\n',
        'node_modules/pkg/index.js': 'module\n',
        'codev/projects/8-x/node_modules/dep.js': 'dep\n',
        'debug.log': 'log\n',
      });
      mergeBuilder(fx, b);
      deleteRemoteBranch(fx, b.branch);
      prIs(b, 8, 'MERGED');
      return b;
    }

    it('keep-list files make it REMOVABLE AFTER KEEPING N FILES; never-copy paths count as regenerable', async () => {
      configure();
      const b = withIgnored();

      const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

      expect(exitCode).toBe(1);
      expect(report.removable).toBe('removable-after-keeping');
      expect(byId(report, 'ignored')).toMatchObject({
        status: 'attention',
        details: { keep: ['codev/projects/8-x/8-specify-iter1-codex.txt', 'tmp/notes.md'], regenerable: 3 },
      });
      const human = renderWorktreeHuman(report);
      expect(human.split('\n')[0]).toBe('REMOVABLE AFTER KEEPING 2 FILES  spir-8');
      expect(human).toContain(
        [
          '  ATTN    ignored       2 keep-list files would be lost: codev/projects/8-x/8-specify-iter1-codex.txt, tmp/notes.md',
          '                        (3 other ignored paths treated as regenerable: codev/projects/8-x/node_modules/, … +2)',
          '                        → copy them out first, or use `afx cleanup --keep-ignored`',
        ].join('\n'),
      );
    });

    it('agrees with afx cleanup --keep-ignored: the keep files are the ignored part of what it would keep', async () => {
      configure();
      const b = withIgnored();
      const saved = { ...process.env };
      Object.assign(process.env, fx.env);
      let cleanupKeeps: string[];
      try {
        const kept = listKeepCandidates(b.dir, DEFAULT_KEEP_IGNORED).files;
        const untracked = listKeepCandidates(b.dir, []).files;
        cleanupKeeps = kept.filter((f) => !untracked.includes(f));
      } finally {
        for (const key of Object.keys(fx.env)) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }

      const { report } = await runReport('spir-8', { inspected: b.dir });

      expect(byId(report, 'ignored').details.keep).toEqual(cleanupKeeps);
      expect(cleanupKeeps).toEqual(['codev/projects/8-x/8-specify-iter1-codex.txt', 'tmp/notes.md']);
    });

    // keepFiles() skips every symlink it is handed ("Not kept (symlinks)"), so check worktree
    // must not count one as a file cleanup would keep; a link is still data, which nothing but
    // copying it out keeps. Symlinks need privileges on Windows.
    it.skipIf(isWindows)('a keep-list symlink is listed apart, with its target; one to a kept file is judged as that file', async () => {
      configure();
      const b = withIgnored();
      fs.symlinkSync('notes.md', path.join(b.dir, 'tmp/link.md'));
      fs.symlinkSync(path.join(fx.root, 'outside-secret'), path.join(b.dir, 'tmp/env'));
      const saved = { ...process.env };
      Object.assign(process.env, fx.env);
      let candidates: string[];
      try {
        const untracked = listKeepCandidates(b.dir, []).files;
        candidates = listKeepCandidates(b.dir, DEFAULT_KEEP_IGNORED).files.filter((f) => !untracked.includes(f));
      } finally {
        for (const key of Object.keys(fx.env)) {
          if (saved[key] === undefined) delete process.env[key];
          else process.env[key] = saved[key];
        }
      }
      const isLink = (f: string): boolean => fs.lstatSync(path.join(b.dir, f)).isSymbolicLink();

      const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

      const ignored = byId(report, 'ignored');
      // The keep files are what keepFiles() copies; tmp/link.md points at tmp/notes.md, which is kept.
      expect(candidates.filter(isLink)).toEqual(['tmp/env', 'tmp/link.md']);
      expect(ignored.details).toEqual({
        keep: candidates.filter((f) => !isLink(f)),
        regenerable: 3,
        links: [{ path: 'tmp/env', target: path.join(fx.root, 'outside-secret'), missing: true }],
        scaffold: [],
      });
      expect(exitCode).toBe(1);
      expect(report.removable).toBe('not-removable');
      expect(ignored.status).toBe('attention');
      expect(ignored.summary).toContain(`1 keep-list symlink would be lost: tmp/env -> ${path.join(fx.root, 'outside-secret')} (target missing)`);
      expect(ignored.summary).toContain('→ copy the symlinks out first (`afx cleanup --keep-ignored` keeps the files, never a link)');
    });

    it.skipIf(isWindows)('keep-list symlinks alone: NOT REMOVABLE, and the hint does not offer --keep-ignored', async () => {
      configure({ cleanup: { keepIgnored: ['tmp/**'] } });
      const b = addBuilder(fx, 'spir-8');
      fs.mkdirSync(path.join(fx.root, 'elsewhere'));
      fs.mkdirSync(path.join(b.dir, 'tmp'));
      fs.symlinkSync(path.join(fx.root, 'elsewhere'), path.join(b.dir, 'tmp/link'));
      fs.symlinkSync(path.join(fx.root, 'gone'), path.join(b.dir, 'tmp/gone'));
      mergeBuilder(fx, b);
      prIs(b, 8, 'MERGED');

      const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

      expect(exitCode).toBe(1);
      expect(report.removable).toBe('not-removable');
      expect(byId(report, 'ignored')).toMatchObject({
        status: 'attention',
        details: {
          keep: [],
          links: [
            { path: 'tmp/gone', target: path.join(fx.root, 'gone'), missing: true },
            { path: 'tmp/link', target: path.join(fx.root, 'elsewhere'), missing: false },
          ],
        },
      });
      // One link per line, each with its target, so none is cut off.
      const human = renderWorktreeHuman(report);
      expect(human.split('\n')[0]).toBe('NOT REMOVABLE  spir-8 — 2 keep-list symlinks');
      const lines = byId(report, 'ignored').summary.split('\n');
      expect(lines.slice(0, 3)).toEqual([
        '2 keep-list symlinks would be lost:',
        `  tmp/gone -> ${path.join(fx.root, 'gone')} (target missing)`,
        `  tmp/link -> ${path.join(fx.root, 'elsewhere')}`,
      ]);
      expect(human).toContain('→ copy them out first (`afx cleanup --keep-ignored` never copies a link)');
    });

    // A project that keeps '.env*' must not see every worktree it spawns as NOT REMOVABLE.
    it.skipIf(isWindows)("the links spawn makes are scaffold, never data, ignored or not", async () => {
      configure({ cleanup: { keepIgnored: ['.env*', 'tmp/**'] } });
      fs.mkdirSync(path.join(fx.main, '.git', 'info'), { recursive: true });
      fs.appendFileSync(path.join(fx.main, '.git', 'info', 'exclude'), '.env*\n');
      fs.writeFileSync(path.join(fx.main, '.env'), 'A=1\n');
      fs.writeFileSync(path.join(fx.main, '.env.local'), 'B=2\n');
      const b = addBuilder(fx, 'spir-8');
      // As spawn links them: the built-in .env, a worktree.symlinks file, and a directory entry
      // that git does not ignore and whose source does not exist yet (spawn allows that).
      for (const rel of ['.env', '.env.local', 'shared-data']) fs.symlinkSync(spawnLinkTarget(fx.main, rel), path.join(b.dir, rel));
      mergeBuilder(fx, b);
      prIs(b, 8, 'MERGED');

      const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

      expect(exitCode).toBe(0);
      expect(report.removable).toBe('removable');
      expect(byId(report, 'uncommitted')).toMatchObject({ status: 'ok', details: { files: [], scaffold: [...SCAFFOLD_FILES, 'shared-data'].sort() } });
      expect(byId(report, 'ignored')).toMatchObject({ status: 'ok', details: { keep: [], links: [], scaffold: ['.env', '.env.local'] } });
      expect(byId(report, 'uncommitted').summary).toContain(`[${SCAFFOLD_FILES.length + 1} scaffold files not counted]`);
      expect(byId(report, 'ignored').summary).toContain('[2 scaffold links not counted]');
    });

    // Where a symlink is not allowed, native Windows spawn makes a hard link, else a copy
    // (createWorktreeLink). Both shapes can be made on every platform, so this runs everywhere.
    it("spawn's fallbacks: a hard link of the main checkout's file, or a copy still equal to it, is scaffold; a changed copy is data", async () => {
      configure({ cleanup: { keepIgnored: ['.env*'] } });
      fs.mkdirSync(path.join(fx.main, '.git', 'info'), { recursive: true });
      fs.appendFileSync(path.join(fx.main, '.git', 'info', 'exclude'), '.env*\n');
      for (const [rel, text] of [['.env', 'A=1\n'], ['.env.local', 'B=2\n'], ['.env.test', 'C=3\n'], ['shared.json', '{}\n']]) {
        fs.writeFileSync(path.join(fx.main, rel), text);
      }
      const b = addBuilder(fx, 'spir-8');
      fs.linkSync(path.join(fx.main, '.env'), path.join(b.dir, '.env'));
      fs.copyFileSync(path.join(fx.main, '.env.local'), path.join(b.dir, '.env.local'));
      fs.copyFileSync(path.join(fx.main, 'shared.json'), path.join(b.dir, 'shared.json'));
      // A copy edited since: same size, different bytes.
      fs.writeFileSync(path.join(b.dir, '.env.test'), 'C=4\n');
      mergeBuilder(fx, b);
      prIs(b, 8, 'MERGED');

      const { report } = await runReport('spir-8', { inspected: b.dir });

      expect(report.removable).toBe('removable-after-keeping');
      expect(byId(report, 'uncommitted')).toMatchObject({ status: 'ok', details: { files: [], scaffold: [...SCAFFOLD_FILES, 'shared.json'].sort() } });
      expect(byId(report, 'ignored')).toMatchObject({ status: 'attention', details: { keep: ['.env.test'], links: [], scaffold: ['.env', '.env.local'] } });
    });

    it.skipIf(isWindows)("a link at spawn's path that points anywhere else is not spawn's: it is data", async () => {
      configure({ cleanup: { keepIgnored: ['.env*'] } });
      fs.mkdirSync(path.join(fx.main, '.git', 'info'), { recursive: true });
      fs.appendFileSync(path.join(fx.main, '.git', 'info', 'exclude'), '.env*\n');
      fs.writeFileSync(path.join(fx.root, 'my-env'), 'SECRET=1\n');
      const b = addBuilder(fx, 'spir-8');
      fs.symlinkSync(path.join(fx.root, 'my-env'), path.join(b.dir, '.env'));
      mergeBuilder(fx, b);
      prIs(b, 8, 'MERGED');

      const { report } = await runReport('spir-8', { inspected: b.dir });

      expect(report.removable).toBe('not-removable');
      expect(byId(report, 'ignored')).toMatchObject({
        status: 'attention',
        details: { keep: [], links: [{ path: '.env', target: path.join(fx.root, 'my-env'), missing: false }], scaffold: [] },
      });
    });

    it('cleanup.keepIgnored [] reports no keep files: REMOVABLE', async () => {
      configure({ cleanup: { keepIgnored: [] } });
      const b = withIgnored();

      const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

      expect(exitCode).toBe(0);
      expect(report.removable).toBe('removable');
      expect(byId(report, 'ignored')).toMatchObject({
        status: 'ok',
        summary: 'no keep list (cleanup.keepIgnored is empty); 5 ignored paths treated as regenerable: codev/projects/8-x/8-specify-iter1-codex.txt, … +4',
        details: { keep: [], regenerable: 5 },
      });
    });

    it('a configured keep list replaces the default', async () => {
      configure({ cleanup: { keepIgnored: ['*.log'] } });
      const b = withIgnored();

      const { report } = await runReport('spir-8', { inspected: b.dir });

      expect(byId(report, 'ignored').details).toEqual({ keep: ['debug.log'], regenerable: 4, links: [], scaffold: [] });
    });
  });

  it('Scenario 20a: clean and fully pushed, PR still OPEN: REMOVABLE, pr attention, exit 1', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'OPEN');

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(1);
    expect(report).toMatchObject({ verdict: 'attention', removable: 'removable' });
    expect(byId(report, 'pr')).toMatchObject({ status: 'attention', summary: '#8 OPEN: builder not finished', details: { number: 8, state: 'OPEN' } });
    expect(renderWorktreeHuman(report).split('\n')[0]).toBe('REMOVABLE  spir-8 — PR #8 open: builder not finished');
  });

  it('a PR closed without merging is finished; its pushed commits are on the remote branch', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'CLOSED');

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(0);
    expect(byId(report, 'pr')).toMatchObject({ status: 'ok', summary: '#8 CLOSED without merging' });
  });

  it('no PR for the branch: pr attention, base from origin\'s default branch', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    search.answer([{ number: 80, headRefName: 'builder/spir-80', state: 'OPEN' }]);

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(1);
    expect(byId(report, 'pr')).toMatchObject({ status: 'attention', summary: 'no PR found for builder/spir-8', details: {} });
    expect(report.worktree.baseRef).toBe('main');
    expect(view.calls()).toBe(0);
  });

  it.each([
    ['disabled', () => configure({ forge: { 'pr-search': null } }), 'PR state not available: pr-search unavailable on github'],
    ['failing', () => (configure(), search.fail()), 'PR state not available: pr-search failed: pr-search stub: forge unreachable'],
  ])('pr-search %s: pr not run, and the data verdict still comes from git', async (_name, arrange, reason) => {
    arrange();
    const b = addBuilder(fx, 'spir-8');
    mergeBuilder(fx, b);

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(1);
    expect(report.removable).toBe('removable');
    expect(byId(report, 'pr')).toMatchObject({ status: 'not-run', reason });
    expect(byId(report, 'commits').status).toBe('ok');
    expect(report.worktree.baseRef).toBe('main');
  });

  it('pr-view failing for the PR found: pr not run, naming the PR', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    search.answer([{ number: 8, headRefName: b.branch, state: 'OPEN' }]);
    view.failFor(8, 'HTTP 502');

    const { report } = await runReport('spir-8', { inspected: b.dir });

    expect(byId(report, 'pr')).toMatchObject({ status: 'not-run', reason: 'PR state not available: pr-view failed: HTTP 502', details: { number: 8 } });
  });

  it('a base origin does not have: commits not run; removable only because the local tip is on the remote branch', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'OPEN', b.head, { baseRefName: 'release' });

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(1);
    expect(byId(report, 'commits')).toMatchObject({ status: 'not-run', reason: 'base not read: origin has no branch release' });
    expect(report.removable).toBe('removable');
    expect(report.worktree).toMatchObject({ baseRef: 'release', baseTip: null });
    expect(renderWorktreeHuman(report)).toContain('base release (live tip not read)');

    fx.commit(b.dir, { 'src/late.ts': 'late\n' }, 'late');
    const { report: later } = await runReport('spir-8', { inspected: b.dir });
    expect(later.removable).toBe('not-removable');
  });

  it('check.skip ["pr", "ignored"]: both skip by name, the forge is never asked, the base is origin\'s default', async () => {
    // A skipped check reads nothing of its own: an invalid keep list does not fail the run.
    configure({ check: { skip: ['pr', 'ignored'] }, cleanup: { keepIgnored: 'not a list' } });
    const b = addBuilder(fx, 'spir-8');

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir });

    expect(exitCode).toBe(0);
    expect(byId(report, 'pr')).toMatchObject({ status: 'skip', reason: 'check.skip' });
    expect(byId(report, 'ignored')).toMatchObject({ status: 'skip', reason: 'check.skip' });
    expect(search.calls()).toEqual([]);
    expect(view.calls()).toBe(0);
    expect(report.worktree.baseRef).toBe('main');
  });

  it('check.skip ["commits"]: the base tip is never read, and the header says only the base', async () => {
    configure({ check: { skip: ['commits'] } });
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'OPEN');

    const { report } = await runReport('spir-8', { inspected: b.dir });

    expect(report.worktree).toMatchObject({ baseRef: 'main', baseTip: null });
    expect(renderWorktreeHuman(report).split('\n')[2]).toBe('worktree  .builders/spir-8   branch builder/spir-8   base main');
  });

  it('a remote branch that cannot be read: commits not on the base are not run, never called unpushed', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    prIs(b, 8, 'OPEN');
    const failBranchRead: SpawnFn = (command, args, options) =>
      args.includes('ls-remote') && args.includes(`refs/heads/${b.branch}`)
        ? realSpawn(process.execPath, ['-e', 'process.stderr.write("fatal: simulated failure\\n"); process.exit(128)'], options)
        : realSpawn(command, args, options);

    const { report, exitCode } = await runReport('spir-8', { inspected: b.dir, spawn: failBranchRead });

    expect(exitCode).toBe(1);
    expect(byId(report, 'commits')).toMatchObject({
      status: 'not-run',
      reason: '1 commit not on origin/main, and origin/builder/spir-8 could not be read to check them: ls-remote failed: fatal: simulated failure',
      details: { total: 1, notOnBase: [b.head] },
    });
    expect(byId(report, 'remote')).toMatchObject({ status: 'not-run', reason: 'ls-remote failed: fatal: simulated failure' });
    expect(report.removable).toBe('not-removable');
    expect(renderWorktreeHuman(report).split('\n')[0]).toBe('NOT REMOVABLE  spir-8 — commits not run, remote not run, PR #8 open: builder not finished');
  });

  it('run from inside another builder worktree, or given as a path, it resolves the same target', async () => {
    configure();
    const b = addBuilder(fx, 'spir-8');
    const other = addBuilder(fx, 'spir-9');
    prIs(b, 8, 'OPEN');

    const fromMain = await runReport('spir-8', { inspected: b.dir });
    const fromOther = await runReport('spir-8', { cwd: other.dir, inspected: b.dir });
    const byRelative = await runReport(path.join('.builders', 'spir-8'), { inspected: b.dir });
    const byAbsolute = await runReport(b.dir, { cwd: other.dir, inspected: b.dir });
    const fromItself = await runReport('.', { cwd: b.dir, inspected: b.dir });

    for (const r of [fromOther, byRelative, byAbsolute, fromItself]) expect(withoutTime(r.report)).toEqual(withoutTime(fromMain.report));
  });

  // Every comparison of two spellings of one directory goes through real paths: the target
  // lookup (resolveTarget), "is it under .builders", "is it the main checkout", and spawn's
  // link shape (isSpawnMade). A user whose directory is spelled differently from git's sees
  // the same verdicts.
  it('reached through a symlinked parent directory, every way of naming the builder gives the same report as the real path', async () => {
    configure({ cleanup: { keepIgnored: ['.env*'] } });
    fs.mkdirSync(path.join(fx.main, '.git', 'info'), { recursive: true });
    fs.appendFileSync(path.join(fx.main, '.git', 'info', 'exclude'), '.env*\n');
    fs.writeFileSync(path.join(fx.main, '.env'), 'A=1\n');
    const link = linkedSpelling(fx);
    try {
      const b = addBuilder(fx, 'spir-8');
      const via = link.via;
      expect(via(b.dir)).not.toBe(b.dir);
      expect(fs.realpathSync.native(via(b.dir))).toBe(b.dir);
      // Spawn links `.env` to the main checkout as its workspace root spells it: here, through the link.
      if (isWindows) fs.linkSync(path.join(fx.main, '.env'), path.join(b.dir, '.env'));
      else fs.symlinkSync(via(spawnLinkTarget(fx.main, '.env')), path.join(b.dir, '.env'));
      mergeBuilder(fx, b);
      prIs(b, 8, 'MERGED');

      const real = await runReport('spir-8', { inspected: b.dir });
      const reports = [
        await runReport('spir-8', { cwd: via(fx.main), inspected: b.dir }),
        await runReport(path.join('.builders', 'spir-8'), { cwd: via(fx.main), inspected: b.dir }),
        await runReport(via(b.dir), { inspected: b.dir }),
        await runReport('.', { cwd: via(b.dir), inspected: b.dir }),
      ];

      expect(real.exitCode).toBe(0);
      expect(real.report.removable).toBe('removable');
      expect(real.report.worktree).toMatchObject({ path: b.dir, builderId: 'spir-8' });
      expect(byId(real.report, 'ignored')).toMatchObject({ status: 'ok', details: { keep: [], links: [], scaffold: ['.env'] } });
      for (const r of reports) {
        expect(r.exitCode).toBe(real.exitCode);
        expect(withoutTime(r.report)).toEqual(withoutTime(real.report));
      }
      const mainByLink = await checkWorktree(via(fx.main), { cwd: fx.main, env: fx.env, timeoutMs: 20_000 });
      expect(mainByLink.exitCode).toBe(2);
      expect((mainByLink.report as ErrorReport).error.message).toBe(`${fx.main} is the main worktree, not a builder's`);
    } finally {
      link.remove();
    }
  });

  it('a worktree outside .builders/ is reported by its path, with no builder id', async () => {
    configure();
    const dir = path.join(fx.root, 'elsewhere');
    fx.git(fx.main, 'worktree', 'add', '-q', '-b', 'feature/x', dir, 'main');
    fx.git(dir, 'push', '-q', 'origin', 'feature/x');

    const { report } = await runReport(dir, { inspected: dir });

    expect(report.worktree).toMatchObject({ path: fs.realpathSync.native(dir), builderId: null, branch: 'feature/x' });
    expect(renderWorktreeHuman(report)).toContain(`worktree  ${fs.realpathSync.native(dir)}   branch feature/x`);
  });

  describe('Scenario 21: exit 2', () => {
    async function failure(target: string, extra: Partial<CommandOptions> = {}): Promise<string> {
      const result = await checkWorktree(target, { cwd: fx.main, env: fx.env, ...extra });
      expect(result.exitCode, target).toBe(2);
      const report = result.report as ErrorReport;
      expect(report.command).toBe('worktree');
      return report.error.message;
    }

    it('a builder id with no worktree', async () => {
      configure();
      expect(await failure('spir-99')).toBe(`builder spir-99 not found: there is no worktree at ${path.join(fx.main, '.builders', 'spir-99')}`);
    });

    it('a path that is not a registered worktree, and one that does not exist', async () => {
      configure();
      const plain = path.join(fx.main, '.builders', 'not-a-worktree');
      fs.mkdirSync(plain, { recursive: true });
      expect(await failure('not-a-worktree')).toMatch(/not-a-worktree is not a registered worktree of /);
      expect(await failure(path.join(fx.root, 'nowhere'))).toBe(`worktree not found: ${path.join(fx.root, 'nowhere')} does not exist`);
    });

    it('the main worktree', async () => {
      configure();
      expect(await failure('.')).toMatch(/is the main worktree, not a builder's$/);
    });

    it('a detached HEAD', async () => {
      configure();
      const b = addBuilder(fx, 'spir-8');
      fx.git(b.dir, 'checkout', '-q', '--detach');
      expect(await failure('spir-8')).toMatch(/has a detached HEAD/);
    });

    it('an invalid builder id, before any subprocess starts', async () => {
      const spawn = vi.fn<SpawnFn>();
      for (const target of ['-rf', 'a b', '']) expect(await failure(target, { spawn }), JSON.stringify(target)).not.toBe('');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('an invalid cleanup.keepIgnored names the key and the file', async () => {
      const file = configure({ cleanup: { keepIgnored: 'tmp/**' } });
      addBuilder(fx, 'spir-8');
      expect(await failure('spir-8')).toBe(`cleanup.keepIgnored must be an array of non-empty glob strings (in ${file})`);
    });
  });
});
