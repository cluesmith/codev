/**
 * Spec 1951 — the porch-only rule and the choice of the code runs (§ Porch-only heads),
 * as pure tables: the lookups come from a map, so each case names exactly which commits
 * were asked for, what the `checks` line reads, and the verdict.
 */

import { describe, expect, it } from 'vitest';
import type { CommitCheckItem } from '../../../lib/forge-contracts.js';
import {
  checksProblem,
  checksResult,
  isPorchOnly,
  MAX_LOOKUPS,
  parseCommitChecks,
  parseParents,
  selectCodeRuns,
  type RunsLookup,
  type Selection,
} from '../porch-only.js';
import { summarizeRuns, type CommitRuns } from '../report.js';

const sha = (c: string): string => c.repeat(40);
const H = sha('a');
const T = sha('b');
const C = sha('c');

const pass = (name: string): CommitCheckItem => ({ name, state: 'pass' });
const fail = (name: string): CommitCheckItem => ({ name, state: 'fail' });
const pending = (name: string): CommitCheckItem => ({ name, state: 'pending' });
const green = [pass('build'), pass('unit'), pass('lint')];

function table(runs: Record<string, CommitCheckItem[]>): { lookup: RunsLookup } {
  return { lookup: async (s) => ({ ok: true, value: summarizeRuns(s, runs[s] ?? []) }) };
}

async function select(range: string[], runs: Record<string, CommitCheckItem[]>): Promise<Selection> {
  const result = await selectCodeRuns(range, table(runs).lookup);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}

describe('Spec 1951 — what is porch-only', () => {
  it('one parent and only codev/projects/ paths', () => {
    expect(isPorchOnly(1, ['codev/projects/1951-x/status.yaml'])).toBe(true);
    expect(isPorchOnly(1, ['codev/projects/1951-x/status.yaml', 'codev/projects/1951-x/1951-review-iter1.md'])).toBe(true);
    // An empty commit changes no code either.
    expect(isPorchOnly(1, [])).toBe(true);
  });

  it('anything outside codev/projects/, a merge, or a root commit is code', () => {
    expect(isPorchOnly(1, ['codev/projects/1951-x/status.yaml', 'src/a.ts'])).toBe(false);
    expect(isPorchOnly(1, ['codev/state/spir-1951_thread.md'])).toBe(false);
    expect(isPorchOnly(1, ['codev/projects.md'])).toBe(false);
    expect(isPorchOnly(2, ['codev/projects/1951-x/status.yaml'])).toBe(false);
    expect(isPorchOnly(0, [])).toBe(false);
  });

  it('parses rev-list --parents, refusing anything but SHAs', () => {
    expect(parseParents(`${H} ${T}\n${T} ${C} ${sha('d')}\n${C}\n`)).toEqual([
      { sha: H, parents: [T] },
      { sha: T, parents: [C, sha('d')] },
      { sha: C, parents: [] },
    ]);
    expect(() => parseParents('not-a-sha\n')).toThrow(/not a commit SHA/);
  });
});

describe('Spec 1951 — commit-checks output', () => {
  it('accepts the contract, url and workflow optional', () => {
    const items = [{ name: 'unit', state: 'pass', url: 'https://x.invalid/1', workflow: 'test.yml' }, { name: 'lint', state: 'neutral' }];
    expect(parseCommitChecks(items)).toEqual({ ok: true, value: items });
    expect(parseCommitChecks([])).toEqual({ ok: true, value: [] });
  });

  it.each([
    ['an object', { name: 'unit' }, 'commit-checks returned something other than a JSON array'],
    ['an item without a name', [{ state: 'pass' }], 'commit-checks item 1 has no name'],
    ['an unknown state', [{ name: 'unit', state: 'success' }], 'commit-checks item 1 (unit) has state "success", not one of pass/fail/pending/skipped/neutral'],
    ['a url that is not text', [{ name: 'unit', state: 'pass', url: 3 }], 'commit-checks item 1 (unit) has a url that is not a string'],
    ['a non-object item', ['unit'], 'commit-checks item 1 is not an object'],
  ])('refuses %s, naming the concept', (_name, data, reason) => {
    expect(parseCommitChecks(data)).toEqual({ ok: false, reason });
  });
});

