/**
 * Spec 1647 — the github `overview-bundle` script.
 *
 * Runs the real script through `executeForgeCommandDetailed` against the fake `gh` in
 * helpers/spec-1647-fake-gh.ts. An unrouted call is recorded as a violation and fails the
 * test in `afterEach`, so a request the script should never send (a third issue page, an
 * eleventh search page) fails loudly.
 *
 * Pins:
 *   1. Parity: for a state recorded from real gh (fixtures/spec-1647-overview-bundle), each
 *      section equals its sibling script's output on that concept's contract fields. This is
 *      not byte parity: the bundle emits only the contract fields, so its items are narrower
 *      than `gh --json`'s (no `is_bot`, no label `color`).
 *   2. Search qualifiers: the exact search strings, and real GitHub's exclusions as recorded.
 *   3. Process counts and paging caps.
 *   4. Argument guards: `-F` only where gh must expand {owner}/{repo}; fixed query text.
 *   5. A malformed CODEV_SINCE_DATE spawns no gh.
 *   6. Failure classification (spec Desired State item 6).
 *   7. Hostile strings round-trip byte-identical and are never evaluated.
 *   8. The temp directory is gone on every path; a timeout settles, kills gh, leaves nothing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executeForgeCommandDetailed, type ForgeCommandResult } from '../lib/forge.js';
import { isRateLimitError, RATE_LIMIT_PATTERN } from '../lib/forge-rate-limit.js';
import type {
  IssueListItem,
  MergedPrItem,
  OverviewBundleResult,
  PrListItem,
} from '../lib/forge-contracts.js';
import { FakeGh, graphqlKey, operation, fields, scriptTestTimeoutMs, withJq } from './helpers/spec-1647-fake-gh.js';

/** Native Windows: the script runs under Git Bash; a few tests need POSIX and skip by name. */
const onWindows = process.platform === 'win32';

const SCRIPT = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'forge', 'github', 'overview-bundle.sh');
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'spec-1647-overview-bundle');
const SINCE = '2026-11-25T12:00:00Z';
const CLOSED_SEARCH = `repo:{owner}/{repo} type:issue state:closed closed:>${SINCE}`;
const MERGED_SEARCH = `repo:{owner}/{repo} type:pr is:merged merged:>${SINCE}`;

// ---------------------------------------------------------------------------------------------
// Response builders, from the recorded node shapes
// ---------------------------------------------------------------------------------------------

function readFixture<T = any>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf-8')) as T;
}

const RECORDED_BUNDLE = readFixture('graphql-bundle.json');
const PR_NODE = RECORDED_BUNDLE.data.repository.pullRequests.nodes[0];
const ISSUE_NODE = RECORDED_BUNDLE.data.repository.issues.nodes[0];
const CLOSED_NODE = RECORDED_BUNDLE.data.closed.nodes[0];
const MERGED_NODE = RECORDED_BUNDLE.data.merged.nodes[0];

const connection = (nodes: unknown[], next?: string) => ({
  pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? 'end' },
  nodes,
});

/** `count` copies of a recorded node, numbered down from `top` (newest first). */
const nodes = (template: object, count: number, top: number) =>
  Array.from({ length: count }, (_, i) => ({ ...template, number: top - i }));

interface BundleShape {
  prs?: unknown[];
  issues?: unknown[];
  issuesNext?: string;
  closed?: unknown[];
  closedNext?: string;
  merged?: unknown[];
  mergedNext?: string;
}

function bundleBody(o: BundleShape = {}) {
  return {
    data: {
      repository: {
        pullRequests: { nodes: o.prs ?? [PR_NODE] },
        issues: connection(o.issues ?? [ISSUE_NODE], o.issuesNext),
      },
      closed: connection(o.closed ?? [CLOSED_NODE], o.closedNext),
      merged: connection(o.merged ?? [MERGED_NODE], o.mergedNext),
    },
  };
}

const issuesPage = (pageNodes: unknown[], next?: string) => ({ data: { repository: { issues: connection(pageNodes, next) } } });
const searchPage = (pageNodes: unknown[], next?: string) => ({ data: { search: connection(pageNodes, next) } });

// ---------------------------------------------------------------------------------------------
// Contract projections of the sibling scripts' output
// ---------------------------------------------------------------------------------------------

const loginOf = (a: { login: string } | undefined) => (a ? { login: a.login } : a);

