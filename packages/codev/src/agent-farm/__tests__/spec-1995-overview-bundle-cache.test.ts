/**
 * Spec 1995 — OverviewCache on the bundle path: one `overview-bundle` call per
 * open-list refresh, the 24 h windows riding along when due, #1645's failure,
 * rate-limit and single-flight guarantees, and the path selection rule.
 *
 * The forge is faked one level below `fetchForOverview`, at the concept
 * command, so the real conformance check and 24 h filter run on both paths.
 * The path is pinned per test (`fake.path`): no test here depends on a config
 * file on the machine running it. Scenario numbers are the spec's.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OVERVIEW_BUNDLE_CONSTITUENTS, getKnownProviders, resolveOverviewPath,
  type ForgeCommandResult, type ForgeConfig, type OverviewPath,
} from '../../lib/forge.js';
import type { IssueListItem, MergedPrItem, PrListItem } from '../../lib/forge-contracts.js';

interface Call { concept: string; includeWindows: boolean; at: number }
type Responder = (concept: string, includeWindows: boolean) => ForgeCommandResult | Promise<ForgeCommandResult>;

const { fake, dbState } = vi.hoisted(() => ({
  fake: {
    clock: 0,
    path: { kind: 'bundle' } as OverviewPath,
    realPath: null as unknown as (cwd: string) => OverviewPath,
    calls: [] as Call[],
    respond: null as unknown as Responder,
  },
  dbState: { globalDbPath: '' },
}));

vi.mock('../../lib/forge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/forge.js')>();
  return {
    ...actual,
    resolveForgeBackend: () => 'gh',
    executeForgeCommandDetailed: async (concept: string, env: Record<string, string> = {}) => {
      const includeWindows = env.CODEV_INCLUDE_WINDOWS === '1';
      fake.calls.push({ concept, includeWindows, at: fake.clock });
      return fake.respond(concept, includeWindows);
    },
  };
});
vi.mock('../../lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/github.js')>();
  fake.realPath = actual.overviewPath;
  return { ...actual, overviewPath: () => fake.path };
});
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

import { OverviewCache } from '../servers/overview.js';

// =============================================================================
// Fixtures
// =============================================================================

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const POLL = 2_500;
const LIST_TTL = 180 * SECOND;
const SEARCH_TTL = 600 * SECOND;
const RIDE_ALONG_AGE = SEARCH_TTL - LIST_TTL;
const RATE_LIMITED = 'gh: API rate limit already exceeded for user ID 12345';
const BUNDLE: OverviewPath = { kind: 'bundle' };
const FOUR_CALL: OverviewPath = { kind: 'four-call', reason: 'pinned by the test' };

/** An instant `ms` before the real now: the 24 h filter reads the real clock. */
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const pr = (n: number, o: Partial<PrListItem> = {}): PrListItem => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, reviewDecision: '', body: '',
  createdAt: '2026-11-20T00:00:00Z', author: { login: 'alice' }, reviewRequests: [], isDraft: false, ...o,
});
const issue = (n: number, o: Partial<IssueListItem> = {}): IssueListItem => ({
  number: n, title: `Issue ${n}`, url: `https://github.com/o/r/issues/${n}`, labels: [],
  createdAt: '2026-11-19T00:00:00Z', author: { login: 'bob' }, assignees: [], ...o,
});
const closed = (n: number, closedAgo: number, o: Partial<IssueListItem> = {}): IssueListItem => ({
  number: n, title: `Closed ${n}`, url: `https://github.com/o/r/issues/${n}`, labels: [],
  createdAt: '2026-11-01T00:00:00Z', closedAt: ago(closedAgo), ...o,
});
const merged = (n: number, mergedAgo: number, o: Partial<MergedPrItem> = {}): MergedPrItem => ({
  number: n, title: `Merged ${n}`, url: `https://github.com/o/r/pull/${n}`, body: '',
  createdAt: '2026-11-01T00:00:00Z', mergedAt: ago(mergedAgo), headRefName: `builder/spir-${n}`, ...o,
});

