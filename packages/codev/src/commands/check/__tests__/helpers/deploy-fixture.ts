/**
 * Fixtures for the `codev check deploy` tests (Spec 1951): PRs merged into the fixture's
 * origin, the `pr-view` JSON the forge returns for a merged PR, a deploy branch, and a
 * `workflow-runs` concept override that runs on every platform.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Fixture } from './git-fixture.js';
import { prView, pushBranch, shPath } from './pr-fixture.js';

export const MERGED_AT = '2026-11-22T17:30:00Z';

export interface MergedPr {
  number: number;
  branch: string;
  head: string;
  /** The merge commit on main, pushed to origin. */
  merge: string;
  /** main's tip before the merge. */
  before: string;
}

/**
 * Push a one-commit branch for PR `number`, merge it into main with a merge commit, and push
 * main. The main clone has every commit; `pushFromElsewhere` makes ones it lacks.
 */
export function mergePr(fx: Fixture, number: number, file = `src/pr-${number}.ts`): MergedPr {
  const branch = `builder/spir-${number}`;
  const before = fx.git(fx.main, 'rev-parse', 'HEAD').trim();
  const { head } = pushBranch(fx, [{ files: { [file]: `export const n = ${number};\n` }, message: `PR ${number}` }], branch);
  fx.git(fx.main, 'merge', '-q', '--no-ff', '-m', `Merge PR #${number}`, branch);
  fx.git(fx.main, 'push', '-q', 'origin', 'main');
  return { number, branch, head, merge: fx.git(fx.main, 'rev-parse', 'HEAD').trim(), before };
}

/** What `gh pr view` returns for a merged PR. */
export function mergedView(pr: MergedPr, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return prView(pr.head, {
    title: `Feature ${pr.number}`,
    body: `Fixes #${pr.number}`,
    state: 'MERGED',
    headRefName: pr.branch,
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
    mergeCommit: { oid: pr.merge },
    mergedAt: MERGED_AT,
    ...overrides,
  });
}

/** Point `branch` on origin at `sha` (pushed from the main clone, which already has it). */
export function setRemoteBranch(fx: Fixture, branch: string, sha: string): void {
  fx.git(fx.main, 'push', '-q', '--force', 'origin', `${sha}:refs/heads/${branch}`);
}

export interface WorkflowRun {
  headSha: string;
  status: string;
  conclusion: string | null;
  url: string;
  createdAt: string;
}

export function run(headSha: string, conclusion: string | null, createdAt = '2026-11-22T18:04:00Z', status = 'completed'): WorkflowRun {
  return { headSha, status, conclusion, url: `https://example.invalid/runs/${headSha.slice(0, 7)}`, createdAt };
}

export const green = (headSha: string, createdAt?: string): WorkflowRun => run(headSha, 'success', createdAt);

export interface WorkflowRunsOverride {
  /** The absolute script path, to put in `forge["workflow-runs"]`. */
  script: string;
  /** The runs every call returns (or raw output); `[]` until set. */
  answer(runs: WorkflowRun[] | string): void;
  fail(): void;
  hang(): void;
  /** `<CODEV_WORKFLOW> <CODEV_BRANCH>` for each call, in order. */
  calls(): string[];
}

/** A `workflow-runs` override answering from a file and recording what it was asked for. */
export function workflowRunsOverride(fx: Fixture): WorkflowRunsOverride {
  const dir = path.join(fx.root, 'forge-runs');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'workflow-runs.sh');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `dir='${shPath(dir)}'`,
      'printf \'%s %s\\n\' "$CODEV_WORKFLOW" "$CODEV_BRANCH" >> "$dir/calls"',
      '[ -f "$dir/hang" ] && exec sleep 60',
      'if [ -f "$dir/fail" ]; then echo "workflow-runs stub: forge unreachable" >&2; exit 1; fi',
      "if [ -f \"$dir/runs.json\" ]; then cat \"$dir/runs.json\"; else echo '[]'; fi",
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return {
    script,
    answer: (runs) => fs.writeFileSync(path.join(dir, 'runs.json'), typeof runs === 'string' ? runs : JSON.stringify(runs)),
    fail: () => fs.writeFileSync(path.join(dir, 'fail'), ''),
    hang: () => fs.writeFileSync(path.join(dir, 'hang'), ''),
    calls: () => {
      const file = path.join(dir, 'calls');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean) : [];
    },
  };
}
