/**
 * Issue #1645 — OverviewCache spend controls: negative cache with backoff,
 * per-backend rate-limit suspension, single-flight, debounced list-only
 * invalidation. Each test pins one pitfall from the rebuild prescription and
 * goes red with its guard removed.
 *
 * Spec 1995: the suite runs on both overview paths. On the bundle path a batch
 * is one `overview-bundle` call, against four list calls, and the 24 h searches
 * are the windows a bundle call carries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveForgeBackend, type ForgeCommandResult, type OverviewPath } from '../../lib/forge.js';

type Concept = 'pr-list' | 'issue-list' | 'recently-closed' | 'recently-merged' | 'user-identity' | 'overview-bundle';
const LISTS: Concept[] = ['pr-list', 'issue-list', 'recently-closed', 'recently-merged'];
const RATE_LIMITED = 'gh: API rate limit already exceeded for user ID 12345';

const { fake, dbState } = vi.hoisted(() => ({
  fake: {
    backend: ((_concept: string, _cwd: string) => 'gh') as (concept: string, cwd: string) => string | null,
    path: ((_cwd: string) => ({ kind: 'bundle' })) as (cwd: string) => OverviewPath,
    realPath: null as unknown as (cwd: string) => OverviewPath,
    behaviour: {} as Record<string, (cwd: string, includeWindows: boolean) => Promise<ForgeCommandResult>>,
    calls: [] as Array<{ concept: string; cwd: string; includeWindows: boolean }>,
  },
  dbState: { globalDbPath: '' },
}));

vi.mock('../../lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/github.js')>();
  fake.realPath = actual.overviewPath;
  return {
    ...actual,
    overviewBackend: (concept: string, cwd: string) => fake.backend(concept, cwd),
    overviewPath: (cwd: string) => fake.path(cwd),
    fetchForOverview: (concept: string, cwd: string, options: { includeWindows?: boolean } = {}) => {
      const includeWindows = options.includeWindows === true;
      fake.calls.push({ concept, cwd, includeWindows });
      return fake.behaviour[concept](cwd, includeWindows);
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
const bundleOk = async (_cwd: string, includeWindows: boolean) =>
  ok(includeWindows ? { prs: [], issues: [], recentlyClosed: [], recentlyMerged: [] } : { prs: [], issues: [] });
const succeedAll = () => {
  for (const c of [...LISTS, 'user-identity']) fake.behaviour[c] = async () => ok(c === 'user-identity' ? 'octocat' : []);
  fake.behaviour['overview-bundle'] = bundleOk;
};
const rateLimitLists = () => { for (const c of [...LISTS, 'overview-bundle']) fake.behaviour[c] = async () => fail(RATE_LIMITED); };
const count = (concept: Concept, cwd?: string) => fake.calls.filter(c => c.concept === concept && (cwd === undefined || c.cwd === cwd)).length;

let tmpDir: string;
let clock: number;
const now = () => clock;

function setUp(): void {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-1645-'));
  dbState.globalDbPath = path.join(tmpDir, 'global.db');
  clock = 1_700_000_000_000;
  fake.calls.length = 0;
  fake.backend = () => 'gh';
  succeedAll();
}

const PATHS: OverviewPath[] = [{ kind: 'bundle' }, { kind: 'four-call', reason: 'pinned by the test' }];

describe.each(PATHS)('OverviewCache spend controls (#1645), $kind path', (overviewPath) => {
  const bundle = overviewPath.kind === 'bundle';
  /** Forge calls one batch of the four lists costs on this path. */
  const perBatch = bundle ? 1 : 4;
  /** Every list call on this path: bundle calls, or the four concepts. */
  const listCalls = (cwd?: string) => (bundle ? count('overview-bundle', cwd) : LISTS.reduce((n, c) => n + count(c, cwd), 0));
  /** Open-list fetches: bundle calls, or `pr-list` calls (each with an `issue-list` twin). */
  const openFetches = (cwd?: string) => {
    if (bundle) return count('overview-bundle', cwd);
    expect(count('issue-list', cwd)).toBe(count('pr-list', cwd));
    return count('pr-list', cwd);
  };
  /** 24 h window fetches: bundle calls carrying the windows, or `recently-closed` calls (each with a `recently-merged` twin). */
  const windowFetches = (cwd?: string) => {
    if (bundle) return fake.calls.filter(c => c.concept === 'overview-bundle' && c.includeWindows && (cwd === undefined || c.cwd === cwd)).length;
    expect(count('recently-merged', cwd)).toBe(count('recently-closed', cwd));
    return count('recently-closed', cwd);
  };

  beforeEach(() => {
    setUp();
    fake.path = () => overviewPath;
  });
  afterEach(() => {
    try {
      // Nothing on one path may ever reach the other's concepts.
      if (bundle) expect(LISTS.reduce((n, c) => n + count(c), 0)).toBe(0);
      else expect(count('overview-bundle')).toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('40 polls at 2.5 s against a rate-limited gh: one batch, then zero until reset', async () => {
    rateLimitLists();
    const cache = new OverviewCache({ now });
    let data = await cache.getOverview(tmpDir);
    for (let i = 1; i < 40; i++) {
      clock += 2_500;
      data = await cache.getOverview(tmpDir);
    }
    expect(listCalls()).toBe(perBatch);
    expect(count('user-identity')).toBe(1);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.forgeResetAt).toBeDefined();
    expect(data.errors?.prs).toMatch(/gh rate limited until/);

    // Past the 15 min fallback: exactly one more batch.
    clock += 15 * 60_000;
    await cache.getOverview(tmpDir);
    expect(listCalls()).toBe(2 * perBatch);
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
    expect(listCalls()).toBe(perBatch);
    expect(data.forgeStatus).toBe('rate-limited');
  });

  it('a REST success does not reset the GraphQL failure backoff', async () => {
    for (const c of [...LISTS, 'overview-bundle']) fake.behaviour[c] = async () => fail('no git remotes found');
    const cache = new OverviewCache({ now });
    // t0: lists fail (window 1: 60 s); identity succeeds in the same batch — REST evidence,
    // which must leave the gh window alone. Were it reset, window 2 would be 60 s, not 120 s.
    await cache.getOverview(tmpDir);
    clock += 61_000;
    await cache.getOverview(tmpDir);            // t0+61: window 2 (120 s)
    expect(listCalls()).toBe(2 * perBatch);
    clock += 3_540_000;                          // t0+3601: identity TTL expires → REST success; window 3 (240 s)
    await cache.getOverview(tmpDir);
    expect(count('user-identity')).toBe(2);
    expect(listCalls()).toBe(3 * perBatch);
    clock += 121_000;                            // t0+3722: inside window 3 — a reset chain would retry here
    await cache.getOverview(tmpDir);
    expect(listCalls()).toBe(3 * perBatch);
    clock += 120_000;                            // t0+3842: window 3 elapsed → one retry
    await cache.getOverview(tmpDir);
    expect(listCalls()).toBe(4 * perBatch);
  });

  it('a REST failure does not suspend the GraphQL backend', async () => {
    fake.behaviour['user-identity'] = async () => fail(RATE_LIMITED);
    const cache = new OverviewCache({ now });
    const first = await cache.getOverview(tmpDir);
    expect(first.forgeStatus).toBe('ok');
    clock += 181_000;
    await cache.getOverview(tmpDir);
    expect(openFetches()).toBe(2);
  });

  it('invalidate() clears neither a suspension nor the search and identity caches', async () => {
    const cache = new OverviewCache({ now });
    await cache.getOverview(tmpDir);
    clock += 181_000;
    rateLimitLists();
    const suspended = await cache.getOverview(tmpDir);
    expect(suspended.forgeStatus).toBe('rate-limited');
    expect(openFetches()).toBe(2);               // open lists refetched; searches cached
    expect(windowFetches()).toBe(1);

    clock += 61_000;
    cache.invalidate();
    const after = await cache.getOverview(tmpDir);
    expect(after.forgeStatus).toBe('rate-limited');
    expect(after.forgeResetAt).toBe(suspended.forgeResetAt);
    expect(openFetches()).toBe(2);
    expect(count('user-identity')).toBe(1);
    expect(windowFetches()).toBe(1);
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
      expect(openFetches(ws)).toBeLessThanOrEqual(6);
      expect(windowFetches(ws)).toBe(1);
      expect(count('user-identity', ws)).toBe(1);
    }
    expect(openFetches(wsA)).toBe(6);
    // B was invalidated and polled at 100 s and 300 s: A's refetch clock must not suppress it.
    expect(openFetches(wsB)).toBe(3);
  });

  it('two pollers plus an invalidation mid-flight produce one fetch per concept', async () => {
    const release: Array<() => void> = [];
    for (const c of [...LISTS, 'user-identity']) {
      fake.behaviour[c] = () => new Promise(resolve => release.push(() => resolve(ok(c === 'user-identity' ? 'octocat' : []))));
    }
    fake.behaviour['overview-bundle'] = (cwd, includeWindows) => new Promise(resolve => release.push(() => resolve(bundleOk(cwd, includeWindows))));
    const cache = new OverviewCache({ now });
    const a = cache.getOverview(tmpDir);
    const b = cache.getOverview(tmpDir);
    await Promise.resolve();
    clock += 1;
    cache.invalidate();
    const c = cache.getOverview(tmpDir);
    expect(release).toHaveLength(perBatch + 1);
    release.forEach(r => r());
    await Promise.all([a, b, c]);
    succeedAll();
    clock += 2_500;
    await cache.getOverview(tmpDir);
    const concepts: Concept[] = bundle ? ['overview-bundle', 'user-identity'] : [...LISTS, 'user-identity'];
    for (const concept of concepts) expect(count(concept)).toBe(1);
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
    expect(listCalls()).toBe(2 * perBatch);
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
    expect(listCalls()).toBe(perBatch);
  });
});

// The path here comes from the real resolver, read from the workspace's config.
describe('OverviewCache spend controls (#1645), hybrid provider', () => {
  beforeEach(() => {
    setUp();
    fake.path = fake.realPath;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it("a Linear workspace's pr-list (falls through to gh) suspends gh, not linear", async () => {
    fs.mkdirSync(path.join(tmpDir, '.codev'));
    fs.writeFileSync(path.join(tmpDir, '.codev', 'config.json'), JSON.stringify({ forge: { provider: 'linear' } }));
    expect(fake.realPath(tmpDir)).toEqual({ kind: 'four-call', reason: 'provider linear disables overview-bundle' });
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
});
