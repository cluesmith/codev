/**
 * Spec 1951 — `codev check worktree` under the stub-PATH audit (Scenario 22; POSIX).
 *
 * A stub `git` first on PATH records every call and refuses anything off its own read-only
 * list, then runs the real git. Each case runs the command on a real worktree, then proves
 * that nothing off the list ran, that the per-worktree reads named the worktree with `-C` and
 * `status` carried `--no-optional-locks`, and that the main checkout and the inspected
 * worktree are unchanged.
 */

import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Removable } from '../report.js';
import { checkWorktree } from '../worktree.js';
import { useFakeHome } from './helpers/fake-home.js';
import { createFixture, snapshotRepoState, type Fixture } from './helpers/git-fixture.js';
import { prViewOverride, writeConfig, type PrViewOverride } from './helpers/pr-fixture.js';
import { expectWorktreeReportShape } from './helpers/report-shape.js';
import { createStubBin, type StubBin } from './helpers/stub-bin.js';
import {
  addBuilder,
  builderView,
  deleteRemoteBranch,
  mergeBuilder,
  prSearchOverride,
  squashBuilder,
  writeFiles,
  type Builder,
  type PrSearchOverride,
} from './helpers/worktree-fixture.js';

const isWindows = process.platform === 'win32';

useFakeHome();

let fx: Fixture;
let stub: StubBin;
let view: PrViewOverride;
let search: PrSearchOverride;
let uninstall: () => void;

function prIs(b: Builder, state: 'OPEN' | 'MERGED'): void {
  search.answer([{ number: 8, headRefName: b.branch, state }]);
  view.answerFor(8, builderView(b, state));
}

interface Case {
  name: string;
  arrange: () => Builder;
  removable: Removable;
  exitCode: number;
}

const CASES: Case[] = [
  {
    name: 'Scenario 16: merged, remote branch deleted',
    arrange: () => {
      const b = addBuilder(fx, 'spir-8');
      mergeBuilder(fx, b);
      deleteRemoteBranch(fx, b.branch);
      prIs(b, 'MERGED');
      return b;
    },
    removable: 'removable',
    exitCode: 0,
  },
  {
    name: 'Scenario 17: a modified tracked file',
    arrange: () => {
      const b = addBuilder(fx, 'spir-8');
      writeFiles(b.dir, { 'codev/state/spir-8_thread.md': 'changed\n' });
      prIs(b, 'OPEN');
      return b;
    },
    removable: 'not-removable',
    exitCode: 1,
  },
  {
    name: 'Scenario 18: an unpushed commit',
    arrange: () => {
      const b = addBuilder(fx, 'spir-8');
      fx.commit(b.dir, { 'late.ts': 'late\n' }, 'late');
      prIs(b, 'OPEN');
      return b;
    },
    removable: 'not-removable',
    exitCode: 1,
  },
  {
    name: 'Scenario 19: squash-merged at the merged head',
    arrange: () => {
      const b = addBuilder(fx, 'spir-8');
      squashBuilder(fx, b);
      deleteRemoteBranch(fx, b.branch);
      prIs(b, 'MERGED');
      return b;
    },
    removable: 'removable',
    exitCode: 0,
  },
  {
    name: 'Scenario 20: keep-list ignored files next to node_modules/',
    arrange: () => {
      fx.commit(fx.main, { '.gitignore': 'node_modules/\ntmp/\n' }, 'ignore');
      fx.git(fx.main, 'push', '-q', 'origin', 'main');
      const b = addBuilder(fx, 'spir-8');
      writeFiles(b.dir, { 'tmp/notes.md': 'n\n', 'node_modules/x/index.js': 'x\n' });
      mergeBuilder(fx, b);
      prIs(b, 'MERGED');
      return b;
    },
    removable: 'removable-after-keeping',
    exitCode: 1,
  },
  {
    name: 'Scenario 20a: clean and pushed, PR open',
    arrange: () => {
      const b = addBuilder(fx, 'spir-8');
      prIs(b, 'OPEN');
      return b;
    },
    removable: 'removable',
    exitCode: 1,
  },
];

describe.skipIf(isWindows)('Spec 1951 — check worktree (stub git)', { timeout: 30_000 }, () => {
  beforeEach(() => {
    fx = createFixture();
    stub = createStubBin(path.join(fx.root, 'bin'));
    uninstall = stub.install();
    view = prViewOverride(fx);
    search = prSearchOverride(fx);
    writeConfig(fx, { forge: { 'pr-view': view.script, 'pr-search': search.script } });
  });

  afterEach(() => {
    uninstall();
    fx.cleanup();
  });

  it.each(CASES)('$name: every git call is on the read-only list, and nothing changes', async (c) => {
    const b = c.arrange();
    const before = [snapshotRepoState(fx, fx.main), snapshotRepoState(fx, b.dir)];
    const callsBefore = stub.gitCalls().length;

    const result = await checkWorktree('spir-8', { cwd: fx.main, env: { ...fx.env, ...stub.env }, timeoutMs: 20_000 });

    if ('error' in result.report) throw new Error(`unexpected exit 2: ${result.report.error.message}`);
    expectWorktreeReportShape(result.report);
    expect(result.report.removable).toBe(c.removable);
    expect(result.exitCode).toBe(c.exitCode);
    expect(stub.violations()).toEqual([]);
    expect([snapshotRepoState(fx, fx.main), snapshotRepoState(fx, b.dir)]).toEqual(before);

    const calls = stub.gitCalls().slice(callsBefore);
    const inWorktree = calls.filter((call) => call.startsWith(`-C ${b.dir} `));
    expect(inWorktree.map((call) => call.split(' ').slice(2, 4).join(' ')).sort()).toEqual([
      '--no-optional-locks status',
      'ls-files --others',
      'ls-files --others',
    ]);
    expect(calls.filter((call) => /(^| )status( |$)/.test(call)).every((call) => call.includes('--no-optional-locks'))).toBe(true);
  });
});
