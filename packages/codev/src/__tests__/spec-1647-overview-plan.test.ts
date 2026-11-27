/**
 * Spec 1647 Phase 2: how a workspace's overview fetches (bundle or four calls),
 * decided from configuration alone, and the hourly forge spend that mode costs.
 * `resolveOverviewPlan` runs on the real forge presets; the TTL coupling test
 * proves the cache and the projection read the same constants.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveOverviewPlan, type ForgeCommandResult, type ForgeConfig } from '../lib/forge.js';
import {
  INVALIDATE_DEBOUNCE_MS,
  LIST_TTL_MS,
  OVERVIEW_CONSTITUENTS,
  SEARCH_TTL_MS,
  projectHourlyForgeCalls,
  type OverviewPlan,
} from '../lib/overview-budget.js';
import { describeOverviewPlan, formatOverviewLine } from '../commands/doctor.js';

const { fake, dbState } = vi.hoisted(() => ({
  fake: { calls: [] as string[] },
  dbState: { globalDbPath: '' },
}));

vi.mock('../lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/github.js')>();
  return {
    ...actual,
    overviewBackend: () => 'gh',
    fetchForOverview: async (concept: string): Promise<ForgeCommandResult> => {
      fake.calls.push(concept);
      return { data: concept === 'user-identity' ? 'octocat' : [], error: null };
    },
  };
});
vi.mock('../agent-farm/db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent-farm/db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

import { OverviewCache } from '../agent-farm/servers/overview.js';

const ALL_FOUR = [...OVERVIEW_CONSTITUENTS];
const without = (concept: string) => ALL_FOUR.filter((c) => c !== concept);
const plan = (config: ForgeConfig | null | undefined) => resolveOverviewPlan(config);

describe('resolveOverviewPlan (Spec 1647, Desired State item 7)', () => {
  it('default github config is bundled with nothing bypassed', () => {
    for (const config of [undefined, null, {}, { provider: 'github' }]) {
      expect(plan(config), JSON.stringify(config)).toEqual({ mode: 'bundled', bypassed: [] });
    }
  });

  it('an overridden constituent keeps the four calls and names it', () => {
    expect(plan({ 'issue-list': 'my-issues' })).toEqual({
      mode: 'four-call',
      cause: { kind: 'constituents', overridden: ['issue-list'], disabled: [] },
      runnable: ALL_FOUR,
    });
  });

  it('a disabled constituent keeps the four calls and is not runnable', () => {
    expect(plan({ 'recently-merged': null })).toEqual({
      mode: 'four-call',
      cause: { kind: 'constituents', overridden: [], disabled: ['recently-merged'] },
      runnable: without('recently-merged'),
    });
  });

  it('overrides and disables are reported together', () => {
    expect(plan({ 'pr-list': 'my-prs', 'issue-list': 'my-issues', 'recently-closed': null })).toEqual({
      mode: 'four-call',
      cause: { kind: 'constituents', overridden: ['pr-list', 'issue-list'], disabled: ['recently-closed'] },
      runnable: without('recently-closed'),
    });
  });

  it('a project that disables overview-bundle gets the four calls', () => {
    expect(plan({ 'overview-bundle': null })).toEqual({
      mode: 'four-call', cause: { kind: 'bundle-disabled' }, runnable: ALL_FOUR,
    });
    // The project's own null is the reason, even where the preset also disables it.
    expect(plan({ provider: 'gitlab', 'overview-bundle': null })).toMatchObject({ cause: { kind: 'bundle-disabled' } });
  });

  it.each(['gitlab', 'gitea', 'linear', 'jira'])('the %s preset disables the bundle', (provider) => {
    expect(plan({ provider })).toEqual({
      mode: 'four-call', cause: { kind: 'preset-disabled', provider }, runnable: ALL_FOUR,
    });
  });

  it('hybrid trackers stay four-call with no other configuration (their issues are not GitHub\'s)', () => {
    for (const provider of ['linear', 'jira']) {
      expect(plan({ provider }).mode, provider).toBe('four-call');
    }
  });

  it('an overview-bundle override is used even on a preset that disables the bundle', () => {
    expect(plan({ provider: 'gitlab', 'overview-bundle': 'my-bundle' })).toEqual({ mode: 'bundled', bypassed: [] });
  });

  it('an overview-bundle override discloses the constituent settings it bypasses', () => {
    expect(plan({ 'overview-bundle': 'my-bundle', 'issue-list': 'my-issues' })).toEqual({
      mode: 'bundled', bypassed: [{ concept: 'issue-list', how: 'overridden' }],
    });
    expect(plan({ 'overview-bundle': 'my-bundle', 'issue-list': 'my-issues', 'recently-merged': null })).toEqual({
      mode: 'bundled',
      bypassed: [{ concept: 'issue-list', how: 'overridden' }, { concept: 'recently-merged', how: 'disabled' }],
    });
  });

  it('settings on concepts outside the overview do not change the mode', () => {
    expect(plan({ 'pr-view': 'my-view', 'team-activity': null })).toEqual({ mode: 'bundled', bypassed: [] });
  });
});

describe('projectHourlyForgeCalls (Spec 1647, Desired State item 9)', () => {
  it.each<[string, ForgeConfig | null, number, number]>([
    ['bundled', null, 20, 60],
    ['four-call, all four runnable', { 'pr-list': 'my-prs' }, 52, 132],
    ['four-call, recently-merged disabled', { 'recently-merged': null }, 46, 126],
    ['four-call, issue-list disabled', { 'issue-list': null }, 32, 72],
  ])('%s: %#', (_shape, config, idle, churn) => {
    expect(projectHourlyForgeCalls(plan(config))).toEqual({ idle, churn });
  });

  it('is computed from the cache constants', () => {
    const hour = 3_600_000;
    expect(projectHourlyForgeCalls({ mode: 'bundled', bypassed: [] })).toEqual({
      idle: hour / LIST_TTL_MS, churn: hour / INVALIDATE_DEBOUNCE_MS,
    });
    const searchesOnly: OverviewPlan = {
      mode: 'four-call', cause: { kind: 'constituents', overridden: [], disabled: [] }, runnable: ['recently-closed'],
    };
    expect(projectHourlyForgeCalls(searchesOnly)).toEqual({ idle: hour / SEARCH_TTL_MS, churn: hour / SEARCH_TTL_MS });
  });

  it('a four-call plan with nothing runnable costs nothing', () => {
    const none: OverviewPlan = {
      mode: 'four-call', cause: { kind: 'constituents', overridden: [], disabled: ALL_FOUR }, runnable: [],
    };
    expect(projectHourlyForgeCalls(none)).toEqual({ idle: 0, churn: 0 });
  });
});

describe('doctor overview line text (Spec 1647)', () => {
  it.each<[ForgeConfig | null, string]>([
    [null, 'bundled'],
    [{ 'overview-bundle': 'b', 'issue-list': 'i' }, 'bundled (overview-bundle override; bypasses the issue-list override)'],
    [{ 'overview-bundle': 'b', 'pr-list': 'p', 'issue-list': 'i', 'recently-merged': null },
      'bundled (overview-bundle override; bypasses the pr-list and issue-list overrides and the disabled recently-merged)'],
    [{ 'issue-list': 'i' }, 'four calls: issue-list overridden'],
    [{ 'recently-merged': null }, 'four calls: recently-merged disabled'],
    [{ 'pr-list': 'p', 'issue-list': 'i', 'recently-closed': null, 'recently-merged': null },
      'four calls: pr-list and issue-list overridden, recently-closed and recently-merged disabled'],
    [{ 'overview-bundle': null }, 'four calls: overview-bundle disabled'],
    [{ provider: 'gitlab' }, 'four calls: disabled by the gitlab preset'],
  ])('%j → %s', (config, reason) => {
    expect(describeOverviewPlan(plan(config))).toBe(reason);
  });

  it('appends the projection to the reason', () => {
    expect(formatOverviewLine(plan(null))).toBe('bundled — 20 forge calls/h idle, 60 under constant invalidation');
    expect(formatOverviewLine(plan({ 'issue-list': 'i' })))
      .toBe('four calls: issue-list overridden — 52 forge calls/h idle, 132 under constant invalidation');
  });
});

describe('OverviewCache reads the projected TTLs (Spec 1647)', () => {
  let tmpDir: string;
  let clock: number;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-1647-plan-'));
    dbState.globalDbPath = path.join(tmpDir, 'global.db');
    clock = 1_700_000_000_000;
    fake.calls.length = 0;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const count = (concept: string) => fake.calls.filter((c) => c === concept).length;

  it('refetches pr-list at exactly LIST_TTL_MS and recently-closed at exactly SEARCH_TTL_MS', async () => {
    const cache = new OverviewCache({ now: () => clock });
    const start = clock;
    await cache.getOverview(tmpDir);
    expect(count('pr-list')).toBe(1);

    clock = start + LIST_TTL_MS - 1;
    await cache.getOverview(tmpDir);
    expect(count('pr-list')).toBe(1);

    clock = start + LIST_TTL_MS;
    await cache.getOverview(tmpDir);
    expect(count('pr-list')).toBe(2);

    clock = start + SEARCH_TTL_MS - 1;
    await cache.getOverview(tmpDir);
    expect(count('recently-closed')).toBe(1);

    clock = start + SEARCH_TTL_MS;
    await cache.getOverview(tmpDir);
    expect(count('recently-closed')).toBe(2);
  });
});
