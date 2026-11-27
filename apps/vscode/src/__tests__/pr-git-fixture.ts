/**
 * Real-git fixture for the pull-request diff tests (#2008).
 *
 *  - an "upstream" bare repo stands in for the forge. The PR head is reachable
 *    only from a hidden ref (`uploadpack.hideRefs`), the way a fork PR's head is
 *    reachable on a forge, and it accepts SHA wants (`allowAnySHA1InWant`) the
 *    way GitHub/GitLab do;
 *  - `clone()` makes a normal clone, standing in for the reviewer's main checkout.
 *
 * The PR (branched from `forkPoint`) modifies `a.txt`, deletes `b.txt`, renames
 * `old.txt` → `new.txt`, adds `c.txt` and changes the binary `img.bin`. After it
 * branched, `main` gained `later-on-main.txt`, which a merge-base diff must NOT
 * list.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface PullRequestGitFixture {
  root: string;
  upstream: string;
  /** The PR's head commit. */
  headSha: string;
  /** The PR's head after a second push (adds `d.txt`). */
  movedHeadSha: string;
  /** Where the PR branched from `main` (the expected merge-base). */
  forkPoint: string;
  /** A fresh clone of the upstream; `extra` are extra `git clone` args (e.g. `--depth 1`). */
  clone(extra?: string[]): string;
  dispose(): void;
}

export function createPullRequestGitFixture(): PullRequestGitFixture {
  const root = mkdtempSync(join(tmpdir(), 'codev-pr-git-'));
  const upstream = join(root, 'upstream.git');
  const author = join(root, 'author');
  execFileSync('git', ['init', '--quiet', '--bare', '--initial-branch=main', upstream], { env: ENV });
  git(upstream, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  git(upstream, 'config', 'uploadpack.hideRefs', 'refs/pull');
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', author], { env: ENV });

  writeFileSync(join(author, 'a.txt'), 'one\n');
  writeFileSync(join(author, 'b.txt'), 'bee\n');
  writeFileSync(join(author, 'old.txt'), 'a file that will be renamed\nwith enough lines\nto be detected\n');
  writeFileSync(join(author, 'img.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(author, 'add', '.');
  git(author, 'commit', '--quiet', '-m', 'base');
  const forkPoint = git(author, 'rev-parse', 'HEAD');
  git(author, 'remote', 'add', 'origin', upstream);
  git(author, 'push', '--quiet', 'origin', 'main');

  git(author, 'checkout', '--quiet', '-b', 'feature');
  writeFileSync(join(author, 'a.txt'), 'one\ntwo\n');
  unlinkSync(join(author, 'b.txt'));
  renameSync(join(author, 'old.txt'), join(author, 'new.txt'));
  writeFileSync(join(author, 'c.txt'), 'new file\n');
  writeFileSync(join(author, 'img.bin'), Buffer.from([0, 9, 9, 9, 0, 255]));
  git(author, 'add', '-A');
  git(author, 'commit', '--quiet', '-m', 'pr');
  const headSha = git(author, 'rev-parse', 'HEAD');
  git(author, 'push', '--quiet', 'origin', 'feature:refs/pull/7/head');

  // A later push to the same PR (its head "moves"), also on a hidden ref only.
  writeFileSync(join(author, 'd.txt'), 'pushed later\n');
  git(author, 'add', '.');
  git(author, 'commit', '--quiet', '-m', 'pr, second push');
  const movedHeadSha = git(author, 'rev-parse', 'HEAD');
  git(author, 'push', '--quiet', 'origin', 'feature:refs/pull/7/moved');

  git(author, 'checkout', '--quiet', 'main');
  writeFileSync(join(author, 'later-on-main.txt'), 'x\n');
  git(author, 'add', '.');
  git(author, 'commit', '--quiet', '-m', 'main moves on');
  git(author, 'push', '--quiet', 'origin', 'main');

  let n = 0;
  return {
    root,
    upstream,
    headSha,
    movedHeadSha,
    forkPoint,
    clone(extra: string[] = []): string {
      n += 1;
      const dir = join(root, `clone-${n}`);
      execFileSync('git', ['clone', '--quiet', ...extra, `file://${upstream}`, dir], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
      return dir;
    },
    dispose(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
