/**
 * Spec 1995 — the real OverviewCache, forge layer and shipped github scripts
 * against a fake `gh` on PATH (the #1645 harness pattern), scenario 20: a
 * watched workspace makes one forge call per refresh window, one `gh` per
 * refresh on a ≤100-issue repo and two on a 250-issue repo.
 *
 * The fake answers both transports for one repository state: `gh pr list` /
 * `gh issue list` in gh's `--json` rendering, and `gh api graphql` as raw
 * GraphQL. So the payload parity check (7) runs the real scripts on both
 * paths, including the fields where gh's rendering differs from GraphQL.
 *
 * Every test reads its path from config on disk, so each asserts it first.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { dbState } = vi.hoisted(() => ({ dbState: { globalDbPath: '' } }));
vi.mock('../db/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/index.js')>();
  return { ...actual, getGlobalDbPath: () => dbState.globalDbPath };
});

import { OverviewCache } from '../servers/overview.js';
import { overviewPath } from '../../lib/github.js';

function hasJq(): boolean {
  try {
    execFileSync('sh', ['-c', 'command -v jq'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A fake `gh`. Each call is logged by what it asked for and served from the
 * fixture file of that name: `graphql <main|issues-page|closed-page|merged-page>[-<cursor>]`,
 * `pr-list`, `pr-list-merged`, `issue-list`, `issue-list-closed`, `api user`.
 */
const GH_STUB = `#!/bin/sh
dir="$(dirname "$0")"
serve() { echo "$1" >> "$dir/gh-calls"; cat "$dir/$2.json"; exit 0; }
case "$1 $2" in
  "api user") echo "api user" >> "$dir/gh-calls"; echo octocat; exit 0 ;;
  "api graphql")
    q=""; after=""
    for a in "$@"; do
      case "$a" in query=*) q="\${a#query=}" ;; after=*) after="\${a#after=}" ;; esac
    done
    case "$q" in
      *"pullRequests("*) name=main ;;
      *"closed: search("*) name=closed-page ;;
      *"merged: search("*) name=merged-page ;;
      *"issues("*) name=issues-page ;;
      *) echo "unexpected query" >&2; exit 98 ;;
    esac
    [ -n "$after" ] && name="$name-$after"
    serve "graphql $name" "graphql-$name" ;;
  "pr list")
    case " $* " in *" --state merged "*) serve pr-list-merged pr-list-merged ;; *) serve pr-list pr-list ;; esac ;;
  "issue list")
    case " $* " in *" --state closed "*) serve issue-list-closed issue-list-closed ;; *) serve issue-list issue-list ;; esac ;;
esac
echo "unexpected gh call: $*" >&2
exit 97
`;

// =============================================================================
// One repository state, rendered by gh's --json and by raw GraphQL
// =============================================================================

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

type Author = { login: string; bot?: boolean } | null;
interface Pr { n: number; title: string; body: string; isDraft: boolean; reviewDecision: string | null; author: Author; reviewers: Array<{ type: 'User' | 'Team' | 'Bot'; name: string }> }
interface Issue { n: number; title: string; labels: string[]; assignees: string[]; author: Author }
interface Closed { n: number; title: string; labels: string[]; closedAt: string }
interface Merged { n: number; title: string; body: string; mergedAt: string }
interface Repo { prs: Pr[]; issues: Issue[]; closed: Closed[]; merged: Merged[] }

const prUrl = (n: number) => `https://github.com/o/r/pull/${n}`;
const issueUrl = (n: number) => `https://github.com/o/r/issues/${n}`;
const CREATED = '2026-11-20T00:00:00Z';

/** gh's `--json` author: a bot as `app/<login>`, a deleted account as `app/`. */
const ghAuthor = (a: Author) => (a === null
  ? { is_bot: true, login: 'app/' }
  : { id: `ID_${a.login}`, is_bot: a.bot === true, login: a.bot ? `app/${a.login}` : a.login, name: a.bot ? '' : a.login.toUpperCase() });
const gqlAuthor = (a: Author) => (a === null ? null : { login: a.login, __typename: a.bot ? 'Bot' : 'User' });
const ghLabels = (names: string[]) => names.map(name => ({ id: `L_${name}`, name, description: '', color: 'ededed' }));

