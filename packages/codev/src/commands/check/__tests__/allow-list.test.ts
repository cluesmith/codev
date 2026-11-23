/**
 * Spec 1951 — the closed read-only grammar for `codev check`'s git calls.
 */

import { describe, expect, it } from 'vitest';
import { assertConceptAllowed, assertGitArgvAllowed, RunnerRefusal } from '../allow-list.js';
import { allowedForms, argvOf as argv, FETCH_GLOBALS, SHA, SHA2, WRITE_FORMS } from './helpers/git-forms.js';

const ABS = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const ALLOWED = allowedForms(ABS);

/** Refusals beyond the shared write forms: grammar edges. */
const REFUSED: Array<[string, string[]]> = [
  ...WRITE_FORMS,
  ['fetch without --no-recurse-submodules', [...FETCH_GLOBALS, 'fetch', '--no-write-fetch-head', '--refmap=', '--no-tags', 'origin', SHA]],
  ['config --get-regexp', ['config', '--get-regexp', 'remote']],
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
