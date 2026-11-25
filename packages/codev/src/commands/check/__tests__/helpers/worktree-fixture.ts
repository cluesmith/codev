/**
 * Fixtures for the `codev check worktree` tests (Spec 1951): builder worktrees made with
 * `git worktree add` under the fixture's main clone, spawn's scaffold files, PRs merged into
 * origin by merge commit or squash, and a `pr-search` concept override that runs on every
 * platform.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GUARD_SCRIPT_RELPATH, GUARD_SETTINGS_RELPATH } from '../../../../agent-farm/utils/worktree-write-guard.js';
import type { Fixture } from './git-fixture.js';
import { prView, shPath } from './pr-fixture.js';

export const MERGED_AT = '2026-11-22T17:30:00Z';

/** The scaffold files spawn writes into a Claude builder's worktree. */
export const SCAFFOLD_FILES: readonly string[] = [
  '.builder-prompt.txt',
  '.builder-role.md',
  '.builder-start.sh',
  GUARD_SCRIPT_RELPATH,
  GUARD_SETTINGS_RELPATH,
];

export interface Builder {
  id: string;
  branch: string;
  dir: string;
  /** The local branch tip. */
  head: string;
}

/**
 * A builder worktree at `<main>/.builders/<id>` on `builder/<id>`, with one commit (a thread
 * file), spawn's scaffold files, and the branch pushed to origin unless `push` is false.
 */
export function addBuilder(fx: Fixture, id: string, options: { push?: boolean; files?: Record<string, string> } = {}): Builder {
  const branch = `builder/${id}`;
  const dir = path.join(fx.main, '.builders', id);
  fx.git(fx.main, 'worktree', 'add', '-q', '-b', branch, dir, 'main');
  const head = fx.commit(dir, options.files ?? { [`codev/state/${id}_thread.md`]: `# ${id}\n` }, `[${id}] work`);
  writeScaffold(dir);
  if (options.push !== false) fx.git(dir, 'push', '-q', 'origin', branch);
  return { id, branch, dir, head };
}

export function writeScaffold(dir: string): void {
  for (const rel of SCAFFOLD_FILES) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `scaffold ${rel}\n`);
  }
}

/** Write untracked (or ignored) files into a worktree without committing them. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/** Merge the builder's branch into main with a merge commit and push main. Returns the merge commit. */
export function mergeBuilder(fx: Fixture, builder: Builder): string {
  fx.git(fx.main, 'merge', '-q', '--no-ff', '-m', `Merge ${builder.branch}`, builder.branch);
  fx.git(fx.main, 'push', '-q', 'origin', 'main');
  return fx.git(fx.main, 'rev-parse', 'HEAD').trim();
}

/** Squash the builder's changes onto main as one new commit and push main. Returns it. */
export function squashBuilder(fx: Fixture, builder: Builder): string {
  fx.git(fx.main, 'merge', '-q', '--squash', builder.branch);
  fx.git(fx.main, 'commit', '-q', '-m', `${builder.id} (squashed)`);
  fx.git(fx.main, 'push', '-q', 'origin', 'main');
  return fx.git(fx.main, 'rev-parse', 'HEAD').trim();
}

export function deleteRemoteBranch(fx: Fixture, branch: string): void {
  fx.git(fx.main, 'push', '-q', 'origin', '--delete', branch);
}

/** What `gh pr view` returns for the builder's PR in `state`, its head the forge's `head`. */
export function builderView(builder: Builder, state: 'OPEN' | 'MERGED' | 'CLOSED', head = builder.head, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return prView(head, {
    title: `Builder ${builder.id}`,
    state,
    headRefName: builder.branch,
    mergedAt: state === 'MERGED' ? MERGED_AT : null,
    mergeCommit: null,
    ...overrides,
  });
}

export interface SearchItem {
  number: number;
  headRefName: string;
  baseRefName?: string;
  state?: string;
}

export interface PrSearchOverride {
  /** The absolute script path, to put in `forge["pr-search"]`. */
  script: string;
  /** The items every call returns (or raw output); `[]` until set. */
  answer(items: SearchItem[] | string): void;
  fail(): void;
  /** `CODEV_SEARCH_QUERY` for each call, in order. */
  calls(): string[];
}

/** A `pr-search` override answering from a file and recording each query. */
export function prSearchOverride(fx: Fixture): PrSearchOverride {
  const dir = path.join(fx.root, 'forge-search');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'pr-search.sh');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `dir='${shPath(dir)}'`,
      'printf \'%s\\n\' "$CODEV_SEARCH_QUERY" >> "$dir/calls"',
      'if [ -f "$dir/fail" ]; then echo "pr-search stub: forge unreachable" >&2; exit 1; fi',
      "if [ -f \"$dir/items.json\" ]; then cat \"$dir/items.json\"; else echo '[]'; fi",
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return {
    script,
    answer: (items) => fs.writeFileSync(path.join(dir, 'items.json'), typeof items === 'string' ? items : JSON.stringify(items)),
    fail: () => fs.writeFileSync(path.join(dir, 'fail'), ''),
    calls: () => {
      const file = path.join(dir, 'calls');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean) : [];
    },
  };
}
