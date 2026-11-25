/**
 * Spec 1951 — spawn's scaffold files as one list, shared by `afx cleanup` and
 * `codev check worktree`, and the cleanup fix it carries (owner decision main-36): a worktree
 * holding only scaffold files, the write guard's included, is not dirty to cleanup.
 *
 * Evidence for the fix: cleanup reported "1 uncommitted file(s)" for two bugfix builders that
 * had nothing uncommitted. The one file was the write guard's `.claude/hooks/` directory,
 * which `git status --porcelain` lists as a directory and the old `.builder-` regex missed.
 * The notice also leaves out the entries spawn linked in from the main checkout, by the rule
 * the check uses (`isSpawnMade`).
 */

import { execFileSync } from 'node:child_process';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useFakeHome } from '../../commands/check/__tests__/helpers/fake-home.js';
import { hasUncommittedChanges } from '../commands/cleanup.js';
import { symlinkConfigFiles } from '../commands/spawn-worktree.js';
import { isBuilderScaffold, OPENCODE_CONFIG_RELPATH, SCAFFOLD_PATHS, spawnLinkTarget } from '../lib/builder-scaffold.js';
import { DEFAULT_KEEP_IGNORED, isNeverKeep, keepPatterns } from '../lib/keep-list.js';
import * as keepFiles from '../lib/keep-files.js';
import { BUILTIN_HARNESSES } from '../utils/harness.js';
import { GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH } from '../utils/worktree-write-guard.js';

describe('Spec 1951 — isBuilderScaffold', () => {
  it('matches root-level .builder-* files and the fixed scaffold paths', () => {
    for (const p of ['.builder-prompt.txt', '.builder-role.md', '.builder-start.sh', '.builder-session-id', '.builder-state.md', '.builder-reorient.md']) {
      expect(isBuilderScaffold(p), p).toBe(true);
    }
    for (const p of [GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH, OPENCODE_CONFIG_RELPATH]) expect(isBuilderScaffold(p), p).toBe(true);
  });

  it('matches nothing else: nested .builder-* names, other hook files, look-alikes', () => {
    for (const p of ['src/.builder-x', '.claude/hooks/other.cjs', '.claude/settings.json', '.builder', 'builder-x', 'codev/state/x_thread.md', '.claude/hooks/']) {
      expect(isBuilderScaffold(p), p).toBe(false);
    }
  });

  it('names every file a built-in harness writes into a worktree, so the two cannot drift', () => {
    const written = Object.values(BUILTIN_HARNESSES).flatMap((h) => h.getWorktreeFiles?.('role', '/w/.builder-role.md', '/w') ?? []);
    expect([...new Set(written.map((f) => f.relativePath))].sort()).toEqual([...SCAFFOLD_PATHS].sort());
  });
});

// Native Windows may make a hard link or a copy where POSIX makes a symlink; this is about links.
describe.skipIf(process.platform === 'win32')("Spec 1951 — spawnLinkTarget is the shape of every link spawn makes", { timeout: 30_000 }, () => {
  useFakeHome();
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'spec-1951-links-')));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** Every symbolic link under `dir`, worktree-relative and `/`-separated. */
  const linksUnder = (dir: string): string[] =>
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((rel) => lstatSync(join(dir, rel)).isSymbolicLink())
      .map((rel) => rel.split(sep).join('/'))
      .sort();

  it('symlinkConfigFiles: the built-in links and each worktree.symlinks entry point at spawnLinkTarget', () => {
    const root = join(base, 'main');
    const worktree = join(base, 'wt');
    const put = (rel: string): void => {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), `${rel}\n`);
    };
    put('.env');
    put('.env.local');
    put('packages/web/.env');
    put('.codev/config.json');
    writeFileSync(join(root, '.codev/config.json'), JSON.stringify({ worktree: { symlinks: ['.env.local', 'packages/*/.env', '.local-data/'] } }));
    mkdirSync(worktree);

    symlinkConfigFiles({ workspaceRoot: root } as Parameters<typeof symlinkConfigFiles>[0], worktree);

    const made = linksUnder(worktree);
    expect(made).toEqual(['.codev/config.json', '.env', '.env.local', '.local-data', 'packages/web/.env']);
    for (const rel of made) {
      const abs = join(worktree, ...rel.split('/'));
      expect(resolve(dirname(abs), readlinkSync(abs)), rel).toBe(spawnLinkTarget(root, rel));
    }
    expect(relative(root, spawnLinkTarget(root, 'packages/web/.env'))).toBe(join('packages', 'web', '.env'));
  });
});

describe('Spec 1951 — keep-list.ts is the one definition keep-files.ts uses', () => {
  it('keep-files re-exports the same objects', () => {
    expect(keepFiles.DEFAULT_KEEP_IGNORED).toBe(DEFAULT_KEEP_IGNORED);
    expect(keepFiles.keepPatterns).toBe(keepPatterns);
  });

  it('isNeverKeep: any dependency or build-output segment', () => {
    expect(isNeverKeep('node_modules/x/index.js')).toBe(true);
    expect(isNeverKeep('codev/projects/8/node_modules/a.js')).toBe(true);
    expect(isNeverKeep('packages/x/dist/out.js')).toBe(true);
    expect(isNeverKeep('codev/projects/8/review.txt')).toBe(false);
    expect(isNeverKeep('distribution/notes.md')).toBe(false);
  });
});