describe('Spec 1951 — Scenario 7: choosing the code runs', () => {
  it('runs only on the code commit: two lines, ok', async () => {
    const range = [H, T, C];
    const selection = await select(range, { [C]: green });
    expect(selection.queried).toEqual([H, T, C]);
    expect(checksResult(range, selection)).toMatchObject({
      status: 'ok',
      summary: 'code ccccccc: 3 passed\nhead aaaaaaa: no runs — 2 porch-state commits above the code',
      details: { lastCodeCommit: C, porchOnlyAbove: 2, code: { sha: C, passed: 3 }, head: { sha: H, runs: [] } },
    });
  });

  it('runs only on head, all passed: one line, ok, nothing else looked up', async () => {
    const range = [H, C];
    const selection = await select(range, { [H]: green });
    expect(selection.queried).toEqual([H]);
    expect(checksResult(range, selection)).toMatchObject({ status: 'ok', summary: 'head aaaaaaa: porch-only, 3 passed' });
  });

  it('runs on a push tip between them: the tip carries the code runs', async () => {
    const range = [H, T, C];
    const selection = await select(range, { [T]: green });
    expect(selection.queried).toEqual([H, T]);
    expect(checksResult(range, selection)).toMatchObject({
      status: 'ok',
      summary: 'code bbbbbbb: 3 passed\nhead aaaaaaa: no runs — 2 porch-state commits above the code',
      details: { code: { sha: T }, lastCodeCommit: C },
    });
  });

  it('no runs anywhere: attention (none), no code runs in the details', async () => {
    const range = [H, C];
    const result = checksResult(range, await select(range, {}));
    expect(result).toMatchObject({ status: 'attention', summary: 'code ccccccc: no runs\nhead aaaaaaa: no runs — 1 porch-state commit above the code' });
    expect(result.details).not.toHaveProperty('code');
    expect(checksProblem(result.details.head as CommitRuns, null)).toBe('none');
  });

  it('a failure on head while the code commit is green: attention (failed)', async () => {
    const range = [H, C];
    const selection = await select(range, { [H]: [pass('build'), fail('unit')], [C]: green });
    expect(checksResult(range, selection)).toMatchObject({
      status: 'attention',
      summary: 'code ccccccc: 3 passed\nhead aaaaaaa: porch-only, 1 passed, 1 failed (unit)',
    });
    expect(checksProblem(selection.head, selection.code)).toBe('failed');
  });

  it('head pending while the code is green: "still running" on head, attention (running)', async () => {
    const range = [H, T, C];
    const selection = await select(range, { [H]: [pending('build'), pending('unit'), pending('lint')], [C]: green });
    expect(checksResult(range, selection)).toMatchObject({
      status: 'attention',
      summary: 'code ccccccc: 3 passed\nhead aaaaaaa: porch-only, 3 still running',
    });
    expect(checksProblem(selection.head, selection.code)).toBe('running');
  });

  it('head pending while the code failed: attention (failed)', async () => {
    const range = [H, C];
    const selection = await select(range, { [H]: [pending('unit')], [C]: [pass('build'), fail('unit')] });
    expect(checksResult(range, selection).summary).toBe('code ccccccc: 1 passed, 1 failed (unit)\nhead aaaaaaa: porch-only, 1 still running');
    expect(checksProblem(selection.head, selection.code)).toBe('failed');
  });

  it('a complete older run wins over a pending newer one; failing that, the first with any runs', async () => {
    const range = [H, T, C];
    const complete = await select(range, { [T]: [pending('unit')], [C]: [pass('unit')] });
    expect(complete.code?.sha).toBe(C);

    const onlyPending = await select(range, { [T]: [pending('unit')], [C]: [] });
    expect(onlyPending.code?.sha).toBe(T);
    expect(checksProblem(onlyPending.head, onlyPending.code)).toBe('running');
  });

  it('head is the code commit: one line, its own runs decide', async () => {
    expect(checksResult([H], await select([H], { [H]: green }))).toMatchObject({ status: 'ok', summary: 'head aaaaaaa: 3 passed' });
    const none = checksResult([H], await select([H], {}));
    expect(none).toMatchObject({ status: 'attention', summary: 'head aaaaaaa: no runs', details: { porchOnlyAbove: 0 } });
    const running = await select([H], { [H]: [pass('a'), pending('b')] });
    expect(checksResult([H], running)).toMatchObject({ status: 'attention', summary: 'head aaaaaaa: 1 passed, 1 still running' });
    expect(checksProblem(running.head, running.code)).toBe('running');
  });

  it('skipped and neutral count as passed', async () => {
    const runs: CommitCheckItem[] = [pass('build'), { name: 'docs', state: 'skipped' }, { name: 'bot', state: 'neutral' }];
    expect(checksResult([H], await select([H], { [H]: runs }))).toMatchObject({ status: 'ok', summary: 'head aaaaaaa: 3 passed' });
  });

  it(`looks up at most ${MAX_LOOKUPS} commits, C always among them`, async () => {
    const porch = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(40));
    const range = [...porch, C];
    const selection = await select(range, {});
    expect(selection.queried).toHaveLength(MAX_LOOKUPS);
    expect(selection.queried[0]).toBe(porch[0]);
    expect(selection.queried[selection.queried.length - 1]).toBe(C);
    expect(selection.queried).not.toContain(porch[9]);
  });

  it('a lookup that fails stops the selection with its reason', async () => {
    const lookup: RunsLookup = async (s) => (s === T ? { ok: false, reason: 'commit-checks failed: HTTP 502' } : { ok: true, value: summarizeRuns(s, []) });
    expect(await selectCodeRuns([H, T, C], lookup)).toEqual({ ok: false, reason: 'commit-checks failed: HTTP 502' });
  });
});