function ghRender(repo: Repo) {
  return {
    'pr-list': repo.prs.map(p => ({
      number: p.n, title: p.title, url: prUrl(p.n), reviewDecision: p.reviewDecision ?? '', body: p.body, createdAt: CREATED,
      author: ghAuthor(p.author), isDraft: p.isDraft,
      // gh's export keeps user and team reviewers; bots (Copilot) are dropped.
      reviewRequests: p.reviewers.filter(r => r.type !== 'Bot').map(r => (r.type === 'User'
        ? { __typename: 'User', login: r.name }
        : { __typename: 'Team', name: r.name, slug: r.name })),
    })),
    'issue-list': repo.issues.map(i => ({
      number: i.n, title: i.title, url: issueUrl(i.n), createdAt: CREATED, author: ghAuthor(i.author),
      labels: ghLabels(i.labels), assignees: i.assignees.map(login => ({ id: `ID_${login}`, login, name: login })),
    })),
    'issue-list-closed': repo.closed.map(c => ({
      number: c.n, title: c.title, url: issueUrl(c.n), createdAt: CREATED, closedAt: c.closedAt, labels: ghLabels(c.labels),
    })),
    'pr-list-merged': repo.merged.map(m => ({
      number: m.n, title: m.title, url: prUrl(m.n), body: m.body, createdAt: CREATED, mergedAt: m.mergedAt, headRefName: `builder/spir-${m.n}`,
    })),
  };
}

const gqlIssue = (i: Issue) => ({
  number: i.n, title: i.title, url: issueUrl(i.n), createdAt: CREATED, author: gqlAuthor(i.author),
  labels: { nodes: i.labels.map(name => ({ name })) }, assignees: { nodes: i.assignees.map(login => ({ login })) },
});
const page = (nodes: unknown[], next?: string) => ({ pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null }, nodes });

/** The bundle's main response; issues past the first 100 go to follow-up pages `c1`, `c2`, …. */
function gqlRender(repo: Repo): Record<string, unknown> {
  const issuePages: Issue[][] = [];
  for (let i = 0; i < repo.issues.length; i += 100) issuePages.push(repo.issues.slice(i, i + 100));
  if (issuePages.length === 0) issuePages.push([]);
  const cursor = (k: number) => (k + 1 < issuePages.length ? `c${k + 1}` : undefined);
  const files: Record<string, unknown> = {
    'graphql-main': {
      data: {
        repository: {
          pullRequests: {
            nodes: repo.prs.map(p => ({
              number: p.n, title: p.title, url: prUrl(p.n), reviewDecision: p.reviewDecision, body: p.body, createdAt: CREATED,
              isDraft: p.isDraft, author: gqlAuthor(p.author),
              reviewRequests: {
                nodes: p.reviewers.map(r => ({
                  requestedReviewer: r.type === 'Team' ? { __typename: 'Team' } : { __typename: r.type, login: r.name },
                })),
              },
            })),
          },
          issues: page(issuePages[0].map(gqlIssue), cursor(0)),
        },
        closed: page(repo.closed.map(c => ({
          number: c.n, title: c.title, url: issueUrl(c.n), createdAt: CREATED, closedAt: c.closedAt,
          labels: { nodes: c.labels.map(name => ({ name })) },
        }))),
        merged: page(repo.merged.map(m => ({
          number: m.n, title: m.title, url: prUrl(m.n), body: m.body, createdAt: CREATED, mergedAt: m.mergedAt, headRefName: `builder/spir-${m.n}`,
        }))),
      },
    },
  };
  for (let k = 1; k < issuePages.length; k++) {
    files[`graphql-issues-page-c${k}`] = { data: { repository: { issues: page(issuePages[k].map(gqlIssue), cursor(k)) } } };
  }
  return files;
}

const issueRange = (count: number): Issue[] => Array.from({ length: count }, (_, k) => ({
  n: 1000 - k, title: `Issue ${1000 - k}`, labels: [], assignees: [], author: { login: 'bob' },
}));
const smallRepo = (): Repo => ({
  prs: [{ n: 1, title: 'A PR', body: '', isDraft: false, reviewDecision: 'APPROVED', author: { login: 'alice' }, reviewers: [] }],
  issues: issueRange(3),
  closed: [{ n: 20, title: 'Closed', labels: [], closedAt: ago(HOUR) }],
  merged: [{ n: 30, title: 'Merged', body: '', mergedAt: ago(HOUR) }],
});

// =============================================================================
// Harness
// =============================================================================

let tmpDir: string;
let bin: string;
const originalPath = process.env.PATH;