/** The repository state both paths read: what each concept, and the bundle, return. */
interface World { prs: PrListItem[]; issues: IssueListItem[]; closed: IssueListItem[]; merged: MergedPrItem[] }
const defaultWorld = (): World => ({ prs: [pr(1)], issues: [issue(10)], closed: [closed(20, HOUR)], merged: [merged(30, HOUR)] });

const ok = (data: unknown): ForgeCommandResult => ({ data, error: null });
const fail = (stderr: string): ForgeCommandResult => ({
  data: null, error: { message: `Command failed: ${stderr}`, stderr, exitCode: 1, timedOut: false },
});

function serve(world: World): Responder {
  return (concept, includeWindows) => {
    switch (concept) {
      case 'overview-bundle':
        return ok(includeWindows
          ? { prs: world.prs, issues: world.issues, recentlyClosed: world.closed, recentlyMerged: world.merged }
          : { prs: world.prs, issues: world.issues });
      case 'pr-list': return ok(world.prs);
      case 'issue-list': return ok(world.issues);
      case 'recently-closed': return ok(world.closed);
      case 'recently-merged': return ok(world.merged);
      case 'user-identity': return ok('octocat');
      default: throw new Error(`unexpected concept ${concept}`);
    }
  };
}

/** Bundle calls answer with `bundle`; everything else as `serve(defaultWorld())`. */
function bundleAnswers(bundle: (includeWindows: boolean) => ForgeCommandResult | Promise<ForgeCommandResult>): Responder {
  const rest = serve(defaultWorld());
  return (concept, includeWindows) => (concept === 'overview-bundle' ? bundle(includeWindows) : rest(concept, includeWindows));
}

const bundleCalls = () => fake.calls.filter(c => c.concept === 'overview-bundle');
const windowCalls = () => bundleCalls().filter(c => c.includeWindows);
const constituentCalls = () => fake.calls.filter(c => (OVERVIEW_BUNDLE_CONSTITUENTS as readonly string[]).includes(c.concept));
const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);

let ws: string;
let start: number;

const newCache = () => new OverviewCache({ now: () => fake.clock });
/** Poll every 2.5 s from the next tick up to `until` (relative to start), inclusive. */
async function pollUntil(cache: OverviewCache, until: number, each?: (t: number) => void): Promise<void> {
  while (fake.clock + POLL <= start + until) {
    fake.clock += POLL;
    each?.(fake.clock - start);
    await cache.getOverview(ws);
  }
}
/** One poll at `t` (relative to start). */
async function pollAt(cache: OverviewCache, t: number) {
  fake.clock = start + t;
  return cache.getOverview(ws);
}

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1995-cache-'));
  dbState.globalDbPath = path.join(ws, 'global.db');
  start = 1_700_000_000_000;
  fake.clock = start;
  fake.calls.length = 0;
  fake.path = BUNDLE;
  fake.respond = serve(defaultWorld());
});
afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

// =============================================================================
// Cadence
// =============================================================================

