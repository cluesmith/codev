/**
 * Spec 1951 — the stub `git` and `gh` are an independent second layer: they must let every
 * read form through to the real program and refuse every write form, recording it.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFixture, snapshotRepoState, type Fixture } from './helpers/git-fixture.js';
import { allowedForms, argvOf, WRITE_FORMS } from './helpers/git-forms.js';
import { createStubBin, type StubBin } from './helpers/stub-bin.js';

let fx: Fixture;
let stubs: StubBin;

function run(command: 'git' | 'gh', args: readonly string[]): number | null {
  const result = spawnSync(path.join(stubs.dir, command), args, { cwd: fx.main, env: { ...process.env, ...fx.env, ...stubs.env } });
  return result.status;
}

beforeEach(() => {
  fx = createFixture();
  stubs = createStubBin(path.join(fx.root, 'stub-bin'));
});

afterEach(() => {
  fx.cleanup();
});

describe.skipIf(process.platform === 'win32')('Spec 1951 — stub git and gh', () => {
  it('passes every read form through to the real git, recording each', () => {
    const forms = allowedForms(fx.main);
    for (const f of forms) expect(run('git', argvOf(f)), argvOf(f).join(' ')).not.toBe(99);
    expect(stubs.violations()).toEqual([]);
    expect(stubs.gitCalls()).toHaveLength(forms.length);
  });

  it.each(WRITE_FORMS)('refuses %s, records it, and leaves the repository untouched', (_name, args) => {
    const before = snapshotRepoState(fx, fx.main);
    expect(run('git', args)).toBe(99);
    expect(stubs.violations()).toHaveLength(1);
    expect(snapshotRepoState(fx, fx.main)).toEqual(before);
  });

  it('answers gh read calls from fixtures and refuses writes', () => {
    stubs.answer(['pr', 'view', '7', '--json', 'title'], '{"title":"t"}\n');
    const view = spawnSync(path.join(stubs.dir, 'gh'), ['pr', 'view', '7', '--json', 'title'], { env: { ...process.env, ...stubs.env }, encoding: 'utf-8' });
    expect(view.status).toBe(0);
    expect(view.stdout).toBe('{"title":"t"}\n');
    expect(run('gh', ['pr', 'view', '8'])).toBe(98);
    expect(stubs.violations()).toEqual([]);

    for (const args of [['pr', 'merge', '7'], ['pr', 'comment', '7', '-b', 'x'], ['api', '-X', 'POST', 'repos/o/r/issues'], ['api', 'repos/o/r/issues', '-f', 'title=x']]) {
      expect(run('gh', args), args.join(' ')).toBe(99);
    }
    expect(stubs.violations()).toHaveLength(4);
  });
});
