/**
 * Spec 1647 — OverviewCache's bundle path: cache semantics and mode selection.
 *
 * `fetchForOverview` is faked; `overviewPlan` and `overviewBackend` are real, so each
 * workspace's mode and budget come from a real `.codev/config.json`. The four-call path's
 * #1645 behaviour is pinned by overview.test.ts and overview-rate-limit.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OverviewFetchResult } from '../../lib/github.js';
import type { OverviewBundleResult } from '../../lib/forge-contracts.js';
import { ForgeRateLimiter } from '../../lib/forge-rate-limit.js';
import { INVALIDATE_DEBOUNCE_MS, LIST_TTL_MS, OVERVIEW_CONSTITUENTS } from '../../lib/overview-budget.js';

const { fake, dbState } = vi.hoisted(() => ({
  fake: {
    behaviour: {} as Record<string, (cwd: string) => Promise<OverviewFetchResult>>,
    calls: [] as Array<{ concept: string; cwd: string }>,
  },
  dbState: { globalDbPath: '' },
}));

vi.mock('../../lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/github.js')>();
  return {
    ...actual,
    fetchForOverview: (concept: string, cwd: string) => {
      fake.calls.push({ concept, cwd });
      return fake.behaviour[concept](cwd);
    },
  };
});
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

import { OverviewCache } from '../servers/overview.js';

const RATE_LIMITED = 'gh: API rate limit already exceeded for user ID 12345';
const CONSTITUENTS: readonly string[] = OVERVIEW_CONSTITUENTS;

const PR = {
  number: 7, title: 'Add the widget', url: 'https://example.test/pull/7', reviewDecision: 'APPROVED',
  body: 'Part of the widget work', createdAt: '2026-11-20T00:00:00Z', author: { login: 'alice' },
  reviewRequests: ['carol'], isDraft: false,
};
const ISSUE = {
  number: 42, title: 'Widget is slow', url: 'https://example.test/issues/42', labels: [{ name: 'bug' }],
  createdAt: '2026-11-19T00:00:00Z', author: { login: 'bob' }, assignees: [{ login: 'dave' }],
};
const CLOSED = {
  number: 41, title: 'Widget crashes', url: 'https://example.test/issues/41', labels: [{ name: 'bug' }],
  createdAt: '2026-11-18T00:00:00Z', closedAt: '2026-11-26T10:00:00Z',
};
const MERGED = {
  number: 8, title: 'Fix the crash', url: 'https://example.test/pull/8', body: 'Fixes #41',
  createdAt: '2026-11-25T00:00:00Z', mergedAt: '2026-11-26T10:00:00Z', headRefName: 'fix-41',
};

const bundle = (over: Partial<OverviewBundleResult> = {}): OverviewBundleResult => ({
  prs: [PR], issues: [ISSUE], recentlyClosed: [CLOSED], recentlyMerged: [MERGED], ...over,
});
const ok = (data: unknown): OverviewFetchResult => ({ data, error: null });
const fail = (stderr: string, extra: Partial<OverviewFetchResult['error'] & object> = {}): OverviewFetchResult => ({
  data: null,
  error: { message: `Command failed: ${stderr}`, stderr, exitCode: 1, timedOut: false, ...extra },
});

/** Every concept succeeds with the fixture data, in either mode. */
function succeedAll(): void {
  fake.behaviour = {
    'overview-bundle': async () => ok(bundle()),
    'pr-list': async () => ok([PR]),
    'issue-list': async () => ok([ISSUE]),
    'recently-closed': async () => ok([CLOSED]),
    'recently-merged': async () => ok([MERGED]),
    'user-identity': async () => ok('octocat'),
  };
}

const count = (concept: string, cwd?: string) =>
  fake.calls.filter(c => c.concept === concept && (cwd === undefined || c.cwd === cwd)).length;
const constituentCalls = () => fake.calls.filter(c => CONSTITUENTS.includes(c.concept)).length;

let tmpDir: string;
let clock: number;
const now = () => clock;

