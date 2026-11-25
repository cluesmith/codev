/**
 * Spec 1951 — roots come from git, so `codev check` behaves the same from the main checkout
 * and from inside a builder worktree.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckCommandError } from '../report.js';
import { parseWorktreeList, requireOrigin, resolveRoots } from '../roots.js';
import { createRunner } from '../runner.js';
import { loadCheckSettings } from '../settings.js';
import { createFixture, type Fixture } from './helpers/git-fixture.js';
import { useFakeHome } from './helpers/fake-home.js';

let fx: Fixture;

const rootsFrom = (cwd: string) => resolveRoots(createRunner({ cwd, workspaceRoot: cwd, env: fx.env }));

/** Never read the developer's own ~/.codev/config.json. */
useFakeHome();

beforeEach(() => {
  fx = createFixture();
});

afterEach(() => {
  fx.cleanup();
});

describe('Spec 1951 — roots', () => {
  it('from the main checkout, both roots are the main checkout', async () => {
    expect(await rootsFrom(fx.main)).toEqual({ checkoutRoot: fx.main, mainRoot: fx.main });
  });

  it('from a subdirectory, the checkout root is the top level', async () => {
    const sub = path.join(fx.main, 'deep', 'er');
    fs.mkdirSync(sub, { recursive: true });
    expect(await rootsFrom(sub)).toEqual({ checkoutRoot: fx.main, mainRoot: fx.main });
  });

  it('from a builder worktree, mainRoot is the main checkout and config is read from it', async () => {
    const worktree = fx.addWorktree('spir-1', 'builder/spir-1');
    fs.mkdirSync(path.join(fx.main, '.codev'), { recursive: true });
    fs.writeFileSync(path.join(fx.main, '.codev', 'config.json'), JSON.stringify({ check: { watch: ['from-main/**'] } }));
    fs.mkdirSync(path.join(worktree, '.codev'), { recursive: true });
    fs.writeFileSync(path.join(worktree, '.codev', 'config.json'), JSON.stringify({ check: { watch: ['from-worktree/**'] } }));

    const roots = await rootsFrom(path.join(worktree));
    expect(roots).toEqual({ checkoutRoot: worktree, mainRoot: fx.main });
    expect(loadCheckSettings(roots.mainRoot).watch).toEqual(['from-main/**']);
  });

  it('outside a git repository, fails', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codev-check-norepo-')));
    try {
      const error = await rootsFrom(outside).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(CheckCommandError);
      expect((error as Error).message).toBe('not in a git repository');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('without an origin remote, requireOrigin fails; finding the roots does not ask', async () => {
    fx.git(fx.main, 'remote', 'remove', 'origin');
    await expect(rootsFrom(fx.main)).resolves.toMatchObject({ mainRoot: fx.main });
    await expect(requireOrigin(createRunner({ cwd: fx.main, workspaceRoot: fx.main, env: fx.env }))).rejects.toThrow(
      'this repository has no "origin" remote',
    );
  });
});

describe('Spec 1951 — parseWorktreeList', () => {
  it('parses branches, detached heads and bare entries', () => {
    const sep = path.sep;
    const entries = parseWorktreeList(
      [
        'worktree /repo', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '',
        'worktree /repo/.builders/x', 'HEAD ' + 'b'.repeat(40), 'detached', '',
        'worktree /bare.git', 'bare', '',
      ].join('\n'),
    );
    expect(entries.map((e) => ({ ...e, path: e.path.split(sep).filter(Boolean).pop() }))).toEqual([
      { path: 'repo', head: 'a'.repeat(40), branch: 'main', bare: false },
      { path: 'x', head: 'b'.repeat(40), branch: null, bare: false },
      { path: 'bare.git', head: null, branch: null, bare: true },
    ]);
  });

  it('keeps a path that ends in a space (claude, pr review note 3)', () => {
    const entries = parseWorktreeList(['worktree /repo/trail ', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/t', ''].join('\n'));
    expect(entries.map((e) => e.path)).toEqual([path.resolve('/repo/trail ')]);
  });

  it('reads CRLF output like LF', () => {
    const entries = parseWorktreeList(['worktree /repo', 'HEAD ' + 'a'.repeat(40), 'branch refs/heads/main', '', ''].join('\r\n'));
    expect(entries).toEqual([{ path: path.resolve('/repo'), head: 'a'.repeat(40), branch: 'main', bare: false }]);
  });
});