describe('Spec 1951 — afx cleanup: hasUncommittedChanges and the scaffold (main-36)', () => {
  let base: string;
  let main: string;
  let worktree: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: worktree, stdio: 'pipe' });
  const write = (rel: string, content = `${rel}\n`, root = worktree): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'spec-1951-scaffold-')));
    main = join(base, 'main');
    worktree = join(base, 'wt');
    mkdirSync(main);
    mkdirSync(worktree);
    git('init', '-q');
    write('src/tracked.ts');
    git('add', '.');
    git('commit', '-qm', 'init');
    for (const rel of ['.builder-prompt.txt', '.builder-role.md', '.builder-start.sh', GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH]) write(rel);
    write('shared/data.json', '{"from":"main"}\n', main);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('only scaffold files, the write guard included: not dirty', async () => {
    expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: false, scaffoldOnly: true, details: '' });
  });

  it('a clean worktree: not dirty, not scaffold-only', async () => {
    rmSync(join(worktree, '.claude'), { recursive: true });
    for (const rel of ['.builder-prompt.txt', '.builder-role.md', '.builder-start.sh']) rmSync(join(worktree, rel));
    expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: false, scaffoldOnly: false, details: '' });
  });

  it('another file next to the write guard is dirty, counted by itself', async () => {
    write('.claude/hooks/mine.cjs');
    expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: true, scaffoldOnly: false, details: '1 uncommitted file(s)' });
  });

  it('a modified tracked file is dirty, whatever the scaffold', async () => {
    write('src/tracked.ts', 'changed\n');
    write('notes.md');
    expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: true, scaffoldOnly: false, details: '2 uncommitted file(s)' });
  });

  // The notice gates no deletion; when in doubt it says "dirty". These pin that direction for
  // the NUL-separated read (`git status --porcelain -z`).
  describe('reading git status: the notice errs toward dirty', () => {
    const noScaffold = (): void => {
      rmSync(join(worktree, '.claude'), { recursive: true });
      for (const rel of ['.builder-prompt.txt', '.builder-role.md', '.builder-start.sh']) rmSync(join(worktree, rel));
    };

    it("a single modified tracked file, the first entry (' M'), is counted", async () => {
      noScaffold();
      write('src/tracked.ts', 'changed\n');
      expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: true, scaffoldOnly: false, details: '1 uncommitted file(s)' });
    });

    it('an untracked file whose name git would quote is counted', async () => {
      write('my notes é.md');
      expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: true, scaffoldOnly: false, details: '1 uncommitted file(s)' });
    });

    it('a staged rename counts once', async () => {
      noScaffold();
      git('mv', 'src/tracked.ts', 'src/moved.ts');
      expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: true, scaffoldOnly: false, details: '1 uncommitted file(s)' });
    });

    it('git status failing reports "Unable to check status" as dirty', async () => {
      const broken = join(base, 'broken');
      mkdirSync(broken);
      writeFileSync(join(broken, '.git'), `gitdir: ${join(base, 'no-such-gitdir')}\n`);
      expect(await hasUncommittedChanges(broken, main)).toEqual({ dirty: true, scaffoldOnly: false, details: 'Unable to check status' });
    });
  });

  // The same rule `codev check worktree` uses (isSpawnMade): an entry spawn linked in from the
  // main checkout that git does not ignore is scaffold, however spawn had to make it.
  describe('entries spawn linked in from the main checkout', () => {
    it.skipIf(process.platform === 'win32')('a symbolic link to the same path in the main checkout: not counted', async () => {
      mkdirSync(join(worktree, 'shared'));
      symlinkSync(spawnLinkTarget(main, 'shared/data.json'), join(worktree, 'shared/data.json'));
      expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: false, scaffoldOnly: true, details: '' });
    });

    it('a hard link of the main checkout\'s file: not counted', async () => {
      mkdirSync(join(worktree, 'shared'));
      linkSync(join(main, 'shared/data.json'), join(worktree, 'shared/data.json'));
      expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: false, scaffoldOnly: true, details: '' });
    });

    it('an unchanged copy: not counted', async () => {
      write('shared/data.json', '{"from":"main"}\n');
      expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: false, scaffoldOnly: true, details: '' });
    });

    it('a changed copy is data: counted', async () => {
      write('shared/data.json', '{"from":"the builder"}\n');
      expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: true, scaffoldOnly: false, details: '1 uncommitted file(s)' });
    });

    it('at a path git would quote: a hard link and an unchanged copy are not counted', async () => {
      write('shared/my data é.json', '{"a":1}\n', main);
      write('shared/copy ü.json', '{"b":2}\n', main);
      mkdirSync(join(worktree, 'shared'));
      linkSync(join(main, 'shared/my data é.json'), join(worktree, 'shared/my data é.json'));
      write('shared/copy ü.json', '{"b":2}\n');
      expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: false, scaffoldOnly: true, details: '' });
    });

    it.skipIf(process.platform === 'win32')('a link at that path pointing anywhere else is data: counted', async () => {
      write('elsewhere.json', '{"from":"main"}\n', base);
      mkdirSync(join(worktree, 'shared'));
      symlinkSync(join(base, 'elsewhere.json'), join(worktree, 'shared/data.json'));
      expect(await hasUncommittedChanges(worktree, main)).toEqual({ dirty: true, scaffoldOnly: false, details: '1 uncommitted file(s)' });
    });
  });
});
