/**
 * Real git repositories for `codev check` tests (Spec 1951): a bare "origin", clones of it,
 * and worktrees. Fixture setup runs git by ABSOLUTE path, so a stub `git` first on PATH
 * records only what the code under test runs.
 *
 * Every git call here, and every runner a test builds with `fixtureEnv()`, ignores the
 * user's global and system git config, so a signing key or hook path on the developer's
 * machine cannot change the outcome.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const EXE = process.platform === 'win32' ? '.exe' : '';

/** The absolute path of an executable on the current PATH. */
export function resolveExecutable(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name + EXE);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`${name} not found on PATH`);
}

export const REAL_GIT = resolveExecutable('git');

export interface Fixture {
  /** Temp directory holding everything; remove with `cleanup()`. */
  root: string;
  /** The bare repository every clone calls `origin`. */
  origin: string;
  /** The main clone, on `main`, with one commit pushed. */
  main: string;
  /** Environment that isolates git from the user's config; pass to runners. */
  env: Record<string, string>;
  git(cwd: string, ...args: string[]): string;
  /** Write files (relative path → content; null deletes) and commit them. Returns the SHA. */
  commit(cwd: string, files: Record<string, string | null>, message: string): string;
  clone(name: string): string;
  addWorktree(name: string, branch: string, base?: string): string;
  cleanup(): void;
}

export function createFixture(): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codev-check-')));
  const emptyConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(emptyConfig, '[user]\n\tname = Fixture\n\temail = fixture@example.invalid\n[init]\n\tdefaultBranch = main\n');
  const env: Record<string, string> = {
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  };

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(REAL_GIT, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  const commit = (cwd: string, files: Record<string, string | null>, message: string): string => {
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(cwd, rel);
      if (content === null) {
        git(cwd, 'rm', '-q', '--', rel);
        continue;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      git(cwd, 'add', '--', rel);
    }
    git(cwd, 'commit', '-q', '--allow-empty', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD').trim();
  };

  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const main = path.join(root, 'main');
  git(root, 'clone', '-q', origin, main);
  commit(main, { 'README.md': 'fixture\n' }, 'initial');
  git(main, 'push', '-q', 'origin', 'main');

  return {
    root,
    origin,
    main,
    env,
    git,
    commit,
    clone(name) {
      const dir = path.join(root, name);
      git(root, 'clone', '-q', origin, dir);
      return dir;
    },
    addWorktree(name, branch, base = 'HEAD') {
      const dir = path.join(main, '.builders', name);
      git(main, 'worktree', 'add', '-q', '-b', branch, dir, base);
      return dir;
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface RepoState {
  refs: string;
  head: string;
  index: string;
  /** FETCH_HEAD is per-worktree; both locations are read, so a linked worktree is covered. */
  fetchHead: { worktree: string | null; common: string | null };
  status: string;
}

/** Everything a read-only command must leave untouched, captured for comparison. */
export function snapshotRepoState(fixture: Fixture, repo: string): RepoState {
  const gitDir = path.resolve(repo, fixture.git(repo, 'rev-parse', '--git-dir').trim());
  const commonDir = path.resolve(repo, fixture.git(repo, 'rev-parse', '--git-common-dir').trim());
  const indexFile = path.join(gitDir, 'index');
  const read = (file: string): string | null => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);
  return {
    refs: fixture.git(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    head: fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8'),
    index: fs.existsSync(indexFile) ? fs.readFileSync(indexFile).toString('base64') : '',
    fetchHead: { worktree: read(path.join(gitDir, 'FETCH_HEAD')), common: read(path.join(commonDir, 'FETCH_HEAD')) },
    status: fixture.git(repo, '--no-optional-locks', 'status', '--porcelain=v1'),
  };
}