describe('Spec 1995 — bundle path cadence', () => {
  afterEach(() => {
    expect(constituentCalls()).toEqual([]);
  });

  it('cold cache: one bundle call that carries the windows and fills all four sections (1)', async () => {
    const data = await newCache().getOverview(ws);
    expect(bundleCalls()).toEqual([{ concept: 'overview-bundle', includeWindows: true, at: start }]);
    expect(data.pendingPRs.map(p => p.id)).toEqual(['1']);
    expect(data.backlog.map(b => b.id)).toEqual(['10']);
    expect(data.recentlyClosed.map(c => c.id)).toEqual(['20']);
    expect(data.forgeStatus).toBe('ok');
    expect(data.errors).toBeUndefined();
    expect(data.currentUser).toBe('octocat');
  });

  it('one idle hour of 2.5 s polls: 20 calls, the windows on every third (540 s apart), never 600 s old (2)', async () => {
    const cache = newCache();
    let maxWindowAge = 0;
    await cache.getOverview(ws);
    await pollUntil(cache, HOUR - POLL, () => {
      maxWindowAge = Math.max(maxWindowAge, fake.clock - windowCalls().at(-1)!.at);
    });

    expect(bundleCalls()).toHaveLength(20);
    expect(bundleCalls().map(c => c.at - start)).toEqual(Array.from({ length: 20 }, (_, i) => i * LIST_TTL));
    expect(bundleCalls().map(c => c.includeWindows)).toEqual(Array.from({ length: 20 }, (_, i) => i % 3 === 0));
    expect(gaps(windowCalls().map(c => c.at))).toEqual(Array(6).fill(3 * LIST_TTL));
    expect(maxWindowAge).toBeLessThan(SEARCH_TTL);
  });

  it('invalidation every 5 s for an hour: open lists at most once a minute, windows 420–480 s apart, never 600 s old (3)', async () => {
    const cache = newCache();
    let maxWindowAge = 0;
    cache.invalidate();
    await cache.getOverview(ws);
    await pollUntil(cache, HOUR - POLL, (t) => {
      if (t % (5 * SECOND) === 0) cache.invalidate();
      maxWindowAge = Math.max(maxWindowAge, fake.clock - windowCalls().at(-1)!.at);
    });

    const openGaps = gaps(bundleCalls().map(c => c.at));
    expect(Math.min(...openGaps)).toBeGreaterThanOrEqual(MINUTE);
    expect(bundleCalls()).toHaveLength(60);
    const windowGaps = gaps(windowCalls().map(c => c.at));
    expect(windowGaps.length).toBeGreaterThan(5);
    for (const gap of windowGaps) {
      expect(gap).toBeGreaterThanOrEqual(RIDE_ALONG_AGE);
      expect(gap).toBeLessThanOrEqual(RIDE_ALONG_AGE + MINUTE);
    }
    expect(maxWindowAge).toBeLessThan(SEARCH_TTL);
  });

  it('fresh open lists: no call, though the windows are past the ride-along age (4)', async () => {
    const cache = newCache();
    await cache.getOverview(ws);
    await pollUntil(cache, 3 * LIST_TTL - POLL);
    // Calls at 0 s (windows), 180 s and 360 s; from 420 s the windows would ride
    // along, but nothing is due until the open lists expire at 540 s.
    expect(bundleCalls().map(c => [c.at - start, c.includeWindows])).toEqual([
      [0, true], [LIST_TTL, false], [2 * LIST_TTL, false],
    ]);
    await pollAt(cache, 3 * LIST_TTL);
    expect(bundleCalls().at(-1)).toEqual({ concept: 'overview-bundle', includeWindows: true, at: start + 3 * LIST_TTL });
  });

  it('windows that keep failing never make a call: expired, inside their failure window, the cadence stays 180 s (4, 12)', async () => {
    const world = defaultWorld();
    fake.respond = bundleAnswers(includeWindows => ok(includeWindows && fake.clock > start
      ? { prs: world.prs, issues: world.issues, windowsError: 'search timed out' }
      : serve(world)('overview-bundle', includeWindows).data));
    const cache = newCache();
    await cache.getOverview(ws);
    await pollUntil(cache, HOUR - POLL);
    expect(bundleCalls().map(c => c.at - start)).toEqual(Array.from({ length: 20 }, (_, i) => i * LIST_TTL));
    expect((await pollAt(cache, HOUR - POLL)).recentlyClosed).toEqual([]);
  });

  it('the ride-along age is 420 s: carried at exactly 420 s, not at 419.999 s', async () => {
    // Open lists refetched at 240 s expire at 420 s, when the windows are 420 s old.
    let cache = newCache();
    await pollAt(cache, 0);
    await pollAt(cache, 240 * SECOND);
    await pollAt(cache, RIDE_ALONG_AGE);
    expect(bundleCalls().map(c => [c.at - start, c.includeWindows])).toEqual([[0, true], [240 * SECOND, false], [RIDE_ALONG_AGE, true]]);

    // An invalidation makes the open lists due 1 ms earlier.
    fake.calls.length = 0;
    cache = newCache();
    await pollAt(cache, 0);
    await pollAt(cache, 240 * SECOND);
    fake.clock += SECOND;
    cache.invalidate();
    await pollAt(cache, RIDE_ALONG_AGE - 1);
    expect(bundleCalls().map(c => [c.at - start, c.includeWindows])).toEqual([[0, true], [240 * SECOND, false], [RIDE_ALONG_AGE - 1, false]]);
  });

  it('concurrent polls and an invalidate() mid-flight share one bundle call (5)', async () => {
    const release: Array<() => void> = [];
    const answer = serve(defaultWorld());
    fake.respond = (concept, includeWindows) => new Promise(resolve => release.push(() => resolve(answer(concept, includeWindows))));
    const cache = newCache();
    const a = cache.getOverview(ws);
    const b = cache.getOverview(ws);
    await Promise.resolve();
    fake.clock += 1;
    cache.invalidate();
    const c = cache.getOverview(ws);
    expect(release).toHaveLength(2);              // the bundle and identity
    release.forEach(r => r());
    const results = await Promise.all([a, b, c]);
    for (const data of results) expect(data.pendingPRs.map(p => p.id)).toEqual(['1']);

    fake.respond = serve(defaultWorld());
    await pollAt(cache, POLL);
    expect(bundleCalls()).toHaveLength(1);
    expect(fake.calls.filter(call => call.concept === 'user-identity')).toHaveLength(1);
  });

  it('workspaces keep separate groups', async () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1995-cache-b-'));
    try {
      const cache = newCache();
      await cache.getOverview(ws);
      await cache.getOverview(other);
      await cache.getOverview(ws);
      expect(windowCalls()).toHaveLength(2);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// Payload parity (7)
// =============================================================================

describe('Spec 1995 — payload parity between the bundle and the four calls (7)', () => {
  function writeBuilder(dir: string, id: string): void {
    const project = path.join(ws, '.builders', dir, 'codev', 'projects', `${id}-feature`);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'status.yaml'), [`id: '${id}'`, 'protocol: spir', 'phase: implement', 'gates:'].join('\n'));
  }

  it('equal OverviewData from equivalent forge data', async () => {
    const world: World = {
      prs: [
        pr(1, { isDraft: true, title: '[Spec 42] Draft', body: 'Fixes #42', reviewDecision: '' }),
        pr(2, { author: { login: 'app/dependabot' }, reviewRequests: ['carol'], reviewDecision: 'APPROVED' }),
        pr(3, { author: undefined, reviewDecision: 'CHANGES_REQUESTED' }),
      ],
      issues: [
        issue(42, { title: 'Collapse the overview calls', labels: [{ name: 'area/tower' }] }),
        issue(43, { labels: [], assignees: [] }),
        issue(44, { labels: [{ name: 'bug' }], assignees: [{ login: 'dave' }] }),
        issue(45, { title: 'Unlabelled builder issue' }),
      ],
      closed: [
        closed(50, 20 * HOUR, { labels: [{ name: 'bug' }] }),
        closed(51, HOUR),
        closed(52, 8 * HOUR, { labels: [{ name: 'spec' }] }),
        closed(53, 25 * HOUR),
      ],
      merged: [
        merged(60, 2 * HOUR, { body: 'Fixes #51' }),
        merged(61, 25 * HOUR, { body: 'Fixes #52' }),
        merged(62, 3 * HOUR, { url: undefined, body: 'Fixes #50' }),
      ],
    };
    writeBuilder('spir-42-feature', '0042');
    writeBuilder('spir-45-other', '0045');
    fs.mkdirSync(path.join(ws, 'codev', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'codev', 'specs', '51-closed.md'), '# 51');
    fake.respond = serve(world);

    fake.path = BUNDLE;
    const bundled = await newCache().getOverview(ws);
    fake.path = FOUR_CALL;
    const fourCall = await newCache().getOverview(ws);

    expect(bundleCalls()).toHaveLength(1);
    expect(constituentCalls().map(c => c.concept).sort()).toEqual([...OVERVIEW_BUNDLE_CONSTITUENTS].sort());
    expect(bundled).toEqual(fourCall);
    // And the payload is the one these cases should produce.
    expect(bundled.pendingPRs.map(p => [p.id, p.isDraft, p.reviewStatus, p.author])).toEqual([
      ['1', true, 'REVIEW_REQUIRED', 'alice'], ['2', false, 'APPROVED', 'app/dependabot'], ['3', false, 'CHANGES_REQUESTED', undefined],
    ]);
    // 42 is linked to PR 1, so it leaves the backlog; 45 has a builder.
    expect(bundled.backlog.map(b => [b.id, b.hasBuilder, b.assignees])).toEqual([
      ['43', false, undefined], ['44', false, ['dave']], ['45', true, undefined],
    ]);
    expect(bundled.recentlyClosed.map(c => c.id)).toEqual(['51', '52', '50']);
    expect(bundled.recentlyClosed[0]).toMatchObject({ prUrl: 'https://github.com/o/r/pull/60', specPath: 'codev/specs/51-closed.md' });
    const builder = bundled.builders.find(b => b.issueId === '42')!;
    expect(builder).toMatchObject({ issueTitle: 'Collapse the overview calls', area: 'tower' });
    expect(bundled.forgeStatus).toBe('ok');
  });
});

// =============================================================================
// Failures (8–12)
// =============================================================================

describe('Spec 1995 — bundle failures', () => {
  afterEach(() => {
    // A failure never falls back to the four concepts.
    expect(constituentCalls()).toEqual([]);
  });

  it('a rate limit suspends gh: rate-limited with forgeResetAt, and no call until the reset (8)', async () => {
    fake.respond = bundleAnswers(() => fail(RATE_LIMITED));
    const cache = newCache();
    let data = await cache.getOverview(ws);
    for (let i = 1; i < 40; i++) data = await pollAt(cache, i * POLL);
    expect(bundleCalls()).toHaveLength(1);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.forgeResetAt).toBe(new Date(start + 15 * MINUTE).toISOString());
    expect(data.errors?.prs).toMatch(/^gh rate limited until/);
    expect(data.errors?.issues).toMatch(/^gh rate limited until/);

    await pollAt(cache, 15 * MINUTE);
    expect(bundleCalls()).toHaveLength(2);
  });

  it('a generic failure is cached for the escalating window (60 s, 120 s, 240 s), and a poll never escalates it (9)', async () => {
    fake.respond = bundleAnswers(() => fail('no git remotes found'));
    const cache = newCache();
    const data = await cache.getOverview(ws);
    await pollUntil(cache, 420 * SECOND);
    expect(bundleCalls().map(c => c.at - start)).toEqual([0, 60 * SECOND, 180 * SECOND, 420 * SECOND]);
    expect(data.forgeStatus).toBe('unavailable');
    expect(data.errors).toEqual({
      prs: 'gh CLI unavailable — could not fetch PRs',
      issues: 'gh CLI unavailable — could not fetch issues',
    });
    expect(data.pendingPRs).toEqual([]);
    expect(data.recentlyClosed).toEqual([]);
  });

  it.each([
    ['non-JSON output', null],
    ['issues missing', { prs: [] }],
    ['a requested window missing', { prs: [], issues: [], recentlyClosed: [] }],
    ['a non-conforming item', { prs: [{ number: 1 }], issues: [], recentlyClosed: [], recentlyMerged: [] }],
  ])('malformed output is a failure: %s (10)', async (_name, output) => {
    fake.respond = bundleAnswers(() => ok(output));
    const cache = newCache();
    const data = await cache.getOverview(ws);
    expect(data.forgeStatus).toBe('unavailable');
    expect(data.errors?.prs).toBe('gh CLI unavailable — could not fetch PRs');
    await pollAt(cache, 30 * SECOND);
    expect(bundleCalls()).toHaveLength(1);         // inside the failure window
  });

  it('an open-only failure keeps fresh windows served, empties them past 600 s, and the next call carries them (11, 4)', async () => {
    const world = defaultWorld();
    let failing = false;
    fake.respond = bundleAnswers(includeWindows => (failing ? fail('connection reset') : serve(world)('overview-bundle', includeWindows)));
    const cache = newCache();
    await cache.getOverview(ws);                     // windows fetched at 0 s

    // Nobody polls until 200 s. Three open-only failures follow: at 200 s, 260 s
    // (after the 60 s window) and 380 s (after 120 s), which opens a 240 s window
    // to 620 s, across the windows' 600 s expiry.
    failing = true;
    let data = await pollAt(cache, 200 * SECOND);
    expect(data.pendingPRs).toEqual([]);
    expect(data.recentlyClosed.map(c => c.id)).toEqual(['20']);
    await pollUntil(cache, 380 * SECOND);
    expect(bundleCalls().map(c => [c.at - start, c.includeWindows])).toEqual([
      [0, true], [200 * SECOND, false], [260 * SECOND, false], [380 * SECOND, false],
    ]);

    await pollUntil(cache, 600 * SECOND - POLL);
    expect(bundleCalls()).toHaveLength(4);
    expect((await pollAt(cache, 600 * SECOND - POLL)).recentlyClosed.map(c => c.id)).toEqual(['20']);
    data = await pollAt(cache, 600 * SECOND);
    expect(data.recentlyClosed).toEqual([]);
    expect(data.forgeStatus).toBe('unavailable');
    await pollUntil(cache, 620 * SECOND - POLL);
    expect(bundleCalls()).toHaveLength(4);

    failing = false;
    data = await pollAt(cache, 620 * SECOND);
    expect(bundleCalls().at(-1)).toEqual({ concept: 'overview-bundle', includeWindows: true, at: start + 620 * SECOND });
    expect(data.recentlyClosed.map(c => c.id)).toEqual(['20']);
    expect(data.forgeStatus).toBe('ok');
  });

  it('a failed invalidation-driven refresh keeps serving the still-fresh open lists until they expire (owner ruling)', async () => {
    let failing = false;
    const world = defaultWorld();
    fake.respond = bundleAnswers(includeWindows => (failing ? fail('connection reset') : serve(world)('overview-bundle', includeWindows)));
    const cache = newCache();
    await cache.getOverview(ws);

    failing = true;
    fake.clock += SECOND;
    cache.invalidate();
    let data = await pollAt(cache, MINUTE);
    expect(bundleCalls()).toHaveLength(2);
    expect(data.pendingPRs.map(p => p.id)).toEqual(['1']);
    expect(data.forgeStatus).toBe('ok');
    expect(data.errors).toBeUndefined();

    data = await pollAt(cache, LIST_TTL - POLL);
    expect(data.pendingPRs.map(p => p.id)).toEqual(['1']);
    data = await pollAt(cache, LIST_TTL);
    expect(data.pendingPRs).toEqual([]);
    expect(data.errors?.prs).toBe('gh CLI unavailable — could not fetch PRs');
  });

  it('a window-only error delivers the open lists and fails only the windows, which skip calls inside their own failure window (12)', async () => {
    const world = defaultWorld();
    let windowsFail = true;
    fake.respond = bundleAnswers(includeWindows => (includeWindows && windowsFail
      ? ok({ prs: world.prs, issues: world.issues, windowsError: 'Something went wrong while executing your query. This may be the result of a timeout' })
      : serve(world)('overview-bundle', includeWindows)));
    const cache = newCache();

    // 0 s: windows fail (window 60 s). 60 s: they fail again (window 120 s, to 180 s).
    let data = await cache.getOverview(ws);
    expect(data.pendingPRs.map(p => p.id)).toEqual(['1']);
    expect(data.backlog.map(b => b.id)).toEqual(['10']);
    expect(data.recentlyClosed).toEqual([]);
    expect(data.forgeStatus).toBe('unavailable');
    expect(data.errors).toBeUndefined();
    fake.clock += SECOND;
    cache.invalidate();
    await pollAt(cache, MINUTE);

    // 120 s: inside the windows' failure window, an invalidation-driven call skips them.
    windowsFail = false;
    fake.clock += SECOND;
    cache.invalidate();
    await pollAt(cache, 2 * MINUTE);
    // 180 s: the window has elapsed; the next call carries them.
    fake.clock += SECOND;
    cache.invalidate();
    data = await pollAt(cache, 3 * MINUTE);
    expect(bundleCalls().map(c => [c.at - start, c.includeWindows])).toEqual([
      [0, true], [MINUTE, true], [2 * MINUTE, false], [3 * MINUTE, true],
    ]);
    expect(data.recentlyClosed.map(c => c.id)).toEqual(['20']);
    expect(data.forgeStatus).toBe('ok');
  });

  it('a window-only error carrying a rate limit still suspends the budget (contract level)', async () => {
    const world = defaultWorld();
    fake.respond = bundleAnswers(() => ok({ prs: world.prs, issues: world.issues, windowsError: 'API rate limit exceeded' }));
    const cache = newCache();
    const data = await cache.getOverview(ws);
    expect(data.forgeStatus).toBe('rate-limited');
    expect(data.pendingPRs.map(p => p.id)).toEqual(['1']);
    await pollAt(cache, LIST_TTL);
    expect(bundleCalls()).toHaveLength(1);
  });
});

// =============================================================================
// Path selection (13–16)
// =============================================================================

describe('Spec 1995 — overview path selection (Decision 1)', () => {
  it('the default and github configs take the bundle', () => {
    expect(resolveOverviewPath(null)).toEqual(BUNDLE);
    expect(resolveOverviewPath({})).toEqual(BUNDLE);
    expect(resolveOverviewPath({ provider: 'github' })).toEqual(BUNDLE);
  });

  it('every non-github preset disables the bundle (13)', () => {
    const others = getKnownProviders().filter(p => p !== 'github');
    expect(others.sort()).toEqual(['gitea', 'gitlab', 'jira', 'linear']);
    for (const provider of others) {
      expect(resolveOverviewPath({ provider })).toEqual({ kind: 'four-call', reason: `provider ${provider} disables overview-bundle` });
    }
  });

  it('a constituent overridden or disabled in the project config takes the four calls (14)', () => {
    expect(resolveOverviewPath({ 'issue-list': 'my-issue-list --label team-a' }))
      .toEqual({ kind: 'four-call', reason: 'forge config overrides issue-list' });
    expect(resolveOverviewPath({ 'recently-merged': null }))
      .toEqual({ kind: 'four-call', reason: 'forge config disables recently-merged' });
    for (const concept of OVERVIEW_BUNDLE_CONSTITUENTS) {
      expect(resolveOverviewPath({ provider: 'github', [concept]: 'x' } as ForgeConfig).kind).toBe('four-call');
    }
    // Concepts the overview does not read change nothing.
    expect(resolveOverviewPath({ 'issue-view': 'my-view', 'pr-merge': null })).toEqual(BUNDLE);
  });

  it('a project disabling overview-bundle takes the four calls (15)', () => {
    expect(resolveOverviewPath({ 'overview-bundle': null }))
      .toEqual({ kind: 'four-call', reason: 'forge config disables overview-bundle' });
  });

  it("a project's own overview-bundle takes the bundle, on linear and jira too: their preset scripts are not overrides (16)", () => {
    expect(resolveOverviewPath({ 'overview-bundle': 'my-bundle' })).toEqual(BUNDLE);
    expect(resolveOverviewPath({ provider: 'linear', 'overview-bundle': 'my-bundle' })).toEqual(BUNDLE);
    expect(resolveOverviewPath({ provider: 'jira', 'overview-bundle': 'my-bundle' })).toEqual(BUNDLE);
    expect(resolveOverviewPath({ provider: 'gitlab', 'overview-bundle': 'my-bundle', 'pr-list': 'x' }))
      .toEqual({ kind: 'four-call', reason: 'forge config overrides pr-list' });
  });

  it('a config that fails to load selects the bundle, whose call then reports the config error', () => {
    fs.mkdirSync(path.join(ws, '.codev'));
    fs.writeFileSync(path.join(ws, '.codev', 'config.json'), '{ not json');
    expect(fake.realPath(ws)).toEqual(BUNDLE);
  });

  it('the four-call path makes the four concept calls and no bundle call (13–15)', async () => {
    fake.path = FOUR_CALL;
    const data = await newCache().getOverview(ws);
    expect(bundleCalls()).toEqual([]);
    expect(constituentCalls().map(c => c.concept).sort()).toEqual([...OVERVIEW_BUNDLE_CONSTITUENTS].sort());
    expect(data.recentlyClosed.map(c => c.id)).toEqual(['20']);
  });
});