/** A workspace with an optional `forge` section in its `.codev/config.json`. */
function workspace(name: string, forge?: Record<string, string | null>): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(dir, '.codev'), { recursive: true });
  if (forge) fs.writeFileSync(path.join(dir, '.codev', 'config.json'), JSON.stringify({ forge }));
  return dir;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1647-cache-'));
  dbState.globalDbPath = path.join(tmpDir, 'global.db');
  clock = Date.parse('2026-11-26T12:00:00Z');
  fake.calls.length = 0;
  succeedAll();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
describe('OverviewCache bundle path: cache semantics (Spec 1647)', () => {
  it('one bundle invocation per TTL, plus the identity call, and no constituent', async () => {
    const ws = workspace('a');
    const cache = new OverviewCache({ now });
    const start = clock;
    const data = await cache.getOverview(ws);
    for (let i = 1; i < 20; i++) {
      clock += 2_500;
      await cache.getOverview(ws);
    }
    expect(count('overview-bundle')).toBe(1);
    expect(count('user-identity')).toBe(1);
    expect(constituentCalls()).toBe(0);
    expect(data.forgeStatus).toBe('ok');
    expect(data.errors).toBeUndefined();
    expect(data.pendingPRs.map(p => p.id)).toEqual(['7']);
    expect(data.backlog.map(b => b.id)).toEqual(['42']);
    expect(data.recentlyClosed).toEqual([expect.objectContaining({ id: '41', prUrl: MERGED.url })]);

    clock = start + LIST_TTL_MS;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(2);
  });

  it('invalidation refetches the bundle at most once per debounce window', async () => {
    const ws = workspace('a');
    const cache = new OverviewCache({ now });
    const start = clock;
    await cache.getOverview(ws);
    for (let t = 1_000; t < INVALIDATE_DEBOUNCE_MS; t += 5_000) {
      clock = start + t;
      cache.invalidate();
      await cache.getOverview(ws);
    }
    expect(count('overview-bundle')).toBe(1);
    clock = start + INVALIDATE_DEBOUNCE_MS;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(2);

    // Invalidated again at once: the new entry waits out its own debounce window.
    clock += 1;
    cache.invalidate();
    clock = start + 2 * INVALIDATE_DEBOUNCE_MS - 1;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(2);
    clock = start + 2 * INVALIDATE_DEBOUNCE_MS;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(3);
  });

  it('two pollers plus an invalidation mid-flight share one invocation', async () => {
    const ws = workspace('a');
    let release!: () => void;
    fake.behaviour['overview-bundle'] = () => new Promise(resolve => { release = () => resolve(ok(bundle())); });
    const cache = new OverviewCache({ now });
    const first = cache.getOverview(ws);
    const second = cache.getOverview(ws);
    clock += 1_000;
    cache.invalidate();
    const third = cache.getOverview(ws);
    await Promise.resolve();
    release();
    const results = await Promise.all([first, second, third]);
    expect(count('overview-bundle')).toBe(1);
    for (const data of results) expect(data.pendingPRs.map(p => p.id)).toEqual(['7']);
  });

  it('a bundle with recentlyClosed: null is a success, positively cached for the full TTL', async () => {
    const ws = workspace('a');
    const noteSuccess = vi.spyOn(ForgeRateLimiter.prototype, 'noteSuccess');
    fake.behaviour['overview-bundle'] = async () => ok(bundle({ recentlyClosed: null }));
    const cache = new OverviewCache({ now });
    const start = clock;
    const data = await cache.getOverview(ws);
    expect(noteSuccess).toHaveBeenCalledWith('gh', start);
    expect(data.forgeStatus).toBe('unavailable');
    expect(data.errors).toBeUndefined();
    expect(data.recentlyClosed).toEqual([]);
    expect(data.pendingPRs.map(p => p.id)).toEqual(['7']);
    expect(data.backlog.map(b => b.id)).toEqual(['42']);

    clock = start + LIST_TTL_MS - 1;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(1);
    clock = start + LIST_TTL_MS;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(2);
  });

  it('a successful bundle with a null section resets the failure window', async () => {
    const ws = workspace('a');
    const cache = new OverviewCache({ now });
    const start = clock;
    fake.behaviour['overview-bundle'] = async () => fail('no git remotes found');
    await cache.getOverview(ws); // window 1: 60 s
    clock = start + 60_000;
    fake.behaviour['overview-bundle'] = async () => ok(bundle({ recentlyMerged: null }));
    await cache.getOverview(ws); // success: TTL 180 s
    expect(count('overview-bundle')).toBe(2);
    clock = start + 60_000 + LIST_TTL_MS;
    fake.behaviour['overview-bundle'] = async () => fail('no git remotes found');
    await cache.getOverview(ws); // fails again: window back to 60 s, not escalated to 120 s
    clock += 60_000;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(4);
  });

  it('a null list from an override reads "overview-bundle returned no …", never "CLI unavailable"', async () => {
    const ws = workspace('a', { 'overview-bundle': 'my-bundle' });
    fake.behaviour['overview-bundle'] = async () => ok(bundle({ prs: null, issues: null }));
    const data = await new OverviewCache({ now }).getOverview(ws);
    expect(data.errors).toEqual({
      prs: 'overview-bundle returned no PRs',
      issues: 'overview-bundle returned no issues',
    });
    expect(data.forgeStatus).toBe('unavailable');
    expect(data.recentlyClosed.map(r => r.id)).toEqual(['41']);
  });

  it('malformed output: a whole failure whose reason is named on every poll of an escalating window', async () => {
    const ws = workspace('a');
    fake.behaviour['overview-bundle'] = async () => ({
      data: null,
      error: { message: 'overview-bundle output malformed: missing issues', stderr: '', exitCode: 0, timedOut: false },
      malformed: 'missing issues',
    });
    const cache = new OverviewCache({ now });
    const start = clock;
    const expected = {
      prs: 'overview-bundle output malformed (missing issues) — could not fetch PRs',
      issues: 'overview-bundle output malformed (missing issues) — could not fetch issues',
    };

    const first = await cache.getOverview(ws);
    expect(first.errors).toEqual(expected);
    expect(first.forgeStatus).toBe('unavailable');
    expect(first.pendingPRs).toEqual([]);
    expect(first.backlog).toEqual([]);
    expect(first.recentlyClosed).toEqual([]);

    clock = start + 30_000; // inside window 1 (60 s): served from the negative entry
    expect((await cache.getOverview(ws)).errors).toEqual(expected);
    expect(count('overview-bundle')).toBe(1);

    clock = start + 60_000; // window 1 elapsed: one retry, still malformed → window 2 (120 s)
    expect((await cache.getOverview(ws)).errors).toEqual(expected);
    expect(count('overview-bundle')).toBe(2);
    clock = start + 60_000 + 119_999;
    expect((await cache.getOverview(ws)).errors).toEqual(expected);
    expect(count('overview-bundle')).toBe(2);
    clock = start + 60_000 + 120_000;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(3);
    expect(constituentCalls()).toBe(0);
  });

  it('issues disabled (empty issues and recentlyClosed, PRs present): empty backlog, no error, ok', async () => {
    const ws = workspace('a');
    fake.behaviour['overview-bundle'] = async () => ok(bundle({ issues: [], recentlyClosed: [] }));
    const data = await new OverviewCache({ now }).getOverview(ws);
    expect(data.backlog).toEqual([]);
    expect(data.recentlyClosed).toEqual([]);
    expect(data.pendingPRs.map(p => p.id)).toEqual(['7']);
    expect(data.errors).toBeUndefined();
    expect(data.forgeStatus).toBe('ok');
  });

  it('workspace A rate-limited: negative entry, blank sections, suspended budget, no constituent', async () => {
    const a = workspace('a');
    fake.behaviour['overview-bundle'] = async () => fail(RATE_LIMITED);
    const cache = new OverviewCache({ now });
    const data = await cache.getOverview(a);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.forgeResetAt).toBeDefined();
    expect(data.errors?.prs).toMatch(/^gh rate limited until \S+ — PRs unavailable$/);
    expect(data.errors?.issues).toMatch(/^gh rate limited until \S+ — issues unavailable$/);
    expect(data.pendingPRs).toEqual([]);
    expect(data.backlog).toEqual([]);
    expect(data.recentlyClosed).toEqual([]);

    // Suspended: polls make no call at all, bundle or constituent.
    for (let i = 0; i < 10; i++) {
      clock += 2_500;
      await cache.getOverview(a);
    }
    expect(count('overview-bundle')).toBe(1);
    expect(constituentCalls()).toBe(0);
  });

  it("during A's suspension, B's bundle inside its TTL (plain or invalidated) is served without a fetch", async () => {
    const a = workspace('a');
    const b = workspace('b');
    fake.behaviour['overview-bundle'] = async (cwd) => (cwd === a ? fail(RATE_LIMITED) : ok(bundle()));
    const cache = new OverviewCache({ now });
    const start = clock;
    await cache.getOverview(b);
    clock += 1_000;
    await cache.getOverview(a);

    clock = start + 10_000;
    const plain = await cache.getOverview(b);
    expect(plain.forgeStatus).toBe('rate-limited');
    expect(plain.pendingPRs.map(p => p.id)).toEqual(['7']);
    expect(plain.backlog.map(i => i.id)).toEqual(['42']);
    expect(plain.recentlyClosed.map(r => r.id)).toEqual(['41']);

    cache.invalidate();
    clock = start + INVALIDATE_DEBOUNCE_MS + 1_000; // invalidated and past the debounce, still inside the TTL
    const invalidated = await cache.getOverview(b);
    expect(invalidated.forgeStatus).toBe('rate-limited');
    expect(invalidated.pendingPRs.map(p => p.id)).toEqual(['7']);
    expect(count('overview-bundle', b)).toBe(1);
  });

  it("during A's suspension, B's expired bundle reads empty, without a fetch", async () => {
    const a = workspace('a');
    const b = workspace('b');
    fake.behaviour['overview-bundle'] = async (cwd) => (cwd === a ? fail(RATE_LIMITED) : ok(bundle()));
    const cache = new OverviewCache({ now });
    const start = clock;
    await cache.getOverview(b);
    clock += 1_000;
    await cache.getOverview(a);

    clock = start + LIST_TTL_MS;
    const data = await cache.getOverview(b);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.pendingPRs).toEqual([]);
    expect(data.backlog).toEqual([]);
    expect(data.recentlyClosed).toEqual([]);
    expect(data.errors?.prs).toMatch(/^gh rate limited until/);
    expect(count('overview-bundle', b)).toBe(1);
    expect(constituentCalls()).toBe(0);
  });

  it('a non-rate-limit failure (exit 1): negative entry, escalating window, text naming gh', async () => {
    const ws = workspace('a');
    fake.behaviour['overview-bundle'] = async () => fail('no git remotes found');
    const cache = new OverviewCache({ now });
    const start = clock;
    const data = await cache.getOverview(ws);
    expect(data.forgeStatus).toBe('unavailable');
    expect(data.errors).toEqual({
      prs: 'gh CLI unavailable — could not fetch PRs',
      issues: 'gh CLI unavailable — could not fetch issues',
    });
    clock = start + 59_999;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(1);
    clock = start + 60_000; // window 1 over → retry, fails → window 2 (120 s)
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(2);
    clock = start + 60_000 + 119_999;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(2);
    clock = start + 180_000;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(3);
  });

  it('a timed-out bundle is a whole failure, negatively cached, with no constituent spawned', async () => {
    const ws = workspace('a');
    fake.behaviour['overview-bundle'] = async () => fail('', { exitCode: null, timedOut: true, message: 'Command timed out' });
    const cache = new OverviewCache({ now });
    const data = await cache.getOverview(ws);
    expect(data.forgeStatus).toBe('unavailable');
    expect(data.pendingPRs).toEqual([]);
    expect(data.backlog).toEqual([]);
    expect(data.errors?.prs).toBe('gh CLI unavailable — could not fetch PRs');
    clock += 30_000;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(1);
    expect(constituentCalls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('OverviewCache mode selection from .codev/config.json (Spec 1647)', () => {
  const pollTwice = async (ws: string) => {
    const cache = new OverviewCache({ now });
    const data = await cache.getOverview(ws);
    clock += 2_500;
    await cache.getOverview(ws);
    return data;
  };

  it.each(['gitlab', 'gitea', 'linear', 'jira'])('the %s preset makes the four calls; the bundle never runs', async (provider) => {
    const ws = workspace(provider, { provider });
    await pollTwice(ws);
    expect(count('overview-bundle')).toBe(0);
    for (const concept of CONSTITUENTS) expect(count(concept), concept).toBe(1);
  });

  it('an overridden issue-list keeps the four calls, the override among them', async () => {
    const ws = workspace('a', { 'issue-list': 'my-issues' });
    const data = await pollTwice(ws);
    expect(count('overview-bundle')).toBe(0);
    for (const concept of CONSTITUENTS) expect(count(concept), concept).toBe(1);
    expect(data.backlog.map(b => b.id)).toEqual(['42']);
  });

  it('recently-merged: null keeps the four calls, minus the disabled one: no issue-to-PR links, unavailable', async () => {
    const ws = workspace('a', { 'recently-merged': null });
    const data = await pollTwice(ws);
    expect(count('overview-bundle')).toBe(0);
    expect(count('recently-merged')).toBe(0);
    for (const concept of ['pr-list', 'issue-list', 'recently-closed']) expect(count(concept), concept).toBe(1);
    expect(data.recentlyClosed).toEqual([expect.objectContaining({ id: '41' })]);
    expect(data.recentlyClosed[0]).not.toHaveProperty('prUrl');
    expect(data.forgeStatus).toBe('unavailable');
    expect(data.errors).toBeUndefined(); // OverviewData has no errors key for the searches
  });

  it('issue-list: null reads "forge concept disabled"', async () => {
    const ws = workspace('a', { 'issue-list': null });
    const data = await pollTwice(ws);
    expect(count('overview-bundle')).toBe(0);
    expect(count('issue-list')).toBe(0);
    expect(data.errors).toEqual({ issues: 'forge concept disabled — issues unavailable' });
  });

  it('overview-bundle: null makes the four calls', async () => {
    const ws = workspace('a', { 'overview-bundle': null });
    await pollTwice(ws);
    expect(count('overview-bundle')).toBe(0);
    for (const concept of CONSTITUENTS) expect(count(concept), concept).toBe(1);
  });

  it('an overview-bundle override on gitlab runs once per window and feeds all four sections', async () => {
    const ws = workspace('a', { provider: 'gitlab', 'overview-bundle': 'my-bundle' });
    const cache = new OverviewCache({ now });
    const start = clock;
    const data = await cache.getOverview(ws);
    clock += 2_500;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(1);
    expect(constituentCalls()).toBe(0);
    expect(data.pendingPRs.map(p => p.id)).toEqual(['7']);
    expect(data.backlog.map(b => b.id)).toEqual(['42']);
    expect(data.recentlyClosed).toEqual([expect.objectContaining({ id: '41', prUrl: MERGED.url })]);
    expect(data.forgeStatus).toBe('ok');
    clock = start + LIST_TTL_MS;
    await cache.getOverview(ws);
    expect(count('overview-bundle')).toBe(2);
  });

  it('a merged PR without a url (optional on its contract) links nothing, in either mode', async () => {
    const { url: _url, ...mergedWithoutUrl } = MERGED;
    fake.behaviour['overview-bundle'] = async () => ok(bundle({ recentlyMerged: [mergedWithoutUrl] }));
    fake.behaviour['recently-merged'] = async () => ok([mergedWithoutUrl]);
    for (const ws of [workspace('bundled'), workspace('four-call', { 'overview-bundle': null })]) {
      const data = await new OverviewCache({ now }).getOverview(ws);
      expect(data.recentlyClosed.map(r => r.id)).toEqual(['41']);
      expect(data.recentlyClosed[0]).not.toHaveProperty('prUrl');
    }
  });

  it('the payload is the same in both modes for the same data, key set included', async () => {
    const bundled = await new OverviewCache({ now }).getOverview(workspace('bundled'));
    const fourCall = await new OverviewCache({ now }).getOverview(workspace('four-call', { 'overview-bundle': null }));
    expect(count('overview-bundle')).toBe(1);
    expect(Object.keys(fourCall).sort()).toEqual(Object.keys(bundled).sort());
    expect(fourCall).toEqual(bundled);
  });
});