const projectPr = (p: PrListItem) => ({
  number: p.number, title: p.title, url: p.url, reviewDecision: p.reviewDecision, body: p.body,
  createdAt: p.createdAt, author: loginOf(p.author), reviewRequests: p.reviewRequests, isDraft: p.isDraft,
});
const projectIssue = (i: IssueListItem) => ({
  number: i.number, title: i.title, url: i.url, labels: i.labels.map(l => ({ name: l.name })),
  createdAt: i.createdAt, author: loginOf(i.author), assignees: (i.assignees ?? []).map(a => ({ login: a.login })),
});
const projectClosed = (i: IssueListItem) => ({
  number: i.number, title: i.title, url: i.url, labels: i.labels.map(l => ({ name: l.name })),
  createdAt: i.createdAt, closedAt: i.closedAt,
});
const projectMerged = (p: MergedPrItem) => ({
  number: p.number, title: p.title, url: p.url, body: p.body, createdAt: p.createdAt,
  mergedAt: p.mergedAt, headRefName: p.headRefName,
});

// ---------------------------------------------------------------------------------------------

describe('Spec 1647 — the overview-bundle script is executable and declares gh', () => {
  it.skipIf(process.platform === 'win32')('is executable', () => {
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('declares gh as its executable', () => {
    expect(fs.readFileSync(SCRIPT, 'utf-8')).toMatch(/^# forge-executable: gh$/m);
  });

  // The script classifies rate limits itself, and names a body-only one on stderr for the
  // limiter, so its copy of the pattern must not drift from the limiter's.
  it('carries the rate-limit pattern the limiter matches on', () => {
    const line = fs.readFileSync(SCRIPT, 'utf-8').match(/^RATE_LIMIT_PATTERN='([^']*)'$/m);
    expect(line, 'RATE_LIMIT_PATTERN assignment').not.toBeNull();
    // ERE groups capture; the limiter's are non-capturing. Otherwise the two must be equal.
    const asJs = new RegExp(line![1].replace(/\((?!\?)/g, '(?:'), 'i');
    expect(asJs.source).toBe(RATE_LIMIT_PATTERN.source);
    expect(RATE_LIMIT_PATTERN.flags).toBe('i');
  });
});

// Each script run spawns a few dozen short processes (gh, jq, sh); a test that runs five
// of them can pass vitest's 5 s default on a loaded machine.
describe.skipIf(!withJq)('Spec 1647 — the github overview-bundle script', { timeout: scriptTestTimeoutMs }, () => {
  let root: string;
  let work: string;
  let scratchTmp: string;
  let fake: FakeGh;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1647-bundle-'));
    work = path.join(root, 'work');
    scratchTmp = path.join(root, 'tmpdir');
    fs.mkdirSync(work);
    fs.mkdirSync(scratchTmp);
    fake = new FakeGh(path.join(root, 'fake'));
  });

  afterEach(() => {
    // Every path, success or failure, leaves the script's TMPDIR empty, and sends no
    // request the test did not route.
    expect(fs.readdirSync(scratchTmp), 'temp files left behind').toEqual([]);
    expect(fake.violations(), 'an unexpected gh call').toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const env = (since: string = SINCE): Record<string, string> => ({
    CODEV_SINCE_DATE: since,
    PATH: `${fake.dir}${path.delimiter}${process.env.PATH ?? ''}`,
    TMPDIR: scratchTmp,
  });

  /** Through the real dispatcher, as Tower runs it. */
  const runConcept = (concept: string, since?: string, timeoutMs?: number): Promise<ForgeCommandResult> =>
    executeForgeCommandDetailed(concept, env(since), { forgeConfig: { provider: 'github' }, cwd: work, timeoutMs });

  const runBundle = async (since?: string): Promise<OverviewBundleResult> => {
    const result = await runConcept('overview-bundle', since);
    expect(result.error, result.error?.stderr).toBeNull();
    return result.data as OverviewBundleResult;
  };

  /** Directly, to read stderr on a successful run (the dispatcher drops it). */
  const runDirect = (overrides: Record<string, string | undefined> = {}) => {
    const full: Record<string, string> = { ...env() };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete full[k];
      else full[k] = v;
    }
    const r = spawnSync('/bin/sh', [SCRIPT], { cwd: work, env: full, encoding: 'utf-8' });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  const ops = () => fake.calls().map(operation);

  // -------------------------------------------------------------------------------------------
  describe('parity with the four sibling scripts on a recorded state', () => {
    const recording = readFixture<{ sinceDate: string; issuesPage2Cursor: string; mergedPage2Cursor: string }>('recording.json');

    const routeRecording = () => {
      fake.route('OverviewBundle', { body: readFixture('graphql-bundle.json') });
      fake.route(graphqlKey('OverviewIssuesPage', { cursor: recording.issuesPage2Cursor }), { body: readFixture('graphql-issues-page-2.json') });
      fake.route(graphqlKey('OverviewSearchPage', { section: 'merged', cursor: recording.mergedPage2Cursor }), { body: readFixture('graphql-merged-page-2.json') });
      fake.route('pr-list', { body: readFixture('gh-pr-list.json') });
      fake.route('issue-list', { body: readFixture('gh-issue-list.json') });
      fake.route('recently-closed', { body: readFixture('gh-recently-closed.json') });
      fake.route('recently-merged', { body: readFixture('gh-recently-merged.json') });
    };

    it('each section equals its sibling script on the contract fields', async () => {
      routeRecording();
      const bundle = await runBundle(recording.sinceDate);
      const sibling = async <T>(concept: string): Promise<T> => {
        const result = await runConcept(concept, recording.sinceDate);
        expect(result.error, concept).toBeNull();
        return result.data as T;
      };
      const prList = await sibling<PrListItem[]>('pr-list');
      const issueList = await sibling<IssueListItem[]>('issue-list');
      const closed = await sibling<IssueListItem[]>('recently-closed');
      const merged = await sibling<MergedPrItem[]>('recently-merged');

      expect(bundle.prs).toEqual(prList.map(projectPr));
      expect(bundle.issues).toEqual(issueList.map(projectIssue));
      expect(bundle.recentlyClosed).toEqual(closed.map(projectClosed));
      expect(bundle.recentlyMerged).toEqual(merged.map(projectMerged));
    });

    it('covers the named cases, so the parity above is not vacuous', async () => {
      routeRecording();
      const bundle = await runBundle(recording.sinceDate);
      const pr = (n: number) => bundle.prs!.find(p => p.number === n)!;
      expect(pr(139061).author).toEqual({ login: 'app/renovate-sh-app' }); // bot author, gh's spelling
      expect(pr(139079).reviewDecision).toBe(''); // no review decision
      expect(pr(139078).author).toEqual({ login: 'app/' }); // absent author (constructed)
      // Team and bot reviewers (constructed) are dropped; user reviewers kept.
      const recordedRequests = RECORDED_BUNDLE.data.repository.pullRequests.nodes
        .find((n: { number: number }) => n.number === 139086).reviewRequests.nodes
        .map((r: { requestedReviewer: { __typename: string } }) => r.requestedReviewer.__typename);
      expect(recordedRequests).toEqual(['User', 'User', 'Team', 'Bot']);
      expect(pr(139086).reviewRequests).toEqual(['ferruvich', 'MissingRoberto']);
      expect(bundle.issues!.some(i => (i.assignees?.length ?? 0) >= 3)).toBe(true);
      expect(bundle.issues!.some(i => i.labels.length >= 2)).toBe(true);
      expect(bundle.recentlyClosed!.some(i => i.labels.length >= 2)).toBe(true);
      // Real paging on both sides of the page boundary.
      expect(bundle.issues!.length).toBe(6);
      expect(bundle.recentlyMerged!.length).toBeGreaterThan(100);
    });

    it('sends the first request, one issue page and one merged-search page; never a third issue page', async () => {
      routeRecording();
      await runBundle(recording.sinceDate);
      expect(ops()).toEqual(['OverviewBundle', 'OverviewIssuesPage', 'OverviewSearchPage.merged']);
      // The recorded second issue page says there is more, so stopping there is the cap.
      expect(readFixture('graphql-issues-page-2.json').data.repository.issues.pageInfo.hasNextPage).toBe(true);
    });

    it('real GitHub applied the search qualifiers: no closed PR in recentlyClosed, no unmerged PR in recentlyMerged', async () => {
      routeRecording();
      const bundle = await runBundle(recording.sinceDate);
      // Every PR closed inside the recorded window, merged or not, as real GitHub listed them.
      const windowPrs = readFixture<Array<{ number: number; state: string }>>('window-closed-prs.json');
      const mergedPrs = new Set(windowPrs.filter(p => p.state === 'MERGED').map(p => p.number));
      const unmergedPrs = new Set(windowPrs.filter(p => p.state === 'CLOSED').map(p => p.number));
      expect(mergedPrs.size).toBeGreaterThan(0);
      expect(unmergedPrs.size).toBeGreaterThan(0);
      expect(bundle.recentlyClosed!.filter(i => mergedPrs.has(Number(i.number)) || unmergedPrs.has(Number(i.number)))).toEqual([]);
      expect(bundle.recentlyMerged!.filter(p => unmergedPrs.has(p.number))).toEqual([]);
      expect(bundle.recentlyMerged!.every(p => mergedPrs.has(p.number))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('process counts and paging', () => {
    it('100 or fewer open issues: one gh process', async () => {
      fake.route('OverviewBundle', { body: bundleBody({ issues: nodes(ISSUE_NODE, 100, 500) }) });
      const bundle = await runBundle();
      expect(ops()).toEqual(['OverviewBundle']);
      expect(bundle.issues).toHaveLength(100);
    });

    it('more than 100 open issues: two gh processes, 200 issues newest first, never a third page', async () => {
      fake.route('OverviewBundle', { body: bundleBody({ issues: nodes(ISSUE_NODE, 100, 500), issuesNext: 'i2' }) });
      // Page 2 says there is more; the fake has no route for i3, so a third request would fail the test.
      fake.route(graphqlKey('OverviewIssuesPage', { cursor: 'i2' }), { body: issuesPage(nodes(ISSUE_NODE, 100, 400), 'i3') });
      const bundle = await runBundle();
      expect(ops()).toEqual(['OverviewBundle', 'OverviewIssuesPage']);
      expect(bundle.issues!.map(i => i.number)).toEqual(Array.from({ length: 200 }, (_, i) => 500 - i));
    });

    it.each(['closed', 'merged'] as const)('an overflowing %s search pages up to 1,000 from an 11-page chain', async (section) => {
      const template = section === 'closed' ? CLOSED_NODE : MERGED_NODE;
      fake.route('OverviewBundle', {
        body: bundleBody({ [section]: nodes(template, 100, 5000), [`${section}Next`]: 'p2' }),
      });
      for (let page = 2; page <= 11; page++) {
        fake.route(graphqlKey('OverviewSearchPage', { section, cursor: `p${page}` }), {
          body: searchPage(nodes(template, 100, 5000 - (page - 1) * 100), `p${page + 1}`),
        });
      }
      const bundle = await runBundle();
      const items = section === 'closed' ? bundle.recentlyClosed! : bundle.recentlyMerged!;
      expect(items).toHaveLength(1000);
      expect(items.map(i => i.number)).toEqual(Array.from({ length: 1000 }, (_, i) => 5000 - i));
      // The first request plus pages 2–10; page 11 is never requested.
      expect(ops()).toEqual(['OverviewBundle', ...Array(9).fill(`OverviewSearchPage.${section}`)]);
      const cursors = fake.calls().flatMap(argv => fields(argv).filter(([, n]) => n === 'cursor').map(([, , v]) => v));
      expect(cursors).toEqual(['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10']);
    });

    it('a degenerate search chain (next page, no results) stops at page 10', async () => {
      fake.route('OverviewBundle', { body: bundleBody({ merged: [MERGED_NODE], mergedNext: 'p2' }) });
      for (let page = 2; page <= 11; page++) {
        fake.route(graphqlKey('OverviewSearchPage', { section: 'merged', cursor: `p${page}` }), {
          body: searchPage([], `p${page + 1}`),
        });
      }
      const bundle = await runBundle();
      expect(bundle.recentlyMerged).toHaveLength(1);
      expect(ops()).toEqual(['OverviewBundle', ...Array(9).fill('OverviewSearchPage.merged')]);
    });

    it.each([
      ['a null', null],
      ['an empty', ''],
    ])('a next page with %s cursor fails the bundle rather than truncating it', async (_name, endCursor) => {
      const body = bundleBody({ issuesNext: 'unused' });
      (body.data.repository.issues.pageInfo as { endCursor: unknown }).endCursor = endCursor;
      fake.route('OverviewBundle', { body });
      const result = await runConcept('overview-bundle');
      expect(result.data).toBeNull();
      expect(result.error?.exitCode).toBe(1);
      expect(result.error?.stderr).toContain('unexpected response shape');
      expect(ops()).toEqual(['OverviewBundle']);
    });

    it('a page after which paging stops anyway (issue page 2, search page 10) may say "next page" without a cursor', async () => {
      const noCursor = <T extends { pageInfo: object }>(c: T) => ({ ...c, pageInfo: { hasNextPage: true, endCursor: null } });
      fake.route('OverviewBundle', {
        body: bundleBody({ issues: nodes(ISSUE_NODE, 100, 500), issuesNext: 'i2', merged: [MERGED_NODE], mergedNext: 'p2' }),
      });
      const page2 = issuesPage(nodes(ISSUE_NODE, 100, 400));
      fake.route(graphqlKey('OverviewIssuesPage', { cursor: 'i2' }), {
        body: { data: { repository: { issues: noCursor(page2.data.repository.issues) } } },
      });
      for (let page = 2; page <= 9; page++) {
        fake.route(graphqlKey('OverviewSearchPage', { section: 'merged', cursor: `p${page}` }), {
          body: searchPage([], `p${page + 1}`),
        });
      }
      fake.route(graphqlKey('OverviewSearchPage', { section: 'merged', cursor: 'p10' }), {
        body: { data: { search: noCursor(searchPage([]).data.search) } },
      });
      const bundle = await runBundle();
      expect(bundle.issues).toHaveLength(200);
      expect(bundle.recentlyMerged).toHaveLength(1);
      expect(ops()).toEqual(['OverviewBundle', 'OverviewIssuesPage', ...Array(9).fill('OverviewSearchPage.merged')]);
    });

    it('caps open PRs at 30', async () => {
      fake.route('OverviewBundle', { body: bundleBody({ prs: nodes(PR_NODE, 35, 900) }) });
      const bundle = await runBundle();
      expect(bundle.prs).toHaveLength(30);
    });

    it('a repository with issues disabled gives empty issues and recently-closed, PRs intact', async () => {
      // GraphQL answers an empty issue connection with exit 0; the accepted divergence (spec item 5).
      fake.route('OverviewBundle', { body: bundleBody({ issues: [], closed: [] }) });
      const bundle = await runBundle();
      expect(bundle.issues).toEqual([]);
      expect(bundle.recentlyClosed).toEqual([]);
      expect(bundle.prs).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('argument guards', () => {
    it('the first request passes owner, repo and both search strings through -F, the query through -f', async () => {
      fake.route('OverviewBundle', { body: bundleBody() });
      await runBundle();
      const [argv] = fake.calls();
      expect(argv.slice(0, 2)).toEqual(['api', 'graphql']);
      const f = fields(argv);
      expect(f.map(([flag, name]) => `${flag} ${name}`)).toEqual([
        '-f query', '-F owner', '-F repo', '-F closedQuery', '-F mergedQuery',
      ]);
      expect(f.slice(1)).toEqual([
        ['-F', 'owner', '{owner}'],
        ['-F', 'repo', '{repo}'],
        ['-F', 'closedQuery', CLOSED_SEARCH],
        ['-F', 'mergedQuery', MERGED_SEARCH],
      ]);
    });

    it('cursors pass through -f only; follow-up pages carry no other dynamic value', async () => {
      fake.route('OverviewBundle', { body: bundleBody({ issuesNext: 'i/2+=', mergedNext: 'm2' }) });
      fake.route(graphqlKey('OverviewIssuesPage', { cursor: 'i/2+=' }), { body: issuesPage([ISSUE_NODE]) });
      fake.route(graphqlKey('OverviewSearchPage', { section: 'merged', cursor: 'm2' }), { body: searchPage([MERGED_NODE]) });
      await runBundle();
      const [, issuePage, mergedPage] = fake.calls().map(fields);
      expect(issuePage.slice(1)).toEqual([['-F', 'owner', '{owner}'], ['-F', 'repo', '{repo}'], ['-f', 'cursor', 'i/2+=']]);
      expect(mergedPage.slice(1)).toEqual([['-F', 'search', MERGED_SEARCH], ['-f', 'cursor', 'm2']]);
      expect(issuePage[0].slice(0, 2)).toEqual(['-f', 'query']);
      expect(mergedPage[0].slice(0, 2)).toEqual(['-f', 'query']);
    });

    it('the query texts are fixed: byte-identical across runs with different data and dates', async () => {
      const queriesOf = () => fake.calls().map(argv => fields(argv).find(([, n]) => n === 'query')![2]);
      fake.route('OverviewBundle', { body: bundleBody({ mergedNext: 'm2' }) });
      fake.route(graphqlKey('OverviewSearchPage', { section: 'merged', cursor: 'm2' }), { body: searchPage([MERGED_NODE]) });
      await runBundle('2026-11-25T12:00:00Z');
      const first = queriesOf();

      fake.route('OverviewBundle', { body: bundleBody({ prs: nodes(PR_NODE, 3, 77), mergedNext: 'zz9' }) });
      fake.route(graphqlKey('OverviewSearchPage', { section: 'merged', cursor: 'zz9' }), { body: searchPage([]) });
      await runBundle('2001-01-01T00:00:00Z');
      const second = queriesOf().slice(first.length);

      expect(second).toEqual(first);
      for (const q of first) {
        expect(q).not.toContain('2026-11-25');
        expect(q).not.toContain('m2');
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('CODEV_SINCE_DATE is validated before any request', () => {
    // Run directly through /bin/sh, which Node cannot spawn on native Windows; the
    // dispatcher case below runs everywhere.
    it.skipIf(onWindows).each([
      ['missing', undefined],
      ['empty', ''],
      ['date-only', '2026-11-25'],
      ['with milliseconds', '2026-11-25T12:00:00.000Z'],
      ['with an offset', '2026-11-25T12:00:00+00:00'],
      ['with a trailing qualifier', '2026-11-25T12:00:00Z repo:evil/x'],
      ['with an embedded newline', '2026-11-25T12:00:00Z\nrepo:evil/x'],
    ])('%s: exits 2 and spawns no gh', (_name, value) => {
      fake.route('OverviewBundle', { body: bundleBody() });
      const r = runDirect({ CODEV_SINCE_DATE: value });
      expect(r.code).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('CODEV_SINCE_DATE');
      expect(fake.calls()).toEqual([]);
    });

    it('through the dispatcher, too', async () => {
      const result = await runConcept('overview-bundle', '2026-11-25');
      expect(result.data).toBeNull();
      expect(result.error?.exitCode).toBe(2);
      expect(fake.calls()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe('failure classification', () => {
    const lists = { pullRequests: { nodes: [PR_NODE] }, issues: connection([ISSUE_NODE]) };
    const error = (pathParts: unknown[] | undefined, extra: object = {}) => ({
      ...(pathParts ? { path: pathParts } : {}),
      locations: [{ line: 1, column: 1 }],
      message: 'Something went wrong while executing your query.',
      ...extra,
    });
    const GH_STDERR = 'gh: Something went wrong while executing your query.\n';

    const expectWholeFailure = (result: ForgeCommandResult, code: number, stderr: string) => {
      expect(result.data).toBeNull();
      expect(result.error?.exitCode).toBe(code);
      expect(result.error?.stderr).toBe(stderr);
    };

    // Reads stderr from a direct /bin/sh run; "errors on both searches" covers this path on Windows.
    it.skipIf(onWindows)('an error on the closed search alone: recentlyClosed null, the rest populated, exit 0, the reason on stderr', async () => {
      const body = { data: { repository: lists, closed: null, merged: connection([MERGED_NODE]) }, errors: [error(['closed'])] };
      fake.route('OverviewBundle', { body, stderr: GH_STDERR, code: 1 });
      const bundle = await runBundle();
      expect(bundle.recentlyClosed).toBeNull();
      expect(bundle.recentlyMerged).toHaveLength(1);
      expect(bundle.prs).toHaveLength(1);
      expect(bundle.issues).toHaveLength(1);
      const direct = runDirect();
      expect(direct.code).toBe(0);
      expect(direct.stderr).toContain('closed search failed');
    });

    it('errors on both searches: both null, exit 0', async () => {
      const body = { data: { repository: lists, closed: null, merged: null }, errors: [error(['closed']), error(['merged', 'nodes', 3])] };
      fake.route('OverviewBundle', { body, stderr: GH_STDERR, code: 1 });
      const bundle = await runBundle();
      expect(bundle.recentlyClosed).toBeNull();
      expect(bundle.recentlyMerged).toBeNull();
      expect(bundle.prs).toHaveLength(1);
    });

    it.each([
      ['an error with no path', { data: { repository: lists, closed: connection([]), merged: connection([]) }, errors: [error(undefined)] }],
      ['an error with an empty path', { data: { repository: lists, closed: connection([]), merged: connection([]) }, errors: [error([])] }],
      ['an error on the issues path', { data: { repository: { ...lists, issues: null }, closed: connection([]), merged: connection([]) }, errors: [error(['repository', 'issues'])] }],
      ['one search error plus one list error', { data: { repository: { ...lists, pullRequests: null }, closed: null, merged: connection([]) }, errors: [error(['closed']), error(['repository', 'pullRequests'])] }],
      ['data: null', { data: null, errors: [error(['closed'])] }],
      ['non-JSON stdout', 'upstream connect error or disconnect/reset before headers'],
    ])('%s: whole failure with gh\'s status and stderr', async (_name, body) => {
      fake.route('OverviewBundle', { body, stderr: GH_STDERR, code: 1 });
      expectWholeFailure(await runConcept('overview-bundle'), 1, GH_STDERR);
      expect(isRateLimitError(GH_STDERR)).toBe(false);
    });

    // gh's own stderr may not say "rate limit" when only the body does. The script names it,
    // because the forge layer's rate limiter reads stderr alone.
    it.each([
      ['RATE_LIMITED on a search path', error(['closed'], { type: 'RATE_LIMITED' })],
      ['a rate-limit message on a search path', error(['merged'], { message: 'You have exceeded a secondary rate limit.' })],
    ])('%s: whole failure, gh\'s stderr replayed, and the rate limit named for the limiter', async (_name, err) => {
      const body = { data: { repository: lists, closed: null, merged: connection([]) }, errors: [err] };
      fake.route('OverviewBundle', { body, stderr: GH_STDERR, code: 1 });
      const result = await runConcept('overview-bundle');
      expect(result.data).toBeNull();
      expect(result.error?.exitCode).toBe(1);
      const stderr = result.error?.stderr ?? '';
      expect(stderr.startsWith(GH_STDERR)).toBe(true);
      const added = stderr.slice(GH_STDERR.length);
      expect(added).toMatch(/^overview-bundle: GitHub reported a rate limit: /);
      expect(isRateLimitError(added)).toBe(true);
    });

    it('a body-only rate limit on a follow-up page is named for the limiter too', async () => {
      fake.route('OverviewBundle', { body: bundleBody({ issuesNext: 'i2' }) });
      fake.route(graphqlKey('OverviewIssuesPage', { cursor: 'i2' }), {
        body: { data: null, errors: [error(undefined, { type: 'RATE_LIMITED' })] }, stderr: GH_STDERR, code: 1,
      });
      const result = await runConcept('overview-bundle');
      expect(result.error?.exitCode).toBe(1);
      expect(isRateLimitError(result.error?.stderr ?? '')).toBe(true);
    });

    it('rate-limit text on stderr only: whole failure', async () => {
      const body = { data: { repository: lists, closed: null, merged: connection([]) }, errors: [error(['closed'])] };
      const stderr = 'gh: API rate limit exceeded for user ID 1.\n';
      fake.route('OverviewBundle', { body, stderr, code: 1 });
      expectWholeFailure(await runConcept('overview-bundle'), 1, stderr);
    });

    it('a transport failure keeps gh\'s own exit status', async () => {
      const stderr = 'error connecting to api.github.com\n';
      fake.route('OverviewBundle', { body: '', stderr, code: 4 });
      expectWholeFailure(await runConcept('overview-bundle'), 4, stderr);
    });

    it('search page 2 fails: that section null, the others intact, exit 0', async () => {
      fake.route('OverviewBundle', { body: bundleBody({ mergedNext: 'm2' }) });
      fake.route(graphqlKey('OverviewSearchPage', { section: 'merged', cursor: 'm2' }), { body: '', stderr: 'HTTP 502: Bad Gateway\n', code: 1 });
      const bundle = await runBundle();
      expect(bundle.recentlyMerged).toBeNull();
      expect(bundle.recentlyClosed).toHaveLength(1);
      expect(bundle.prs).toHaveLength(1);
      expect(bundle.issues).toHaveLength(1);
    });

    it('search page 2 rate-limited: whole failure', async () => {
      const stderr = 'gh: API rate limit exceeded for user ID 1.\n';
      fake.route('OverviewBundle', { body: bundleBody({ closedNext: 'c2' }) });
      fake.route(graphqlKey('OverviewSearchPage', { section: 'closed', cursor: 'c2' }), { body: '', stderr, code: 1 });
      expectWholeFailure(await runConcept('overview-bundle'), 1, stderr);
    });

    it('issue page 2 fails: whole failure', async () => {
      const stderr = 'HTTP 502: Bad Gateway\n';
      fake.route('OverviewBundle', { body: bundleBody({ issuesNext: 'i2' }) });
      fake.route(graphqlKey('OverviewIssuesPage', { cursor: 'i2' }), { body: '', stderr, code: 1 });
      expectWholeFailure(await runConcept('overview-bundle'), 1, stderr);
    });

    it('a successful response of the wrong shape is a failure, not an empty bundle', async () => {
      fake.route('OverviewBundle', { body: { data: { repository: null, closed: null, merged: null } } });
      const result = await runConcept('overview-bundle');
      expect(result.data).toBeNull();
      expect(result.error?.exitCode).toBe(1);
      expect(result.error?.stderr).toContain('unexpected response shape');
    });
  });

  // -------------------------------------------------------------------------------------------
  // The hostile cursor names a route file, and NTFS forbids its `"`.
  describe.skipIf(onWindows)('hostile strings', () => {
    const HOSTILE = 'x $(touch pwned) `touch pwned` \'single\' "double" ; touch pwned\nsecond line \\ end';
    const HOSTILE_CURSOR = 'c$(touch pwned)`touch pwned`;\'"';

    it('round-trip byte-identical, are never evaluated, and a data-derived cursor reaches gh intact', async () => {
      const pr = {
        ...PR_NODE, title: HOSTILE, body: HOSTILE, author: { __typename: 'User', login: HOSTILE },
        reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: HOSTILE } }] },
      };
      const issue = {
        ...ISSUE_NODE, title: HOSTILE, labels: { nodes: [{ name: HOSTILE }] },
        author: { __typename: 'User', login: HOSTILE }, assignees: { nodes: [{ login: HOSTILE }] },
      };
      const closed = { ...CLOSED_NODE, title: HOSTILE, labels: { nodes: [{ name: HOSTILE }] } };
      const merged = { ...MERGED_NODE, title: HOSTILE, body: HOSTILE, headRefName: HOSTILE };
      fake.route('OverviewBundle', { body: bundleBody({ prs: [pr], issues: [issue], issuesNext: HOSTILE_CURSOR, closed: [closed], merged: [merged] }) });
      fake.route(graphqlKey('OverviewIssuesPage', { cursor: HOSTILE_CURSOR }), { body: issuesPage([]) });

      const bundle = await runBundle();
      expect(bundle.prs![0]).toMatchObject({ title: HOSTILE, body: HOSTILE, author: { login: HOSTILE }, reviewRequests: [HOSTILE] });
      expect(bundle.issues![0]).toMatchObject({ title: HOSTILE, labels: [{ name: HOSTILE }], author: { login: HOSTILE }, assignees: [{ login: HOSTILE }] });
      expect(bundle.recentlyClosed![0]).toMatchObject({ title: HOSTILE, labels: [{ name: HOSTILE }] });
      expect(bundle.recentlyMerged![0]).toMatchObject({ title: HOSTILE, body: HOSTILE, headRefName: HOSTILE });
      expect(fields(fake.calls()[1])).toContainEqual(['-f', 'cursor', HOSTILE_CURSOR]);
      for (const dir of [work, fake.dir, scratchTmp]) {
        expect(fs.existsSync(path.join(dir, 'pwned')), dir).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // POSIX signals and pids. On native Windows a timeout kill delivers no signal the script's
  // trap can catch (documented in the script), so neither the kill nor the cleanup is pinned there.
  describe.skipIf(onWindows)('timeout', () => {
    it('settles promptly, kills the in-flight gh and leaves no temp files', async () => {
      // The limit must fire while gh is in flight. A 3 s limit leaves room for the script to
      // reach its first gh on a loaded machine; a 30 s hang makes "settles promptly" unambiguous.
      fake.route('OverviewBundle', { sleep: 30 });
      const started = Date.now();
      const result = await runConcept('overview-bundle', SINCE, 3000);
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(result.data).toBeNull();
      expect(result.error?.timedOut).toBe(true);

      expect(fake.calls(), 'the limit fired before gh started').toHaveLength(1);
      const ghPid = fake.pid(1);
      const alive = () => {
        try {
          process.kill(ghPid, 0);
          return true;
        } catch {
          return false;
        }
      };
      // The killed gh is reaped by init once the script has exited; allow it a moment.
      const deadline = Date.now() + 3000;
      while (alive() && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      expect(alive(), 'the in-flight gh outlived the timeout').toBe(false);
    });
  });
});
