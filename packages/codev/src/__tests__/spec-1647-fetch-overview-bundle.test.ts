/**
 * Spec 1647 — `fetchForOverview('overview-bundle')` with the forge dispatcher spied:
 * the bundle's explicit limits and input, its contract check, and the 24 h post-filter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ForgeCommandResult } from '../lib/forge.js';

const { dispatcher } = vi.hoisted(() => ({
  dispatcher: vi.fn<(concept: string, env?: Record<string, string>, options?: object) => Promise<ForgeCommandResult>>(),
}));
vi.mock('../lib/forge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/forge.js')>();
  return { ...actual, executeForgeCommandDetailed: dispatcher };
});

import { fetchForOverview, OVERVIEW_BUNDLE_MAX_BUFFER, OVERVIEW_BUNDLE_TIMEOUT_MS } from '../lib/github.js';

const NOW = Date.parse('2026-11-27T12:00:00.500Z');
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

const PR = {
  number: 7, title: 'Open PR', url: 'https://example.test/pull/7', reviewDecision: 'APPROVED', body: '',
  // Open lists are never post-filtered, however old.
  createdAt: iso(NOW - 400 * HOUR), author: { login: 'alice' }, reviewRequests: [], isDraft: false,
};
const ISSUE = {
  number: 42, title: 'Open issue', url: 'https://example.test/issues/42', labels: [],
  createdAt: iso(NOW - 400 * HOUR), author: { login: 'bob' }, assignees: [],
};
const closed = (n: number, hoursAgo: number) => ({
  number: n, title: `Closed ${n}`, url: `https://example.test/issues/${n}`, labels: [],
  createdAt: iso(NOW - 400 * HOUR), closedAt: iso(NOW - hoursAgo * HOUR),
});
const merged = (n: number, hoursAgo: number) => ({
  number: n, title: `Merged ${n}`, url: `https://example.test/pull/${n}`, body: '',
  createdAt: iso(NOW - 400 * HOUR), mergedAt: iso(NOW - hoursAgo * HOUR), headRefName: `b${n}`,
});

const ok = (data: unknown): ForgeCommandResult => ({ data, error: null });

describe('fetchForOverview(overview-bundle) (Spec 1647)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    dispatcher.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('hands the dispatcher the 60 s / 40 MiB limits and a seconds-precision CODEV_SINCE_DATE 24 h back', async () => {
    dispatcher.mockResolvedValue(ok({ prs: [], issues: [], recentlyClosed: [], recentlyMerged: [] }));
    await fetchForOverview('overview-bundle', '/ws');
    expect(OVERVIEW_BUNDLE_TIMEOUT_MS).toBe(60_000);
    expect(OVERVIEW_BUNDLE_MAX_BUFFER).toBe(40 * 1024 * 1024);
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher).toHaveBeenCalledWith(
      'overview-bundle',
      { CODEV_SINCE_DATE: '2026-11-26T12:00:00Z' },
      { cwd: '/ws', timeoutMs: 60_000, maxBuffer: 40 * 1024 * 1024 },
    );
  });

  it.each([
    ['non-JSON (the dispatcher parses it to null)', null, 'not JSON'],
    ['an array', [], 'not an object'],
    ['a JSON scalar', 3, 'not an object'],
    ['a missing issues key', { prs: [], recentlyClosed: [], recentlyMerged: [] }, 'missing issues'],
    ['prs: "x"', { prs: 'x', issues: [], recentlyClosed: [], recentlyMerged: [] }, 'prs is neither an array nor null'],
    ['recentlyMerged: {}', { prs: [], issues: [], recentlyClosed: [], recentlyMerged: {} }, 'recentlyMerged is neither an array nor null'],
  ])('malformed output, %s, is a whole failure naming what is wrong', async (_label, output, reason) => {
    dispatcher.mockResolvedValue(ok(output));
    const result = await fetchForOverview('overview-bundle', '/ws');
    expect(result.data).toBeNull();
    expect(result.malformed).toBe(reason);
    expect(result.error).toEqual({
      message: `overview-bundle output malformed: ${reason}`, stderr: '', exitCode: 0, timedOut: false,
    });
  });

  it('passes a command failure through unchanged, with no malformed reason', async () => {
    const failure: ForgeCommandResult = {
      data: null,
      error: { message: 'Command failed', stderr: 'gh: API rate limit exceeded', exitCode: 1, timedOut: false },
    };
    dispatcher.mockResolvedValue(failure);
    const result = await fetchForOverview('overview-bundle', '/ws');
    expect(result).toEqual(failure);
    expect(result).not.toHaveProperty('malformed');
  });

  it('keeps null sections through the 24 h filter', async () => {
    dispatcher.mockResolvedValue(ok({ prs: null, issues: [ISSUE], recentlyClosed: null, recentlyMerged: null }));
    const result = await fetchForOverview('overview-bundle', '/ws');
    expect(result.error).toBeNull();
    expect(result.data).toEqual({ prs: null, issues: [ISSUE], recentlyClosed: null, recentlyMerged: null });
  });

  it('drops out-of-window items from both search sections and leaves the open lists alone', async () => {
    dispatcher.mockResolvedValue(ok({
      prs: [PR],
      issues: [ISSUE],
      recentlyClosed: [closed(1, 1), closed(2, 25), closed(3, 23.9)],
      recentlyMerged: [merged(4, 30), merged(5, 2)],
    }));
    const result = await fetchForOverview('overview-bundle', '/ws');
    expect(result.data).toEqual({
      prs: [PR],
      issues: [ISSUE],
      recentlyClosed: [closed(1, 1), closed(3, 23.9)],
      recentlyMerged: [merged(5, 2)],
    });
  });

  it('ignores extra top-level keys', async () => {
    dispatcher.mockResolvedValue(ok({ prs: [], issues: [], recentlyClosed: [], recentlyMerged: [], viewer: 'x' }));
    const result = await fetchForOverview('overview-bundle', '/ws');
    expect(result.data).toEqual({ prs: [], issues: [], recentlyClosed: [], recentlyMerged: [] });
  });
});