function writeRepo(repo: Repo): void {
  for (const file of fs.readdirSync(bin)) if (file.endsWith('.json')) fs.rmSync(path.join(bin, file));
  for (const [name, body] of Object.entries({ ...ghRender(repo), ...gqlRender(repo) })) {
    fs.writeFileSync(path.join(bin, `${name}.json`), JSON.stringify(body));
  }
}
const ghCalls = () => {
  const log = path.join(bin, 'gh-calls');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : [];
};
const clearCalls = () => fs.rmSync(path.join(bin, 'gh-calls'), { force: true });

function makeWorkspace(name: string, forge?: Record<string, unknown>): string {
  const workspace = path.join(tmpDir, name);
  fs.mkdirSync(path.join(workspace, '.codev'), { recursive: true });
  setForge(workspace, forge);
  return workspace;
}
function setForge(workspace: string, forge?: Record<string, unknown>): void {
  const config = path.join(workspace, '.codev', 'config.json');
  if (forge) fs.writeFileSync(config, JSON.stringify({ forge }));
  else fs.rmSync(config, { force: true });
}

describe.skipIf(process.platform === 'win32' || !hasJq())('Spec 1995 — overview against a fake gh (20)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1995-gh-'));
    dbState.globalDbPath = path.join(tmpDir, 'global.db');
    bin = path.join(tmpDir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'gh'), GH_STUB);
    fs.chmodSync(path.join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ''}`;
  });
  afterAll(() => {
    process.env.PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  beforeEach(clearCalls);

  /** Poll every 2.5 s for `ms` on an injected clock; returns the gh calls of each refresh. */
  async function pollRefreshes(workspace: string, ms: number): Promise<string[][]> {
    let clock = Date.now();
    const cache = new OverviewCache({ now: () => clock });
    const refreshes: string[][] = [];
    for (let t = 0; t <= ms; t += 2_500) {
      clock += t === 0 ? 0 : 2_500;
      const before = ghCalls().length;
      await cache.getOverview(workspace);
      const made = ghCalls().slice(before).filter(c => c !== 'api user');
      if (made.length > 0) refreshes.push(made);
    }
    return refreshes;
  }

  it('≤100 open issues: one gh per refresh, one refresh per 180 s window', async () => {
    writeRepo(smallRepo());
    const workspace = makeWorkspace('small');
    expect(overviewPath(workspace)).toEqual({ kind: 'bundle' });
    const refreshes = await pollRefreshes(workspace, 540_000);
    expect(refreshes).toEqual([['graphql main'], ['graphql main'], ['graphql main'], ['graphql main']]);
    expect(ghCalls().filter(c => c === 'api user')).toHaveLength(1);
  });

  it('250 open issues: two gh per refresh, and the backlog keeps the newest 200 (6)', async () => {
    writeRepo({ ...smallRepo(), issues: issueRange(250) });
    const workspace = makeWorkspace('large');
    expect(overviewPath(workspace)).toEqual({ kind: 'bundle' });
    const refreshes = await pollRefreshes(workspace, 360_000);
    expect(refreshes).toEqual(Array(3).fill(['graphql main', 'graphql issues-page-c1']));
    const data = await new OverviewCache().getOverview(workspace);
    expect(data.backlog).toHaveLength(200);
    expect(data.backlog.at(-1)!.id).toBe('801');
  });

  it("payload parity on the real scripts: the bundle's raw GraphQL and the four calls' gh --json give an equal payload (7)", async () => {
    writeRepo({
      prs: [
        { n: 1, title: '[Spec 42] Draft', body: 'Fixes #42', isDraft: true, reviewDecision: null, author: { login: 'alice' }, reviewers: [] },
        {
          n: 2, title: 'Bump deps', body: '', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', author: { login: 'dependabot', bot: true },
          reviewers: [{ type: 'User', name: 'carol' }, { type: 'Team', name: 'core' }, { type: 'Bot', name: 'copilot' }],
        },
        { n: 3, title: 'Orphaned', body: '', isDraft: false, reviewDecision: 'APPROVED', author: null, reviewers: [{ type: 'Team', name: 'core' }] },
      ],
      issues: [
        { n: 42, title: 'Collapse the overview calls', labels: ['area/tower'], assignees: ['dave'], author: { login: 'bob' } },
        { n: 43, title: 'No labels, no assignees', labels: [], assignees: [], author: { login: 'bob' } },
        { n: 45, title: 'Builder issue', labels: ['bug', 'area/porch'], assignees: [], author: { login: 'erin' } },
      ],
      closed: [
        { n: 50, title: 'Yesterday', labels: ['bug'], closedAt: ago(20 * HOUR) },
        { n: 51, title: 'This morning', labels: [], closedAt: ago(HOUR) },
        { n: 52, title: 'Midday', labels: ['spec'], closedAt: ago(8 * HOUR) },
        { n: 53, title: 'Outside the window', labels: [], closedAt: ago(25 * HOUR) },
      ],
      merged: [
        { n: 60, title: 'Fix 51', body: 'Fixes #51', mergedAt: ago(2 * HOUR) },
        { n: 61, title: 'Fix 50, long ago', body: 'Fixes #50', mergedAt: ago(26 * HOUR) },
      ],
    });
    const workspace = makeWorkspace('parity');
    const project = path.join(workspace, '.builders', 'spir-45-builder', 'codev', 'projects', '0045-builder');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'status.yaml'), ["id: '0045'", 'protocol: spir', 'phase: implement', 'gates:'].join('\n'));
    fs.mkdirSync(path.join(workspace, 'codev', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'codev', 'specs', '51-closed.md'), '# 51');

    expect(overviewPath(workspace)).toEqual({ kind: 'bundle' });
    const bundled = await new OverviewCache().getOverview(workspace);
    expect(ghCalls().sort()).toEqual(['api user', 'graphql main']);

    clearCalls();
    setForge(workspace, { 'overview-bundle': null });
    expect(overviewPath(workspace)).toEqual({ kind: 'four-call', reason: 'forge config disables overview-bundle' });
    const fourCall = await new OverviewCache().getOverview(workspace);
    expect(ghCalls().sort()).toEqual(['api user', 'issue-list', 'issue-list-closed', 'pr-list', 'pr-list-merged']);

    expect(bundled).toEqual(fourCall);
    expect(bundled.pendingPRs.map(p => [p.id, p.author, p.reviewStatus, p.reviewRequests, p.isDraft])).toEqual([
      ['1', 'alice', 'REVIEW_REQUIRED', [], true],
      ['2', 'app/dependabot', 'REVIEW_REQUIRED', ['carol'], false],
      ['3', 'app/', 'APPROVED', [], false],
    ]);
    expect(bundled.backlog.map(b => b.id)).toEqual(['43', '45']);
    expect(bundled.recentlyClosed.map(c => c.id)).toEqual(['51', '52', '50']);
    expect(bundled.recentlyClosed[0]).toMatchObject({ prUrl: prUrl(60), specPath: 'codev/specs/51-closed.md' });
    expect(bundled.builders.map(b => [b.issueId, b.issueTitle, b.area])).toEqual([['45', 'Builder issue', 'porch']]);
  });

  it('an issue-list override takes the four calls and is honoured; the bundle never runs (14)', async () => {
    writeRepo(smallRepo());
    const override = path.join(tmpDir, 'my-issues.json');
    fs.writeFileSync(override, JSON.stringify([{ number: 7, title: 'From the override', url: issueUrl(7), labels: [] }]));
    const workspace = makeWorkspace('override', { 'issue-list': `cat '${override}'` });
    expect(overviewPath(workspace)).toEqual({ kind: 'four-call', reason: 'forge config overrides issue-list' });
    const data = await new OverviewCache().getOverview(workspace);
    expect(data.backlog.map(b => b.id)).toEqual(['7']);
    expect(ghCalls().sort()).toEqual(['api user', 'issue-list-closed', 'pr-list', 'pr-list-merged']);
  });

  it("a project's own overview-bundle command is used, and no constituent runs (16)", async () => {
    writeRepo(smallRepo());
    const own = path.join(tmpDir, 'my-bundle.json');
    fs.writeFileSync(own, JSON.stringify({
      prs: [{ number: 9, title: 'Own PR', url: prUrl(9), reviewDecision: '', body: '', createdAt: CREATED, reviewRequests: [], isDraft: false }],
      issues: [{ number: 8, title: 'Own issue', url: issueUrl(8), labels: [] }],
      recentlyClosed: [{ number: 7, title: 'Own closed', url: issueUrl(7), labels: [], closedAt: ago(HOUR) }],
      recentlyMerged: [],
    }));
    const workspace = makeWorkspace('own-bundle', { 'overview-bundle': `cat '${own}'` });
    expect(overviewPath(workspace)).toEqual({ kind: 'bundle' });
    const data = await new OverviewCache().getOverview(workspace);
    expect([data.pendingPRs.map(p => p.id), data.backlog.map(b => b.id), data.recentlyClosed.map(c => c.id)]).toEqual([['9'], ['8'], ['7']]);
    expect(data.forgeStatus).toBe('ok');
    expect(ghCalls()).toEqual(['api user']);
  });
});
