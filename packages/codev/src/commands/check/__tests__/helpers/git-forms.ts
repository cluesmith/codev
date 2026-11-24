/**
 * Git invocations shared by the allow-list test and the stub-git self-test (Spec 1951):
 * every read form `codev check` uses, and the write forms both layers must refuse.
 */

export const SHA = 'a'.repeat(40);
export const SHA2 = 'b'.repeat(40);

export interface GitForm {
  globals: string[];
  sub: string;
  rest: string[];
}

export const form = (globals: string[], sub: string, ...rest: string[]): GitForm => ({ globals, sub, rest });
export const argvOf = (f: GitForm): string[] => [...f.globals, f.sub, ...f.rest];

export const FETCH_GLOBALS = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
const FETCH_FLAGS = ['--no-write-fetch-head', '--refmap=', '--no-tags', '--no-recurse-submodules'];

/** Every read form the commands use; `dir` is an absolute directory for `-C`. */
export function allowedForms(dir: string): GitForm[] {
  return [
    form([], 'version'),
    form([], 'rev-parse', '--show-toplevel'),
    form([], 'rev-parse', '--verify', '--quiet', `${SHA}^{commit}`),
    form([], 'rev-list', '--first-parent', '--max-count=10', SHA),
    form([], 'rev-list', '--count', `${SHA}..${SHA2}`),
    form([], 'merge-base', SHA, SHA2),
    form([], 'merge-base', '--is-ancestor', SHA, 'refs/remotes/origin/main'),
    form([], 'log', '--no-ext-diff', '--no-textconv', '-z', '--format=%H%x00%B', `${SHA}..${SHA2}`),
    form([], 'show', '--no-ext-diff', '--no-textconv', '-s', '--format=%B', SHA),
    form([], 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--no-renames', SHA, SHA2, '--', ':(top)', ':(top,exclude,glob)**/x'),
    form([], 'diff', '--no-ext-diff', '--no-textconv', '--numstat', '-z', SHA, SHA2),
    form([], 'diff-tree', '--no-ext-diff', '--no-textconv', '--no-commit-id', '--name-only', '-r', '-z', SHA),
    form([], 'cat-file', '-e', `${SHA}^{commit}`),
    form([], 'cat-file', '-t', SHA),
    form([], 'for-each-ref', '--format=%(refname)', 'refs/heads/main'),
    form(['-C', dir], 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ':(top,glob)codev/**'),
    form([], 'ls-remote', 'origin', 'refs/heads/main'),
    form([], 'ls-remote', '--symref', 'origin', 'HEAD'),
    form([], 'worktree', 'list', '--porcelain'),
    form([], 'config', '--get', 'remote.origin.url'),
    form([], 'symbolic-ref', '--short', '-q', 'HEAD'),
    form(['-C', dir, '--no-optional-locks'], 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    form([], 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', SHA, SHA2),
    form(FETCH_GLOBALS, 'fetch', ...FETCH_FLAGS, '--quiet', 'origin', SHA, SHA2),
  ];
}

/** Invocations that write a ref, the index, the work tree, config or FETCH_HEAD, or run a program. */
export const WRITE_FORMS: Array<[string, string[]]> = [
  ['update-ref', ['update-ref', 'refs/heads/x', SHA]],
  ['push', ['push', 'origin', 'main']],
  ['branch -D', ['branch', '-D', 'x']],
  ['tag', ['tag', 'x']],
  ['reset --hard', ['reset', '--hard']],
  ['checkout', ['checkout', '--', '.']],
  ['gc', ['gc']],
  ['fetch origin main', [...FETCH_GLOBALS, 'fetch', ...FETCH_FLAGS, 'origin', 'main']],
  ['fetch without --refmap=', [...FETCH_GLOBALS, 'fetch', '--no-write-fetch-head', '--no-tags', '--no-recurse-submodules', 'origin', SHA]],
  ['fetch without --no-write-fetch-head', [...FETCH_GLOBALS, 'fetch', '--refmap=', '--no-tags', '--no-recurse-submodules', 'origin', SHA]],
  ['fetch without --no-tags', [...FETCH_GLOBALS, 'fetch', '--no-write-fetch-head', '--refmap=', '--no-recurse-submodules', 'origin', SHA]],
  ['fetch without the housekeeping overrides', ['fetch', ...FETCH_FLAGS, 'origin', SHA]],
  ['fetch from another remote', [...FETCH_GLOBALS, 'fetch', ...FETCH_FLAGS, 'upstream', SHA]],
  ['fetch an abbreviated SHA', [...FETCH_GLOBALS, 'fetch', ...FETCH_FLAGS, 'origin', 'abc1234']],
  ['merge-tree without --write-tree', ['merge-tree', SHA, SHA2]],
  ['status without --no-optional-locks', ['status', '--porcelain=v1']],
  ['config --unset', ['config', '--unset', 'x.y']],
  ['config set', ['config', 'x.y', 'z']],
  ['config read without --get', ['config', 'remote.origin.url']],
  ['symbolic-ref HEAD refs/heads/x', ['symbolic-ref', 'HEAD', 'refs/heads/x']],
  ['worktree remove', ['worktree', 'remove', '/x']],
  ['worktree list without --porcelain', ['worktree', 'list']],
  ['-c core.hooksPath=x log', ['-c', 'core.hooksPath=x', 'log', '--no-ext-diff', '--no-textconv', SHA]],
  ['log --output=x', ['log', '--no-ext-diff', '--no-textconv', '--output=x', SHA]],
  ['ls-remote --upload-pack=x', ['ls-remote', '--upload-pack=x', 'origin']],
];

/**
 * Read-only in themselves, but outside the grammar: a diff-family command without its
 * guards, or a flag no command uses. Both layers must refuse them, so a regression that
 * drops a guard is caught by either.
 */
export const OFF_GRAMMAR_FORMS: Array<[string, string[]]> = [
  ['log without its guards', ['log', SHA]],
  ['diff without its guards', ['diff', SHA, SHA2]],
  ['show without its guards', ['show', '-s', SHA]],
  ['diff-tree without its guards', ['diff-tree', '--name-only', '-r', SHA]],
  ['rev-list --all', ['rev-list', '--all']],
  ['cat-file --batch', ['cat-file', '--batch']],
  ['ls-files --stage', ['ls-files', '--stage']],
  ['rev-parse --git-path', ['rev-parse', '--git-path', 'x']],
  ['version --build-options', ['version', '--build-options']],
  // Arguments, not flags: another repository, a transport that runs a program, a file
  // system path. The second layer must not rely on the first having checked them.
  ['ls-remote another remote', ['ls-remote', 'upstream', 'HEAD']],
  ['ls-remote an ext:: transport', ['ls-remote', 'ext::sh -c true', 'HEAD']],
  ['ls-remote a path to another repository', ['ls-remote', '/other/repo.git']],
  ['ls-remote origin with an ext:: ref', ['ls-remote', 'origin', 'ext::x']],
  ['diff of absolute paths (an implicit --no-index diff)', ['diff', '--no-ext-diff', '--no-textconv', '/etc/hosts', '/etc/passwd']],
  ['diff of paths outside the work tree', ['diff', '--no-ext-diff', '--no-textconv', '../a', '../b']],
  ['ls-files with a path argument', ['ls-files', 'README.md']],
  ['status with a path argument', ['--no-optional-locks', 'status', '--porcelain=v1', 'README.md']],
  ['for-each-ref outside refs/', ['for-each-ref', 'heads/']],
];
