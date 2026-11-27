/**
 * #2008 — pull-request head commits fetched under the hidden `refs/codev/pr/`
 * namespace, exercised against REAL git repositories (no mocks):
 *
 *  - an "upstream" bare repo stands in for the forge. Its PR head is reachable
 *    only from a hidden ref (`uploadpack.hideRefs`), the way a fork PR's head is
 *    reachable on a forge, and it accepts SHA wants (`allowAnySHA1InWant`) the
 *    way GitHub/GitLab do;
 *  - a normal clone stands in for the reviewer's main checkout.
 *
 * Pins the acceptance criteria that are checkable without a live editor: the
 * head is fetched by SHA, no local branch appears, `git status` / `HEAD` are
 * unchanged, the file list is merge-base ↔ head (base-branch commits made after
 * the PR branched do NOT show), refs are pruned once a PR closes, and each
 * failure mode returns its own kind.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import {
  ensurePullRequestHead,
  prunePullRequestRefs,
  listPullRequestRefIds,
  pullRequestHeadRef,
  pullRequestBaseRef,
  isFullCommitSha,
  isSafePullRequestId,
} from '../pr-refs.js';
import { createPullRequestGitFixture, git, type PullRequestGitFixture } from './pr-git-fixture.js';

let fx: PullRequestGitFixture;
let local: string;
let headSha: string;
let mainForkPoint: string;

beforeAll(() => {
  fx = createPullRequestGitFixture();
  headSha = fx.headSha;
  mainForkPoint = fx.forkPoint;
});

afterAll(() => {
  fx.dispose();
});

describe('input validation', () => {
  it('accepts only full commit ids', () => {
    expect(isFullCommitSha('a'.repeat(40))).toBe(true);
    expect(isFullCommitSha('a'.repeat(64))).toBe(true);
    expect(isFullCommitSha('abc1234')).toBe(false);
    expect(isFullCommitSha('A'.repeat(40))).toBe(false);
    expect(isFullCommitSha(undefined)).toBe(false);
  });

  it('accepts only ref-safe PR ids', () => {
    expect(isSafePullRequestId('1896')).toBe(true);
    expect(isSafePullRequestId('a/b')).toBe(false);
    expect(isSafePullRequestId('1:refs/heads/x')).toBe(false);
    expect(isSafePullRequestId('')).toBe(false);
  });
});

describe('ensurePullRequestHead (real git)', () => {
  beforeEach(() => {
    local = fx.clone();
  });

  it('fetches the head by SHA under refs/codev/pr/ with no branch, no status change, HEAD untouched', async () => {
    const branchesBefore = git(local, 'branch', '--all', '--list');
    const statusBefore = git(local, 'status', '--porcelain');
    const headBefore = git(local, 'rev-parse', 'HEAD');
    // The PR head isn't in the clone (it was only on a hidden ref).
    expect(() => git(local, 'cat-file', '-e', `${headSha}^{commit}`)).toThrow();

    const result = await ensurePullRequestHead(local, { prId: '7', headSha, baseRefName: 'main' });

    expect(result).toEqual({ ok: true, mergeBase: mainForkPoint });
    expect(git(local, 'rev-parse', pullRequestHeadRef('7'))).toBe(headSha);
    expect(git(local, 'rev-parse', pullRequestBaseRef('7'))).toBe(git(local, 'rev-parse', 'origin/main'));
    expect(git(local, 'branch', '--all', '--list')).toBe(branchesBefore);
    expect(git(local, 'status', '--porcelain')).toBe(statusBefore);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('does not fetch again while the head is unchanged', async () => {
    await ensurePullRequestHead(local, { prId: '7', headSha, baseRefName: 'main' });
    // Point the remote somewhere unreachable: a second fetch would fail.
    git(local, 'remote', 'set-url', 'origin', join(fx.root, 'does-not-exist.git'));
    const again = await ensurePullRequestHead(local, { prId: '7', headSha, baseRefName: 'main' });
    expect(again).toEqual({ ok: true, mergeBase: mainForkPoint });
  });

  it('reports fetch-failed for a head the remote does not have', async () => {
    const result = await ensurePullRequestHead(local, { prId: '8', headSha: '1'.repeat(40), baseRefName: 'main' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.kind).toBe('fetch-failed');
  });

  it('reports base-missing when the base branch is not on the remote', async () => {
    const result = await ensurePullRequestHead(local, { prId: '7', headSha, baseRefName: 'no-such-branch' });
    expect(!result.ok && result.kind).toBe('base-missing');
  });

  it('rejects inputs that could reach a refspec', async () => {
    for (const pr of [
      { prId: '7:refs/heads/x', headSha, baseRefName: 'main' },
      { prId: '7', headSha: headSha.slice(0, 12), baseRefName: 'main' },
      { prId: '7', headSha, baseRefName: 'main:refs/heads/evil' },
      { prId: '7', headSha, baseRefName: '--upload-pack=x' },
    ]) {
      const result = await ensurePullRequestHead(local, pr);
      expect(!result.ok && result.kind).toBe('invalid-input');
    }
    expect(await listPullRequestRefIds(local)).toEqual(new Set());
  });

  it('reports shallow for a shallow clone and fetches nothing', async () => {
    const shallow = fx.clone(['--depth', '1']);
    const result = await ensurePullRequestHead(shallow, { prId: '7', headSha, baseRefName: 'main' });
    expect(!result.ok && result.kind).toBe('shallow');
    expect(await listPullRequestRefIds(shallow)).toEqual(new Set());
  });
});

describe('prunePullRequestRefs (real git)', () => {
  it('deletes the refs of PRs no longer open, and only those', async () => {
    local = fx.clone();
    await ensurePullRequestHead(local, { prId: '7', headSha, baseRefName: 'main' });
    // A second "PR" sharing the head, so two ids own refs.
    git(local, 'update-ref', pullRequestHeadRef('9'), headSha);
    expect(await listPullRequestRefIds(local)).toEqual(new Set(['7', '9']));

    const removed = await prunePullRequestRefs(local, new Set(['9']));

    expect(removed).toEqual(['7']);
    expect(await listPullRequestRefIds(local)).toEqual(new Set(['9']));
    expect(git(local, 'branch', '--list')).toContain('main');
  });
});

