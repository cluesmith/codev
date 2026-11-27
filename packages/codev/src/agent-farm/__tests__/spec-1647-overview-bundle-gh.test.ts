/**
 * Spec 1647 — the bundle path end to end: the real OverviewCache, forge layer and github
 * concept scripts against the fake `gh` in src/__tests__/helpers/spec-1647-fake-gh.ts,
 * answering from the state recorded in src/__tests__/fixtures/spec-1647-overview-bundle.
 *
 * Pins:
 *   1. Process counts: one bundle invocation per TTL, one `gh` process per invocation on a
 *      repository with 100 or fewer open issues and two on a larger one, plus the identity call.
 *   2. Parity: for the recorded state, four-call mode's `OverviewData` deep-equals bundle mode's.
 *   3. Configuration really selects the command that runs: a constituent override, and a
 *      malformed bundle override reported with its reason.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeGh, graphqlKey, operation, scriptTestTimeoutMs, withJq } from '../../__tests__/helpers/spec-1647-fake-gh.js';
import { LIST_TTL_MS } from '../../lib/overview-budget.js';

const { dbState } = vi.hoisted(() => ({ dbState: { globalDbPath: '' } }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

import { OverviewCache } from '../servers/overview.js';

const FIXTURES = path.resolve(import.meta.dirname, '..', '..', '__tests__', 'fixtures', 'spec-1647-overview-bundle');
const readFixture = <T = any>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8')) as T;
const recording = readFixture<{ recordedAt: string; issuesPage2Cursor: string; mergedPage2Cursor: string }>('recording.json');

/** The recorded first response, with each connection's `hasNextPage` set as a test needs. */
function firstPage(next: { issues: boolean; merged: boolean }) {
  const body = readFixture('graphql-bundle.json');
  body.data.repository.issues.pageInfo.hasNextPage = next.issues;
  body.data.merged.pageInfo.hasNextPage = next.merged;
  return body;
}

