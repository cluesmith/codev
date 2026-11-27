/**
 * Spec 1995 — the `overview-bundle` forge concept.
 *
 * The github script runs for real against a fake `gh` that answers GraphQL
 * from fixture files. Pins: one request for every section; paging one
 * connection at a time up to its cap; gh's `--json` rendering; window-only
 * salvage and every other error failing the whole call; stderr passed
 * through; nothing printed on a kill.
 *
 * Then the TS side: `fetchForOverview('overview-bundle')` inputs and budgets,
 * contract validation, presets, backend and issue-id kind.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executeForgeCommandDetailed, getForgeCommand, getKnownProviders, resolveAllConcepts,
  resolveForgeBackend, resolveIssueIdKind,
} from '../lib/forge.js';
import { budgetKeyFor, isRateLimitError } from '../lib/forge-rate-limit.js';
import {
  fetchForOverview, parseOverviewBundle,
  OVERVIEW_BUNDLE_TIMEOUT_MS, OVERVIEW_BUNDLE_MAX_BUFFER,
} from '../lib/github.js';

// A pass-through spy: the script tests run the real dispatcher, and the fetch
// tests read the arguments github.ts passed it, or stand in a canned result.
vi.mock('../lib/forge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/forge.js')>();
  return { ...actual, executeForgeCommandDetailed: vi.fn(actual.executeForgeCommandDetailed) };
});

function hasJq(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const posixWithJq = process.platform !== 'win32' && hasJq();

/**
 * A fake `gh` for `gh api graphql`. It classifies the request by the query it
 * names, serves `<kind>[-<cursor>].json`, and honours optional `.exit`,
 * `.stderr` and `.sleep` files of the same name. Each call is logged as
 * `<kind> windows=… first=… after=…`, plus the flag each variable was sent with.
 */
const GH_STUB = `#!/bin/sh
dir="$(dirname "$0")"
[ "$1 $2" = "api graphql" ] || { echo "unexpected gh call: $*" >&2; exit 97; }
q=""; after=""; first=""; windows=""; flags=""; prev=""
for a in "$@"; do
  case "$a" in
    query=*) q="\${a#query=}" ;;
    after=*) after="\${a#after=}" ;;
    first=*) first="\${a#first=}" ;;
    windows=*) windows="\${a#windows=}" ;;
  esac
  case "$a" in
    owner=*|repo=*|closedQuery=*|mergedQuery=*|q=*) flags="$flags $prev:$a" ;;
  esac
  prev="$a"
done
case "$q" in
  *"pullRequests("*) kind=main ;;
  *"closed: search("*) kind=closed ;;
  *"merged: search("*) kind=merged ;;
  *"issues("*) kind=issues ;;
  *) echo "unexpected query" >&2; exit 98 ;;
esac
name="$kind"; [ -n "$after" ] && name="$kind-$after"
printf '%s windows=%s first=%s after=%s |%s\\n' "$kind" "$windows" "$first" "$after" "$flags" >> "$dir/gh-calls"
[ -f "$dir/$name.sleep" ] && sleep "$(cat "$dir/$name.sleep")"
[ -f "$dir/$name.stderr" ] && cat "$dir/$name.stderr" >&2
[ -f "$dir/$name.json" ] && cat "$dir/$name.json"
[ -f "$dir/$name.exit" ] && exit "$(cat "$dir/$name.exit")"
exit 0
`;

const RECENT = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

type Node = Record<string, unknown>;
const prNode = (n: number, o: Node = {}): Node => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, reviewDecision: 'APPROVED',
  body: `Fixes #${n + 1000}`, createdAt: '2026-11-20T00:00:00Z', isDraft: false,
  author: { login: 'alice', __typename: 'User' }, reviewRequests: { nodes: [] }, ...o,
});
const issueNode = (n: number, o: Node = {}): Node => ({
  number: n, title: `Issue ${n}`, url: `https://github.com/o/r/issues/${n}`, createdAt: '2026-11-19T00:00:00Z',
  author: { login: 'bob', __typename: 'User' }, labels: { nodes: [{ name: 'area/tower' }] },
  assignees: { nodes: [{ login: 'carol' }] }, ...o,
});
const closedNode = (n: number): Node => ({
  number: n, title: `Closed ${n}`, url: `https://github.com/o/r/issues/${n}`, createdAt: '2026-11-01T00:00:00Z',
  closedAt: RECENT, labels: { nodes: [] },
});
const mergedNode = (n: number): Node => ({
  number: n, title: `Merged ${n}`, url: `https://github.com/o/r/pull/${n}`, body: '', createdAt: '2026-11-01T00:00:00Z',
  mergedAt: RECENT, headRefName: `builder/spir-${n}`,
});
const conn = (nodes: Node[], next?: string) => ({ pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null }, nodes });
const range = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i);

