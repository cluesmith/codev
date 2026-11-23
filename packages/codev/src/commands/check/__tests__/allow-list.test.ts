/**
 * Spec 1951 — the closed read-only grammar for `codev check`'s git calls.
 */

import { describe, expect, it } from 'vitest';
import { assertConceptAllowed, assertGitArgvAllowed, RunnerRefusal } from '../allow-list.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const ABS = process.platform === 'win32' ? 'C:\\repo' : '/repo';

interface Form {
  globals: string[];
  sub: string;
  rest: string[];
}

const form = (globals: string[], sub: string, ...rest: string[]): Form => ({ globals, sub, rest });
const argv = (f: Form): string[] => [...f.globals, f.sub, ...f.rest];

/** Every form the commands use. Each must pass. */
const ALLOWED: Form[] = [
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
  form([], 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', SHA),
  form([], 'cat-file', '-e', `${SHA}^{commit}`),
  form([], 'cat-file', '-t', SHA),
  form([], 'for-each-ref', '--format=%(refname)', 'refs/heads/main'),
  form(['-C', ABS], 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ':(top,glob)codev/**'),
  form([], 'ls-remote', 'origin', 'refs/heads/main'),
  form([], 'ls-remote', '--symref', 'origin', 'HEAD'),
  form([], 'worktree', 'list', '--porcelain'),
  form([], 'config', '--get', 'remote.origin.url'),
  form([], 'symbolic-ref', '--short', '-q', 'HEAD'),
  form(['-C', ABS, '--no-optional-locks'], 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
  form([], 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', SHA, SHA2),
  form(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'], 'fetch', '--no-write-fetch-head', '--refmap=', '--no-tags', '--quiet', 'origin', SHA, SHA2),
];

const FETCH_GLOBALS = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];

/** Named refusals from the plan's acceptance table. */
const REFUSED: Array<[string, string[]]> = [
  ['update-ref', ['update-ref', 'refs/heads/x', SHA]],
  ['push', ['push', 'origin', 'main']],
  ['branch -D', ['branch', '-D', 'x']],
  ['fetch origin main', [...FETCH_GLOBALS, 'fetch', '--no-write-fetch-head', '--refmap=', 'origin', 'main']],
  ['fetch without --refmap=', [...FETCH_GLOBALS, 'fetch', '--no-write-fetch-head', 'origin', SHA]],
  ['fetch without --no-write-fetch-head', [...FETCH_GLOBALS, 'fetch', '--refmap=', 'origin', SHA]],
  ['fetch without the housekeeping overrides', ['fetch', '--no-write-fetch-head', '--refmap=', 'origin', SHA]],
  ['fetch from another remote', [...FETCH_GLOBALS, 'fetch', '--no-write-fetch-head', '--refmap=', 'upstream', SHA]],
  ['fetch an abbreviated SHA', [...FETCH_GLOBALS, 'fetch', '--no-write-fetch-head', '--refmap=', 'origin', 'abc1234']],
  ['merge-tree without --write-tree', ['merge-tree', SHA, SHA2]],
  ['status without --no-optional-locks', ['status', '--porcelain=v1']],
  ['config --unset', ['config', '--unset', 'x.y']],
  ['config set', ['config', 'x.y', 'z']],
  ['config read without --get', ['config', 'remote.origin.url']],
  ['symbolic-ref HEAD refs/heads/x', ['symbolic-ref', 'HEAD', 'refs/heads/x']],
  ['worktree remove', ['worktree', 'remove', '/x']],
  ['worktree list without --porcelain', ['worktree', 'list']],
  ['-c core.hooksPath=x log', ['-c', 'core.hooksPath=x', 'log', '--no-ext-diff', '--no-textconv', SHA]],
  ['-c on a subcommand other than fetch', ['-c', 'gc.auto=0', 'log', '--no-ext-diff', '--no-textconv', SHA]],
  ['--exec-path', ['--exec-path=/x', 'version']],
  ['--git-dir', ['--git-dir=/x', 'version']],
  ['-C with a relative path', ['-C', 'repo', 'version']],
  ['a global option after the subcommand', ['status', '--no-optional-locks', '--porcelain=v1']],
  ['ls-remote another remote', ['ls-remote', 'upstream', 'HEAD']],
  ['a revision beginning with -', ['merge-base', '--', SHA]],
  ['a revision with ~', ['cat-file', '-e', 'HEAD~1']],
  ['a triple-dot range', ['log', '--no-ext-diff', '--no-textconv', `${SHA}...${SHA2}`]],
  ['pathspecs where none are allowed', ['merge-tree', '--write-tree', SHA, SHA2, '--', 'x']],
  ['an empty pathspec', ['diff', '--no-ext-diff', '--no-textconv', SHA, SHA2, '--', '']],
  ['a control character', ['cat-file', '-e', `${SHA}\n`]],
  ['no subcommand', []],
  ['a subcommand that is an Object.prototype key', ['toString']],
  ['diff without --no-ext-diff', ['diff', '--no-textconv', SHA, SHA2]],
  ['diff without --no-textconv', ['diff', '--no-ext-diff', SHA, SHA2]],
  ['log without --no-ext-diff --no-textconv', ['log', SHA]],
  ['show without --no-ext-diff --no-textconv', ['show', '-s', SHA]],
];

const BAD_FLAGS = ['--output=x', '--ext-diff', '--textconv', '--filters', '--upload-pack=x', '--exec=x', '--frobnicate'];

describe('Spec 1951 — read-only git allow-list', () => {
  it.each(ALLOWED.map((f) => [argv(f).join(' '), f] as const))('allows %s', (_name, f) => {
    expect(assertGitArgvAllowed(argv(f))).toBe(f.sub);
  });

  it.each(REFUSED)('refuses %s', (_name, args) => {
    expect(() => assertGitArgvAllowed(args)).toThrow(RunnerRefusal);
  });

  describe('refuses the file-writing and program-running flags on every allowed subcommand', () => {
    const cases = ALLOWED.flatMap((f) => BAD_FLAGS.map((flag) => [`${f.sub} ${flag}`, { ...f, rest: [flag, ...f.rest] }] as const));
    it.each(cases)('%s', (_name, f) => {
      expect(() => assertGitArgvAllowed(argv(f))).toThrow(RunnerRefusal);
    });
  });

  it('names the refused command in the error', () => {
    expect(() => assertGitArgvAllowed(['push', 'origin'])).toThrow(/refused to run git push origin: git push is not on the read-only list/);
  });
});

describe('Spec 1951 — read-only forge concepts', () => {
  it.each(['pr-view', 'pr-search', 'commit-checks', 'workflow-runs'])('allows %s', (concept) => {
    expect(() => assertConceptAllowed(concept)).not.toThrow();
  });

  it.each(['pr-merge', 'pr-comment', 'pr-create', 'issue-comment', 'pr-diff'])('refuses %s', (concept) => {
    expect(() => assertConceptAllowed(concept)).toThrow(RunnerRefusal);
  });
});