// The scripts spawn a few dozen short processes per refresh (gh, jq, sh). This runs on native
// Windows too, where it is the one check of the bundled default through Git Bash.
describe.skipIf(!withJq)('Spec 1647 — OverviewCache over the real scripts and a fake gh', { timeout: scriptTestTimeoutMs }, () => {
  const originalPath = process.env.PATH;
  let root: string;
  let fake: FakeGh;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1647-gh-'));
    dbState.globalDbPath = path.join(root, 'global.db');
    fake = new FakeGh(path.join(root, 'fake'));
    fake.route('user-identity', { body: 'octocat' });
    process.env.PATH = `${fake.dir}${path.delimiter}${originalPath ?? ''}`;
    clock = Date.now();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.useRealTimers();
    expect(fake.violations(), 'an unexpected gh call').toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A workspace with an optional `forge` section in its `.codev/config.json`. */
  function workspace(name: string, forge?: Record<string, string | null>): string {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, '.codev'), { recursive: true });
    if (forge) fs.writeFileSync(path.join(dir, '.codev', 'config.json'), JSON.stringify({ forge }));
    return dir;
  }

  const ops = () => fake.calls().map(operation);
  const tally = () => ops().reduce<Record<string, number>>((t, op) => ({ ...t, [op]: (t[op] ?? 0) + 1 }), {});

  // -------------------------------------------------------------------------------------------
  describe('process counts', () => {
    it('100 or fewer open issues: one gh process per bundle invocation, one invocation per TTL', async () => {
      fake.route('OverviewBundle', { body: firstPage({ issues: false, merged: false }) });
      const ws = workspace('small');
      const cache = new OverviewCache({ now });
      const start = clock;
      const data = await cache.getOverview(ws);
      for (let i = 1; i < 10; i++) {
        clock += 2_500;
        await cache.getOverview(ws);
      }
      expect(tally()).toEqual({ OverviewBundle: 1, 'api user': 1 });
      expect(data.forgeStatus).toBe('ok');
      expect(data.pendingPRs).toHaveLength(6);
      expect(data.backlog.length).toBeGreaterThan(0);

      clock = start + LIST_TTL_MS;
      await cache.getOverview(ws);
      expect(tally()).toEqual({ OverviewBundle: 2, 'api user': 1 });
    });

    it('more than 100 open issues: two gh processes per invocation (first page, then issues only)', async () => {
      fake.route('OverviewBundle', { body: firstPage({ issues: true, merged: false }) });
      fake.route(graphqlKey('OverviewIssuesPage', { cursor: recording.issuesPage2Cursor }), {
        body: readFixture('graphql-issues-page-2.json'),
      });
      const ws = workspace('large');
      const cache = new OverviewCache({ now });
      const start = clock;
      await cache.getOverview(ws);
      clock += 2_500;
      await cache.getOverview(ws);
      expect(tally()).toEqual({ OverviewBundle: 1, OverviewIssuesPage: 1, 'api user': 1 });

      clock = start + LIST_TTL_MS;
      await cache.getOverview(ws);
      expect(tally()).toEqual({ OverviewBundle: 2, OverviewIssuesPage: 2, 'api user': 1 });
    });
  });

  // -------------------------------------------------------------------------------------------
  it('the same recorded state gives the same OverviewData in four-call mode and in bundle mode', async () => {
    // The 24 h post-filter reads the wall clock: put it at the recording instant, so both
    // modes keep the same part of the recorded 36 h window.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(recording.recordedAt));
    clock = Date.now();
    fake.route('OverviewBundle', { body: readFixture('graphql-bundle.json') });
    fake.route(graphqlKey('OverviewIssuesPage', { cursor: recording.issuesPage2Cursor }), { body: readFixture('graphql-issues-page-2.json') });
    fake.route(graphqlKey('OverviewSearchPage', { section: 'merged', cursor: recording.mergedPage2Cursor }), { body: readFixture('graphql-merged-page-2.json') });
    fake.route('pr-list', { body: readFixture('gh-pr-list.json') });
    fake.route('issue-list', { body: readFixture('gh-issue-list.json') });
    fake.route('recently-closed', { body: readFixture('gh-recently-closed.json') });
    fake.route('recently-merged', { body: readFixture('gh-recently-merged.json') });

    const bundled = await new OverviewCache({ now }).getOverview(workspace('bundled'));
    const bundledOps = ops();
    const fourCall = await new OverviewCache({ now }).getOverview(workspace('four-call', { 'overview-bundle': null }));
    const fourCallOps = ops().slice(bundledOps.length);

    expect(bundledOps.sort()).toEqual(['OverviewBundle', 'OverviewIssuesPage', 'OverviewSearchPage.merged', 'api user']);
    expect(fourCallOps.sort()).toEqual(['api user', 'issue list', 'issue list', 'pr list', 'pr list']);
    expect(bundled.forgeStatus).toBe('ok');
    // Not vacuous: every section has content, and the 24 h window both kept and dropped items.
    expect(bundled.pendingPRs).toHaveLength(6);
    expect(bundled.backlog).toHaveLength(6);
    expect(bundled.recentlyClosed.length).toBeGreaterThan(0);
    expect(bundled.recentlyClosed.length).toBeLessThan(readFixture<unknown[]>('gh-recently-closed.json').length);
    expect(fourCall).toEqual(bundled);
  });

  // -------------------------------------------------------------------------------------------
  describe('configuration selects the command that runs', () => {
    it('an overridden issue-list runs, with the other three on gh, and no bundle', async () => {
      const issuesFile = path.join(root, 'issues.json');
      fs.writeFileSync(issuesFile, JSON.stringify([{
        number: 5, title: 'From the override', url: 'https://example.test/issues/5', labels: [],
        createdAt: '2026-11-01T00:00:00Z', author: { login: 'eve' }, assignees: [],
      }]));
      fake.route('pr-list', { body: [] });
      fake.route('recently-closed', { body: [] });
      fake.route('recently-merged', { body: [] });
      const ws = workspace('override', { 'issue-list': `cat "${issuesFile}"` });
      const data = await new OverviewCache({ now }).getOverview(ws);
      expect(ops().sort()).toEqual(['api user', 'issue list', 'pr list', 'pr list']); // the issue list is the closed search
      expect(data.backlog.map(b => [b.id, b.title])).toEqual([['5', 'From the override']]);
      expect(data.forgeStatus).toBe('ok');
    });

    it('a malformed overview-bundle override fails the whole bundle, with the reason in the errors text', async () => {
      const bundleFile = path.join(root, 'bundle.json');
      fs.writeFileSync(bundleFile, JSON.stringify({ prs: 'x', issues: [], recentlyClosed: [], recentlyMerged: [] }));
      const ws = workspace('malformed', { 'overview-bundle': `cat "${bundleFile}"` });
      const data = await new OverviewCache({ now }).getOverview(ws);
      expect(ops()).toEqual(['api user']);
      expect(data.forgeStatus).toBe('unavailable');
      expect(data.errors).toEqual({
        prs: 'overview-bundle output malformed (prs is neither an array nor null) — could not fetch PRs',
        issues: 'overview-bundle output malformed (prs is neither an array nor null) — could not fetch issues',
      });
    });
  });
});