function mainResponse(sections: { prs?: Node[]; issues?: unknown; closed?: unknown; merged?: unknown }): Record<string, unknown> {
  const data: Record<string, unknown> = {
    repository: { pullRequests: { nodes: sections.prs ?? [prNode(1)] }, issues: sections.issues ?? conn([issueNode(10)]) },
  };
  if (sections.closed !== undefined) data.closed = sections.closed;
  if (sections.merged !== undefined) data.merged = sections.merged;
  return { data };
}

describe.skipIf(!posixWithJq)('Spec 1995 — github overview-bundle script', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1995-bundle-'));
    const stub = path.join(tmp, 'gh');
    fs.writeFileSync(stub, GH_STUB);
    fs.chmodSync(stub, 0o755);
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const fixture = (name: string, body: unknown, extra: { exit?: number; stderr?: string; sleep?: number } = {}) => {
    fs.writeFileSync(path.join(tmp, `${name}.json`), typeof body === 'string' ? body : JSON.stringify(body));
    if (extra.exit !== undefined) fs.writeFileSync(path.join(tmp, `${name}.exit`), String(extra.exit));
    if (extra.stderr !== undefined) fs.writeFileSync(path.join(tmp, `${name}.stderr`), extra.stderr);
    if (extra.sleep !== undefined) fs.writeFileSync(path.join(tmp, `${name}.sleep`), String(extra.sleep));
  };
  const calls = () => fs.readFileSync(path.join(tmp, 'gh-calls'), 'utf-8').trim().split('\n');
  const run = (env: Record<string, string> = {}, timeoutMs?: number) =>
    executeForgeCommandDetailed('overview-bundle', { ...env, PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ''}` }, {
      forgeConfig: { provider: 'github' }, cwd: tmp, timeoutMs,
    });
  const WINDOWS = { CODEV_INCLUDE_WINDOWS: '1', CODEV_SINCE_DATE: '2026-11-26T00:00:00Z' };
  type Out = { prs: Node[]; issues: Node[]; recentlyClosed?: Node[]; recentlyMerged?: Node[]; windowsError?: string };

  describe('one request per refresh', () => {
    it('open-only: one request with the windows switched off, and only the open lists out', async () => {
      fixture('main', mainResponse({}));
      const result = await run();
      expect(result.error).toBeNull();
      expect(Object.keys(result.data as Out).sort()).toEqual(['issues', 'prs']);
      expect(calls()).toHaveLength(1);
      expect(calls()[0]).toMatch(/^main windows=false /);
    });

    it('with the windows: one request returns all four sections', async () => {
      fixture('main', mainResponse({ closed: conn([closedNode(20)]), merged: conn([mergedNode(30)]) }));
      const result = await run(WINDOWS);
      const out = result.data as Out;
      expect(result.error).toBeNull();
      expect(out.recentlyClosed?.map((i) => i.number)).toEqual([20]);
      expect(out.recentlyMerged?.map((i) => i.number)).toEqual([30]);
      expect(calls()).toHaveLength(1);
      expect(calls()[0]).toMatch(/^main windows=true /);
    });

    it('sends every placeholder through -F, so gh fills {owner}/{repo}, and both search strings even with the windows off', async () => {
      fixture('main', mainResponse({}));
      await run({ CODEV_SINCE_DATE: '2026-11-26T00:00:00Z' });
      const line = calls()[0];
      expect(line).toContain("-F:owner={owner}");
      expect(line).toContain("-F:repo={repo}");
      expect(line).toContain('-F:closedQuery=repo:{owner}/{repo} is:issue is:closed closed:>2026-11-26T00:00:00Z');
      expect(line).toContain('-F:mergedQuery=repo:{owner}/{repo} is:pr is:merged merged:>2026-11-26T00:00:00Z');
    });

    it('an unset CODEV_SINCE_DATE means no cutoff, as in recently-closed', async () => {
      fixture('main', mainResponse({ closed: conn([]), merged: conn([]) }));
      await run({ CODEV_INCLUDE_WINDOWS: '1' });
      expect(calls()[0].endsWith(' -F:closedQuery=repo:{owner}/{repo} is:issue is:closed -F:mergedQuery=repo:{owner}/{repo} is:pr is:merged')).toBe(true);
    });
  });

  describe('paging, inside the one forge call', () => {
    it('250 open issues: the newest 200 in two requests, the second asking for the issues only', async () => {
      fixture('main', mainResponse({ issues: conn(range(1, 100).map((n) => issueNode(n)), 'a1') }));
      fixture('issues-a1', { data: { repository: { issues: conn(range(101, 100).map((n) => issueNode(n)), 'a2') } } });
      const result = await run();
      expect((result.data as Out).issues.map((i) => i.number)).toEqual(range(1, 200));
      expect(calls()).toEqual([expect.stringMatching(/^main /), expect.stringMatching(/^issues windows= first=100 after=a1 /)]);
    });

    it('never asks past the issue cap', async () => {
      fixture('main', mainResponse({ issues: conn(range(1, 100).map((n) => issueNode(n)), 'a1') }));
      fixture('issues-a1', { data: { repository: { issues: conn(range(101, 60).map((n) => issueNode(n)), 'a2') } } });
      fixture('issues-a2', { data: { repository: { issues: conn(range(161, 40).map((n) => issueNode(n)), 'a3') } } });
      const result = await run();
      expect((result.data as Out).issues).toHaveLength(200);
      expect(calls().slice(1)).toEqual([
        expect.stringMatching(/^issues windows= first=100 after=a1 /),
        expect.stringMatching(/^issues windows= first=40 after=a2 /),
      ]);
    });

    it('120 merged PRs in 24 h: all 120, the follow-up asking for that window only', async () => {
      fixture('main', mainResponse({ closed: conn([closedNode(1)]), merged: conn(range(1, 100).map(mergedNode), 'm1') }));
      fixture('merged-m1', { data: { merged: conn(range(101, 20).map(mergedNode)) } });
      const result = await run(WINDOWS);
      expect((result.data as Out).recentlyMerged?.map((i) => i.number)).toEqual(range(1, 120));
      expect(calls().slice(1)).toEqual([expect.stringMatching(/^merged windows= first=100 after=m1 /)]);
    });

    it('stops each window at 1000 items', async () => {
      fixture('main', mainResponse({ closed: conn(range(1, 100).map(closedNode), 'c1'), merged: conn([]) }));
      for (let p = 1; p <= 9; p++) {
        fixture(`closed-c${p}`, { data: { closed: conn(range(p * 100 + 1, 100).map(closedNode), `c${p + 1}`) } });
      }
      const result = await run(WINDOWS);
      expect((result.data as Out).recentlyClosed).toHaveLength(1000);
      expect(calls().filter((c) => c.startsWith('closed '))).toHaveLength(9);
    });
  });

  describe("gh's --json rendering", () => {
    it('reproduces gh: bot and deleted authors, a null reviewDecision, user-only reviewers (teams and bots dropped), empty labels', async () => {
      fixture('main', mainResponse({
        prs: [
          prNode(1, { author: { login: 'dependabot', __typename: 'Bot' }, reviewDecision: null }),
          prNode(2, {
            author: null,
            reviewRequests: { nodes: [
              { requestedReviewer: { __typename: 'User', login: 'dana' } },
              { requestedReviewer: { __typename: 'Team' } },
              { requestedReviewer: { __typename: 'Bot' } },
              { requestedReviewer: null },
            ] },
          }),
        ],
        issues: conn([issueNode(10, { labels: { nodes: [] }, assignees: { nodes: [] } })]),
      }));
      const out = (await run()).data as Out;
      expect(out.prs[0]).toMatchObject({ author: { login: 'app/dependabot' }, reviewDecision: '' });
      expect(out.prs[1]).toMatchObject({ author: { login: 'app/' }, reviewRequests: ['dana'] });
      expect(out.issues[0]).toMatchObject({ labels: [], assignees: [] });
    });

    it('drops a just-reopened issue the search index still lists as closed', async () => {
      fixture('main', mainResponse({ closed: conn([closedNode(20), { ...closedNode(21), closedAt: null }]), merged: conn([]) }));
      const out = (await run(WINDOWS)).data as Out;
      expect(out.recentlyClosed?.map((i) => i.number)).toEqual([20]);
      expect(typeof parseOverviewBundle(out, true)).toBe('object');
    });

    it('emits exactly the contract fields, which the contract validator accepts', async () => {
      fixture('main', mainResponse({ closed: conn([closedNode(20)]), merged: conn([mergedNode(30)]) }));
      const out = (await run(WINDOWS)).data as Out;
      expect(Object.keys(out.prs[0]).sort()).toEqual(['author', 'body', 'createdAt', 'isDraft', 'number', 'reviewDecision', 'reviewRequests', 'title', 'url']);
      expect(Object.keys(out.issues[0]).sort()).toEqual(['assignees', 'author', 'createdAt', 'labels', 'number', 'title', 'url']);
      expect(out.issues[0]).toMatchObject({ labels: [{ name: 'area/tower' }], assignees: [{ login: 'carol' }] });
      expect(Object.keys(out.recentlyClosed![0]).sort()).toEqual(['closedAt', 'createdAt', 'labels', 'number', 'title', 'url']);
      expect(Object.keys(out.recentlyMerged![0]).sort()).toEqual(['body', 'createdAt', 'headRefName', 'mergedAt', 'number', 'title', 'url']);
      expect(typeof parseOverviewBundle(out, true)).toBe('object');
    });
  });

  describe('errors', () => {
    const windowError = (message: string) => ({
      ...mainResponse({ closed: null, merged: conn([mergedNode(30)]) }),
      errors: [{ message, path: ['closed'] }],
    });

    it('an error only on a window path: the open lists plus windowsError, exit 0', async () => {
      fixture('main', windowError('Search timed out'), { exit: 1, stderr: 'gh: Search timed out' });
      const result = await run(WINDOWS);
      expect(result.error).toBeNull();
      const out = result.data as Out;
      expect(out.windowsError).toBe('Search timed out');
      expect(out.prs).toHaveLength(1);
      expect(out.issues).toHaveLength(1);
      expect(out.recentlyClosed).toBeUndefined();
      expect(out.recentlyMerged).toBeUndefined();
    });

    it('an empty error message still salvages with a named reason', async () => {
      fixture('main', { ...mainResponse({ closed: null, merged: null }), errors: [{ message: '', path: ['closed'] }] }, { exit: 1 });
      expect(((await run(WINDOWS)).data as Out).windowsError).toBe('window search failed');
    });

    it('a window-only error does not cut the open-issue paging short', async () => {
      fixture('main', {
        ...mainResponse({ issues: conn(range(1, 100).map((n) => issueNode(n)), 'a1'), closed: null, merged: null }),
        errors: [{ message: 'Search unavailable', path: ['closed'] }, { message: 'Search unavailable', path: ['merged'] }],
      }, { exit: 1 });
      fixture('issues-a1', { data: { repository: { issues: conn(range(101, 100).map((n) => issueNode(n))) } } });
      const out = (await run(WINDOWS)).data as Out;
      expect(out.issues).toHaveLength(200);
      expect(out.windowsError).toBe('Search unavailable; Search unavailable');
    });

    it('an error on an open-list path fails the whole call', async () => {
      fixture('main', { ...mainResponse({ closed: conn([]), merged: conn([]) }), errors: [{ message: 'boom', path: ['repository', 'issues'] }] }, { exit: 1 });
      const result = await run(WINDOWS);
      expect(result.data).toBeNull();
      expect(result.error?.exitCode).toBe(1);
    });

    it('a window-path error with an open connection missing fails the whole call', async () => {
      fixture('main', {
        data: { repository: { pullRequests: { nodes: [] }, issues: null }, closed: null, merged: conn([]) },
        errors: [{ message: 'x', path: ['closed'] }],
      }, { exit: 1 });
      expect((await run(WINDOWS)).error?.exitCode).toBe(1);
    });

    it('a top-level rate limit fails the whole call and passes gh\'s stderr through', async () => {
      const message = 'API rate limit exceeded for user ID 12345.';
      fixture('main', { errors: [{ type: 'RATE_LIMITED', message }] }, { exit: 1, stderr: `gh: ${message}` });
      const result = await run(WINDOWS);
      expect(result.data).toBeNull();
      expect(result.error?.exitCode).toBe(1);
      expect(result.error?.stderr).toContain(message);
      expect(isRateLimitError(result.error!.stderr)).toBe(true);
    });

    it('a window-only error is not salvaged when the windows were not requested', async () => {
      fixture('main', windowError('x'), { exit: 1 });
      expect((await run()).error?.exitCode).toBe(1);
    });

    it('non-JSON output fails the whole call, whatever gh exits with', async () => {
      fixture('main', 'HTTP 502 Bad Gateway', { exit: 1 });
      expect((await run(WINDOWS)).error?.exitCode).toBe(1);
      fs.writeFileSync(path.join(tmp, 'main.exit'), '0');
      expect((await run(WINDOWS)).error?.exitCode).toBe(1);
    });

    it('a failed window follow-up page on its own path becomes windowsError', async () => {
      fixture('main', mainResponse({ closed: conn(range(1, 100).map(closedNode), 'c1'), merged: conn([mergedNode(30)]) }));
      fixture('closed-c1', { data: { closed: null }, errors: [{ message: 'Search timed out', path: ['closed'] }] }, { exit: 1 });
      const out = (await run(WINDOWS)).data as Out;
      expect(out.windowsError).toBe('Search timed out');
      expect(out.issues).toHaveLength(1);
    });

    it('a top-level error on a window follow-up page fails the whole call', async () => {
      fixture('main', mainResponse({ closed: conn(range(1, 100).map(closedNode), 'c1'), merged: conn([]) }));
      fixture('closed-c1', { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, { exit: 1, stderr: 'gh: API rate limit exceeded' });
      const result = await run(WINDOWS);
      expect(result.error?.exitCode).toBe(1);
      expect(result.error?.stderr).toContain('API rate limit exceeded');
    });

    it('a failed issues follow-up page fails the whole call', async () => {
      fixture('main', mainResponse({ issues: conn(range(1, 100).map((n) => issueNode(n)), 'a1') }));
      fixture('issues-a1', { errors: [{ message: 'Something went wrong' }] }, { exit: 1 });
      expect((await run()).error?.exitCode).toBe(1);
    });

    it('a call killed mid-paging prints nothing: a failure, never a partial result', async () => {
      fixture('main', mainResponse({ issues: conn(range(1, 100).map((n) => issueNode(n)), 'a1') }));
      fixture('issues-a1', { data: { repository: { issues: conn([]) } } }, { sleep: 2 });
      const result = await run({}, 500);
      expect(result.data).toBeNull();
      expect(result.error?.timedOut).toBe(true);
    });
  });
});

// =============================================================================
// fetchForOverview('overview-bundle') — inputs, budgets, validation
// =============================================================================

const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const TWO_DAYS_AGO = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
const pr = (o: Node = {}): Node => ({
  number: 1, title: 't', url: 'u', reviewDecision: '', body: '', createdAt: HOUR_AGO,
  author: { login: 'a' }, reviewRequests: [], isDraft: false, ...o,
});
const issue = (o: Node = {}): Node => ({
  number: 2, title: 't', url: 'u', labels: [{ name: 'bug' }], createdAt: HOUR_AGO,
  author: { login: 'a' }, assignees: [{ login: 'b' }], ...o,
});
const closed = (o: Node = {}): Node => ({ number: 3, title: 't', url: 'u', labels: [], createdAt: HOUR_AGO, closedAt: HOUR_AGO, ...o });
const merged = (o: Node = {}): Node => ({
  number: 4, title: 't', url: 'u', body: '', createdAt: HOUR_AGO, mergedAt: HOUR_AGO, headRefName: 'b', ...o,
});
const bundle = (o: Node = {}): Node => ({ prs: [pr()], issues: [issue()], recentlyClosed: [closed()], recentlyMerged: [merged()], ...o });

describe('Spec 1995 — fetchForOverview(overview-bundle)', () => {
  const dispatch = vi.mocked(executeForgeCommandDetailed);
  beforeEach(() => dispatch.mockClear());
  const answer = (data: unknown) => dispatch.mockResolvedValueOnce({ data, error: null });

  it('asks for the windows, with the 24 h cutoff, only when includeWindows', async () => {
    answer(bundle());
    await fetchForOverview('overview-bundle', '/ws', { includeWindows: true });
    const [, withWindows] = dispatch.mock.calls[0];
    expect(withWindows.CODEV_INCLUDE_WINDOWS).toBe('1');
    const cutoff = Date.parse(withWindows.CODEV_SINCE_DATE as string);
    expect(Math.abs(cutoff - (Date.now() - 24 * 60 * 60 * 1000))).toBeLessThan(60_000);

    answer({ prs: [], issues: [] });
    await fetchForOverview('overview-bundle', '/ws');
    // Set, not omitted: an inherited CODEV_INCLUDE_WINDOWS=1 would buy discarded windows.
    expect(dispatch.mock.calls[1][1]).toEqual({ CODEV_INCLUDE_WINDOWS: '' });
  });

  it('passes its own named time and output budgets', async () => {
    answer({ prs: [], issues: [] });
    await fetchForOverview('overview-bundle', '/ws');
    expect(dispatch.mock.calls[0][0]).toBe('overview-bundle');
    expect(dispatch.mock.calls[0][2]).toEqual({ cwd: '/ws', timeoutMs: OVERVIEW_BUNDLE_TIMEOUT_MS, maxBuffer: OVERVIEW_BUNDLE_MAX_BUFFER });
    expect(OVERVIEW_BUNDLE_TIMEOUT_MS).toBe(60_000);
    expect(OVERVIEW_BUNDLE_MAX_BUFFER).toBe(40 * 1024 * 1024);
  });

  it('passes a failed call through unchanged', async () => {
    const error = { message: 'boom', stderr: 'gh: API rate limit exceeded', exitCode: 1, timedOut: false };
    dispatch.mockResolvedValueOnce({ data: null, error });
    expect(await fetchForOverview('overview-bundle', '/ws', { includeWindows: true })).toEqual({ data: null, error });
  });

  it('non-conforming output becomes a failed call naming section, index and field', async () => {
    answer(bundle({ prs: [pr(), pr({ isDraft: undefined })] }));
    const r = await fetchForOverview('overview-bundle', '/ws', { includeWindows: true });
    expect(r.data).toBeNull();
    expect(r.error?.message).toContain('prs[1].isDraft is missing');
  });

  it('filters the windows to the last 24 h and drops windows nobody asked for', async () => {
    answer(bundle({ recentlyClosed: [closed(), closed({ number: 5, closedAt: TWO_DAYS_AGO })] }));
    const r = await fetchForOverview('overview-bundle', '/ws', { includeWindows: true });
    expect((r.data as { recentlyClosed: Node[] }).recentlyClosed.map((i) => i.number)).toEqual([3]);

    answer(bundle());
    const openOnly = await fetchForOverview('overview-bundle', '/ws');
    expect(Object.keys(openOnly.data as object).sort()).toEqual(['issues', 'prs']);
  });
});

describe('Spec 1995 — overview-bundle contract validation', () => {
  it('accepts a conforming bundle, with or without windows', () => {
    expect(parseOverviewBundle(bundle(), true)).toMatchObject({ prs: [pr()], issues: [issue()] });
    expect(parseOverviewBundle({ prs: [], issues: [] }, false)).toEqual({ prs: [], issues: [] });
  });

  it('windowsError alone passes; with the window arrays it does not', () => {
    expect(parseOverviewBundle({ prs: [], issues: [], windowsError: 'Search timed out' }, true))
      .toEqual({ prs: [], issues: [], windowsError: 'Search timed out' });
    expect(parseOverviewBundle(bundle({ windowsError: 'x' }), true)).toBe('windowsError is present together with window arrays');
    expect(parseOverviewBundle({ prs: [], issues: [], windowsError: ' ' }, true)).toBe('windowsError is not a non-empty string');
  });

  it.each([
    ['not an object', [], 'output is not a JSON object'],
    ['issues missing', { prs: [] }, 'issues is missing'],
    ['prs not an array', { prs: {}, issues: [] }, 'prs is not an array'],
    ['windows requested and missing', { prs: [], issues: [] }, 'recentlyClosed is missing'],
    ['one window missing', bundle({ recentlyMerged: undefined }), 'recentlyMerged is missing'],
    ['a PR without isDraft', bundle({ prs: [pr({ isDraft: undefined })] }), 'prs[0].isDraft is missing'],
    ['an issue without url', bundle({ issues: [issue(), issue({ url: undefined })] }), 'issues[1].url is missing'],
    ['a merged PR without headRefName', bundle({ recentlyMerged: [merged({ headRefName: undefined })] }), 'recentlyMerged[0].headRefName is missing'],
    ['a label without a name', bundle({ issues: [issue({ labels: [{}] })] }), 'issues[0].labels has the wrong type'],
    ['reviewRequests as objects', bundle({ prs: [pr({ reviewRequests: [{ login: 'x' }] })] }), 'prs[0].reviewRequests has the wrong type'],
    ['an author without a login', bundle({ prs: [pr({ author: {} })] }), 'prs[0].author has the wrong type'],
    ['an assignee login not a string', bundle({ issues: [issue({ assignees: [{ login: 7 }] })] }), 'issues[0].assignees has the wrong type'],
    ['an optional field of the wrong type', bundle({ issues: [issue({ createdAt: 5 })] }), 'issues[0].createdAt has the wrong type'],
    ['a closed issue without closedAt', bundle({ recentlyClosed: [closed({ closedAt: undefined })] }), 'recentlyClosed[0].closedAt is missing'],
    ['an unparseable mergedAt', bundle({ recentlyMerged: [merged({ mergedAt: 'yesterday-ish' })] }), 'recentlyMerged[0].mergedAt has the wrong type'],
    ['an item not an object', bundle({ issues: [null] }), 'issues[0] is not an object'],
  ])('%s is reported', (_name, raw, message) => {
    expect(parseOverviewBundle(raw, true)).toBe(message);
  });

  it('a window item that would fail is ignored when the windows were not requested', () => {
    expect(parseOverviewBundle(bundle({ recentlyClosed: [{}] }), false)).toEqual({ prs: [pr()], issues: [issue()] });
  });
});

describe('Spec 1995 — overview-bundle presets, backend and issue-id kind', () => {
  const script = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'forge', 'github', 'overview-bundle.sh');

  it('runs the github script with no config and on github', () => {
    expect(getForgeCommand('overview-bundle', null)).toBe(script);
    expect(getForgeCommand('overview-bundle', { provider: 'github' })).toBe(script);
  });

  it.skipIf(process.platform === 'win32')('the github script is executable', () => {
    expect(fs.statSync(script).mode & 0o111).not.toBe(0);
  });

  it.each(['gitlab', 'gitea', 'linear', 'jira'])('%s disables it — never a silent fall-through to gh', (provider) => {
    expect(getForgeCommand('overview-bundle', { provider })).toBeNull();
    expect(resolveAllConcepts({ provider }).find((r) => r.concept === 'overview-bundle')?.source).toBe('disabled');
  });

  it('every built-in provider is covered by the cases above', () => {
    expect(getKnownProviders().sort()).toEqual(['gitea', 'github', 'gitlab', 'jira', 'linear']);
  });

  it('resolveAllConcepts lists 21 concepts, the bundle among them', () => {
    const all = resolveAllConcepts({ provider: 'github' });
    expect(all).toHaveLength(21);
    expect(all.find((r) => r.concept === 'overview-bundle')).toMatchObject({ source: 'preset', executable: 'gh' });
  });

  it('spends the gh budget', () => {
    const backend = resolveForgeBackend('overview-bundle', { forgeConfig: { provider: 'github' } });
    expect(backend).toBe('gh');
    expect(budgetKeyFor(backend as string, 'overview-bundle')).toBe('gh');
  });

  it('an override of the bundle stops vouching for the id shape; a preset disable does not', () => {
    expect(resolveIssueIdKind({ 'overview-bundle': './my-bundle.sh' })).toBeUndefined();
    expect(resolveIssueIdKind({ provider: 'linear', 'overview-bundle': './my-bundle.sh' })).toBeUndefined();
    expect(resolveIssueIdKind({ provider: 'linear' })).toBe('key');
    expect(resolveIssueIdKind({ provider: 'jira' })).toBe('key');
    expect(resolveIssueIdKind({ provider: 'linear', 'overview-bundle': null })).toBe('key');
    expect(resolveIssueIdKind({ provider: 'github' })).toBe('number');
  });
});
