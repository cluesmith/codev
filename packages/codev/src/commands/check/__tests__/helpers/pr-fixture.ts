/**
 * Pull-request fixtures for the `codev check pr` tests (Spec 1951): a builder branch pushed
 * to the fixture's origin, the `pr-view` JSON the forge would return for it, project
 * configuration, and a `pr-view` concept override that runs on every platform.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Fixture } from './git-fixture.js';

/** The `--json` field list the shipped github `pr-view` script asks `gh` for. */
export const PR_VIEW_FIELDS =
  'title,body,state,url,author,baseRefName,headRefName,additions,deletions,headRefOid,isDraft,mergeable,mergeStateStatus,mergeCommit,mergedAt,reviewDecision';

export const PR_NUMBER = 7;
export const PR_BRANCH = 'builder/spir-7';

/** What `gh pr view` returns for an open PR on `PR_BRANCH` → main with the given head. */
export function prView(head: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Feature 7',
    body: 'Does the thing.\n\nFixes #7',
    state: 'OPEN',
    url: 'https://example.invalid/pr/7',
    author: { login: 'builder' },
    baseRefName: 'main',
    headRefName: PR_BRANCH,
    additions: 1,
    deletions: 0,
    headRefOid: head,
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    mergeCommit: null,
    mergedAt: null,
    reviewDecision: null,
    ...overrides,
  };
}

export type Commits = Array<{ files: Record<string, string | null>; message: string }>;

/**
 * Create `branch` from `base` in a worktree under the main clone, commit, and push it to
 * origin. The local branch then matches the PR head.
 */
export function pushBranch(fx: Fixture, commits: Commits, branch = PR_BRANCH, base = 'main'): { dir: string; head: string } {
  const dir = fx.addWorktree(branch.replace(/\//g, '-'), branch, base);
  let head = fx.git(dir, 'rev-parse', 'HEAD').trim();
  for (const c of commits) head = fx.commit(dir, c.files, c.message);
  fx.git(dir, 'push', '-q', 'origin', branch);
  return { dir, head };
}

/** Push a commit to `branch` on origin from a second clone; the main clone never sees it. */
export function pushFromElsewhere(fx: Fixture, branch: string, files: Record<string, string | null>, message = `on ${branch}`): string {
  const other = otherClone(fx);
  fx.git(other, 'fetch', '-q', 'origin');
  const exists = fx.git(other, 'ls-remote', 'origin', `refs/heads/${branch}`).trim() !== '';
  fx.git(other, 'checkout', '-q', '-B', branch, exists ? `origin/${branch}` : 'origin/main');
  const sha = fx.commit(other, files, message);
  fx.git(other, 'push', '-q', 'origin', branch);
  return sha;
}

export function otherClone(fx: Fixture): string {
  const dir = path.join(fx.root, 'other');
  return fs.existsSync(dir) ? dir : fx.clone('other');
}

/** Write the main clone's `.codev/config.json`. Returns its path. */
export function writeConfig(fx: Fixture, config: Record<string, unknown>): string {
  const file = path.join(fx.main, '.codev', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}

/** Forward slashes, which both sh and Git Bash read in an absolute path. */
export function shPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export interface PrViewOverride {
  /** The absolute script path, to put in `forge["pr-view"]`. */
  script: string;
  /** The answer for every call, unless `answerOn` set one for that call. */
  answer(view: Record<string, unknown> | string): void;
  /** The answer for call `n` (1-based): the anchoring read is 1, the end-of-run re-read 2. */
  answerOn(n: number, view: Record<string, unknown> | string): void;
  /** A shell snippet run before answering call `n`. */
  runOn(n: number, snippet: string): void;
  calls(): number;
}

/**
 * A `pr-view` override: a `.sh` script outside the repository that answers from files and
 * counts its calls. Git Bash runs a bare `.sh` path on Windows, so it works everywhere.
 */
export function prViewOverride(fx: Fixture): PrViewOverride {
  const dir = path.join(fx.root, 'forge');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'pr-view.sh');
  const d = shPath(dir);
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `dir='${d}'`,
      'n=$(cat "$dir/count" 2>/dev/null || echo 0)',
      'n=$((n + 1))',
      'echo "$n" > "$dir/count"',
      '[ -f "$dir/run.$n.sh" ] && . "$dir/run.$n.sh"',
      'if [ -f "$dir/answer.$n.json" ]; then cat "$dir/answer.$n.json"; else cat "$dir/answer.json"; fi',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const text = (view: Record<string, unknown> | string): string => (typeof view === 'string' ? view : JSON.stringify(view));
  return {
    script,
    answer: (view) => fs.writeFileSync(path.join(dir, 'answer.json'), text(view)),
    answerOn: (n, view) => fs.writeFileSync(path.join(dir, `answer.${n}.json`), text(view)),
    runOn: (n, snippet) => fs.writeFileSync(path.join(dir, `run.${n}.sh`), `${snippet}\n`),
    calls: () => {
      const file = path.join(dir, 'count');
      return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf-8').trim()) : 0;
    },
  };
}

export interface Run {
  name: string;
  state: 'pass' | 'fail' | 'pending' | 'skipped' | 'neutral';
  url?: string;
  workflow?: string;
}

/** `n` passing runs named `ci-1` … `ci-n`. */
export function passing(n: number): Run[] {
  return Array.from({ length: n }, (_, i) => ({ name: `ci-${i + 1}`, state: 'pass' as const }));
}

export interface CommitChecksOverride {
  /** The absolute script path, to put in `forge["commit-checks"]`. */
  script: string;
  /** The runs on `sha` (or raw output). A commit with no answer gets the default. */
  answer(sha: string, runs: Run[] | string): void;
  /** The answer for every commit without one of its own; `[]` (no runs) until set. */
  answerAll(runs: Run[] | string): void;
  /** Make every call fail with exit 1. */
  fail(): void;
  /** Make every call hang, for the time limit. */
  hang(): void;
  /** The SHAs asked for, in order. */
  calls(): string[];
}

/** A `commit-checks` override answering per commit from files, like `prViewOverride`. */
export function commitChecksOverride(fx: Fixture): CommitChecksOverride {
  const dir = path.join(fx.root, 'forge-checks');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'commit-checks.sh');
  const d = shPath(dir);
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `dir='${d}'`,
      'printf \'%s\\n\' "$CODEV_COMMIT_SHA" >> "$dir/calls"',
      '[ -f "$dir/hang" ] && exec sleep 60',
      'if [ -f "$dir/fail" ]; then echo "commit-checks stub: forge unreachable" >&2; exit 1; fi',
      'if [ -f "$dir/$CODEV_COMMIT_SHA.json" ]; then cat "$dir/$CODEV_COMMIT_SHA.json"',
      'elif [ -f "$dir/default.json" ]; then cat "$dir/default.json"',
      "else echo '[]'; fi",
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const text = (runs: Run[] | string): string => (typeof runs === 'string' ? runs : JSON.stringify(runs));
  return {
    script,
    answer: (sha, runs) => fs.writeFileSync(path.join(dir, `${sha}.json`), text(runs)),
    answerAll: (runs) => fs.writeFileSync(path.join(dir, 'default.json'), text(runs)),
    fail: () => fs.writeFileSync(path.join(dir, 'fail'), ''),
    hang: () => fs.writeFileSync(path.join(dir, 'hang'), ''),
    calls: () => {
      const file = path.join(dir, 'calls');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean) : [];
    },
  };
}
