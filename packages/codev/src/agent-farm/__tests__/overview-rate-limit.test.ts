/**
 * Issue #1645 — OverviewCache spend controls: negative cache with backoff,
 * per-backend rate-limit suspension, single-flight, debounced list-only
 * invalidation. Each test pins one pitfall from the rebuild prescription and
 * goes red with its guard removed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveForgeBackend, type ForgeCommandResult } from '../../lib/forge.js';

type Concept = 'pr-list' | 'issue-list' | 'recently-closed' | 'recently-merged' | 'user-identity';
const LISTS: Concept[] = ['pr-list', 'issue-list', 'recently-closed', 'recently-merged'];
const RATE_LIMITED = 'gh: API rate limit already exceeded for user ID 12345';

const { fake, dbState } = vi.hoisted(() => ({
  fake: {
    backend: ((_concept: string, _cwd: string) => 'gh') as (concept: string, cwd: string) => string | null,
    behaviour: {} as Record<string, (cwd: string) => Promise<ForgeCommandResult>>,
    calls: [] as Array<{ concept: string; cwd: string }>,
  },
  dbState: { globalDbPath: '' },
}));

vi.mock('../../lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/github.js')>();
  return {
    ...actual,
    overviewBackend: (concept: string, cwd: string) => fake.backend(concept, cwd),
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

const realOverviewBackend = (concept: string, cwd: string) => resolveForgeBackend(concept, { cwd });

const ok = (data: unknown = []): ForgeCommandResult => ({ data, error: null });
const fail = (stderr: string): ForgeCommandResult => ({ data: null, error: { message: `Command failed: ${stderr}`, stderr, exitCode: 1 } });
const succeedAll = () => { for (const c of [...LISTS, 'user-identity']) fake.behaviour[c] = async () => ok(c === 'user-identity' ? 'octocat' : []); };
const rateLimitLists = () => { for (const c of LISTS) fake.behaviour[c] = async () => fail(RATE_LIMITED); };
const count = (concept: Concept, cwd?: string) => fake.calls.filter(c => c.concept === concept && (cwd === undefined || c.cwd === cwd)).length;
const listCalls = (cwd?: string) => LISTS.reduce((n, c) => n + count(c, cwd), 0);

let tmpDir: string;
let clock: number;
const now = () => clock;

describe('OverviewCache spend controls (#1645)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-1645-'));
    dbState.globalDbPath = path.join(tmpDir, 'global.db');
    clock = 1_700_000_000_000;
    fake.calls.length = 0;
    fake.backend = () => 'gh';
    succeedAll();
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('40 polls at 2.5 s against a rate-limited gh: one batch, then zero until reset', async () => {
    rateLimitLists();
    const cache = new OverviewCache({ now });
    let data = await cache.getOverview(tmpDir);
    for (let i = 1; i < 40; i++) {
      clock += 2_500;
      data = await cache.getOverview(tmpDir);
    }
    expect(listCalls()).toBe(4);
    expect(count('user-identity')).toBe(1);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.forgeResetAt).toBeDefined();
    expect(data.errors?.prs).toMatch(/gh rate limited until/);

    // Past the 15 min fallback: exactly one more batch.
    clock += 15 * 60_000;
    await cache.getOverview(tmpDir);
    expect(listCalls()).toBe(8);
  });

  it('a REST success (user-identity) does not clear a GraphQL suspension', async () => {
    rateLimitLists();
    const probe = async () => ({ remaining: 0, resetAt: clock + 2 * 3_600_000 });
    const cache = new OverviewCache({ now, probe });
    await cache.getOverview(tmpDir);
    await Promise.resolve();
    expect(count('user-identity')).toBe(1);

    // Identity TTL (1 h) expires inside the 2 h suspension; its success is REST evidence only.
    clock += 3_601_000;
    const data = await cache.getOverview(tmpDir);
    expect(count('user-identity')).toBe(2);
    expect(listCalls()).toBe(4);
    expect(data.forgeStatus).toBe('rate-limited');
  });

  it('a REST success does not reset the GraphQL failure backoff', async () => {
    for (const c of LISTS) fake.behaviour[c] = async () => fail('no git remotes found');
    const cache = new OverviewCache({ now });
    // t0: lists fail (window 1: 60 s); identity succeeds in the same batch — REST evidence,
    // which must leave the gh window alone. Were it reset, window 2 would be 60 s, not 120 s.
    await cache.getOverview(tmpDir);
    clock += 61_000;
    await cache.getOverview(tmpDir);            // t0+61: window 2 (120 s)
    expect(listCalls()).toBe(8);
    clock += 3_540_000;                          // t0+3601: identity TTL expires → REST success; window 3 (240 s)
    await cache.getOverview(tmpDir);
    expect(count('user-identity')).toBe(2);
    expect(listCalls()).toBe(12);
    clock += 121_000;                            // t0+3722: inside window 3 — a reset chain would retry here
    await cache.getOverview(tmpDir);
    expect(listCalls()).toBe(12);
    clock += 120_000;                            // t0+3842: window 3 elapsed → one retry
    await cache.getOverview(tmpDir);
    expect(listCalls()).toBe(16);
  });

  it('a REST failure does not suspend the GraphQL backend', async () => {
    fake.behaviour['user-identity'] = async () => fail(RATE_LIMITED);
    const cache = new OverviewCache({ now });
    const first = await cache.getOverview(tmpDir);
    expect(first.forgeStatus).toBe('ok');
    clock += 181_000;
    await cache.getOverview(tmpDir);
    expect(count('pr-list')).toBe(2);
    expect(count('issue-list')).toBe(2);
  });

  it('invalidate() clears neither a suspension nor the search and identity caches', async () => {
    const cache = new OverviewCache({ now });
    await cache.getOverview(tmpDir);
    clock += 181_000;
    rateLimitLists();
    const suspended = await cache.getOverview(tmpDir);
    expect(suspended.forgeStatus).toBe('rate-limited');
    expect(listCalls()).toBe(6);                 // pr-list + issue-list refetched; searches cached

    clock += 61_000;
    cache.invalidate();
    const after = await cache.getOverview(tmpDir);
    expect(after.forgeStatus).toBe('rate-limited');
    expect(after.forgeResetAt).toBe(suspended.forgeResetAt);
    expect(listCalls()).toBe(6);
    expect(count('user-identity')).toBe(1);
    expect(count('recently-closed')).toBe(1);
    expect(count('recently-merged')).toBe(1);
  });

  it('sustained invalidation (1/s for 5 min, two workspaces) stays under the debounced ceiling per workspace', async () => {
    const wsA = path.join(tmpDir, 'a'); fs.mkdirSync(wsA);
    const wsB = path.join(tmpDir, 'b'); fs.mkdirSync(wsB);
    const cache = new OverviewCache({ now });
    await cache.getOverview(wsA);
    await cache.getOverview(wsB);
    for (let s = 1; s <= 300; s++) {
      clock += 1_000;
      cache.invalidate();
      await cache.getOverview(wsA);
      if (s === 100 || s === 300) await cache.getOverview(wsB);
    }
    // Ceiling: one refetch per open list per 60 s per workspace, plus the initial batch.
    for (const ws of [wsA, wsB]) {
      expect(count('pr-list', ws)).toBeLessThanOrEqual(6);
      expect(count('recently-closed', ws)).toBe(1);
      expect(count('recently-merged', ws)).toBe(1);
      expect(count('user-identity', ws)).toBe(1);
    }
    expect(count('pr-list', wsA)).toBe(6);
    // B was invalidated and polled at 100 s and 300 s: A's refetch clock must not suppress it.
    expect(count('pr-list', wsB)).toBe(3);
  });

  it('two pollers plus an invalidation mid-flight produce one fetch per concept', async () => {
    const release: Array<() => void> = [];
    for (const c of [...LISTS, 'user-identity']) {
      fake.behaviour[c] = () => new Promise(resolve => release.push(() => resolve(ok(c === 'user-identity' ? 'octocat' : []))));
    }
    const cache = new OverviewCache({ now });
    const a = cache.getOverview(tmpDir);
    const b = cache.getOverview(tmpDir);
    await Promise.resolve();
    clock += 1;
    cache.invalidate();
    const c = cache.getOverview(tmpDir);
    expect(release).toHaveLength(5);
    release.forEach(r => r());
    await Promise.all([a, b, c]);
    succeedAll();
    clock += 2_500;
    await cache.getOverview(tmpDir);
    for (const concept of [...LISTS, 'user-identity'] as Concept[]) expect(count(concept)).toBe(1);
  });

  it("a Linear workspace's pr-list (falls through to gh) suspends gh, not linear", async () => {
    fs.mkdirSync(path.join(tmpDir, '.codev'));
    fs.writeFileSync(path.join(tmpDir, '.codev', 'config.json'), JSON.stringify({ forge: { provider: 'linear' } }));
    fake.backend = realOverviewBackend;
    expect(realOverviewBackend('pr-list', tmpDir)).toBe('gh');
    expect(realOverviewBackend('issue-list', tmpDir)).toBe('linear');
    fake.behaviour['pr-list'] = async () => fail(RATE_LIMITED);

    const cache = new OverviewCache({ now });
    const first = await cache.getOverview(tmpDir);
    expect(first.forgeStatus).toBe('rate-limited');
    clock += 181_000;
    await cache.getOverview(tmpDir);
    expect(count('issue-list')).toBe(2);         // linear budget untouched
    expect(count('pr-list')).toBe(1);            // gh suspended
  });

  it('a later credible probe with an earlier reset shortens the suspension', async () => {
    rateLimitLists();
    let resolveProbe!: (r: { remaining: number; resetAt: number }) => void;
    const probe = () => new Promise<{ remaining: number; resetAt: number }>(resolve => { resolveProbe = resolve; });
    const cache = new OverviewCache({ now, probe });
    const start = clock;
    const first = await cache.getOverview(tmpDir);
    expect(first.forgeResetAt).toBe(new Date(start + 15 * 60_000).toISOString());

    resolveProbe({ remaining: 0, resetAt: start + 5 * 60_000 });
    await new Promise(r => setTimeout(r, 0));
    clock += 2_500;
    const shortened = await cache.getOverview(tmpDir);
    expect(shortened.forgeResetAt).toBe(new Date(start + 5 * 60_000).toISOString());

    clock = start + 5 * 60_000 + 1_000;
    await cache.getOverview(tmpDir);
    expect(listCalls()).toBe(8);
  });

  it('ignores a probe that claims budget remains (gh api rate_limit misreports a healthy bucket)', async () => {
    rateLimitLists();
    const cache = new OverviewCache({ now, probe: async () => ({ remaining: 5000, resetAt: clock + 60_000 }) });
    const start = clock;
    await cache.getOverview(tmpDir);
    await new Promise(r => setTimeout(r, 0));
    clock += 120_000;
    const data = await cache.getOverview(tmpDir);
    expect(data.forgeResetAt).toBe(new Date(start + 15 * 60_000).toISOString());
    expect(listCalls()).toBe(4);
  });
});
