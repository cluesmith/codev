/**
 * Regression test for bugfix #1137: the gitea forge preset was written against
 * the Gitea REST API JSON shape but invoked the `tea` CLI's flattened
 * `<entity> list/view` output (or non-existent flags/subcommands), so every
 * read concept either errored or emitted the wrong shape.
 *
 * The fix routes the read concepts through `tea api <endpoint>`, whose raw
 * passthrough returns exactly the Gitea REST shape the jq normalizers and
 * `forge-contracts.ts` already assume.
 *
 * PR #1146 review follow-up:
 *   - list reads (`pr-exists`, `pr-list`, `recently-merged`) now PAGINATE via
 *     the shared `tea_api_paged` helper (Gitea caps a page at max_response_items,
 *     default 50, so `&limit=200` silently truncated). The fake `tea` below
 *     serves a full 50-item page 1 + a short page 2 and the tests assert an item
 *     that only exists on page 2 is found.
 *   - the `owner/repo` derivation is factored into `_lib.sh#gitea_repo` and fails
 *     fast (stderr + non-zero exit) when there's no usable origin remote.
 *   - `issue-view` warns on stderr when the comments fetch degrades to [].
 *
 * `tea` isn't available in CI (see the in-repo #920 note), so this test stubs a
 * fake `tea` on PATH that answers `api <endpoint>` (and `comments add`) with
 * captured Gitea REST fixtures, points the scripts at a throwaway git repo with
 * a gitea remote, runs each real script, and asserts the normalized output
 * conforms to the contract in forge-contracts.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const giteaDir = resolve(__dirname, '..', '..', 'scripts', 'forge', 'gitea');

// A fake `tea` binary. It only implements `api <endpoint>` (the surface the
// fixed scripts use) plus `comments add`. Each endpoint returns the raw Gitea
// REST shape — nested objects, real `.merged`/`.merged_at`/`.draft`, integer
// `comments` count on the issue object, etc.
//
// The paginated list endpoints (page=1 full at limit 50, page=2 short) prove the
// scripts walk past the server's page cap: each carries a "signature" item plus
// filler, and a distinct item that lives ONLY on page 2.
const FAKE_TEA = `#!/bin/sh
if [ "$1" = "comments" ] && [ "$2" = "add" ]; then
  # comments add <id> <body>
  echo "commented"
  exit 0
fi
[ "$1" = "api" ] || { echo "fake-tea: unsupported: $*" >&2; exit 3; }
case "$2" in
  user)
    echo '{"login":"octo","id":7}' ;;
  repos/acme/widgets/pulls/42)
    echo '{"number":42,"title":"Add widget","body":"PR body","state":"open","html_url":"https://git.example.com/acme/widgets/pulls/42","url":"https://git.example.com/api/v1/repos/acme/widgets/pulls/42","user":{"login":"alice"},"base":{"ref":"main"},"head":{"ref":"feature/x"},"additions":10,"deletions":3}' ;;

  # --- pr-exists: state=all, paginated -------------------------------------
  # page 1 = 50 items (open feature/x, merged feature/done, closed-not-merged
  # feature/abandoned, + 47 open pad). page 2 = 1 merged item on feature/deep.
  "repos/acme/widgets/pulls?state=all&limit=50&page=1")
    jq -cn '[{number:42,state:"open",merged:false,head:{ref:"feature/x"}},{number:40,state:"closed",merged:true,head:{ref:"feature/done"}},{number:39,state:"closed",merged:false,head:{ref:"feature/abandoned"}}] + [range(47)|{number:(1000+.),state:"open",merged:false,head:{ref:("pad-"+(.|tostring))}}]' ;;
  "repos/acme/widgets/pulls?state=all&limit=50&page=2")
    echo '[{"number":900,"state":"closed","merged":true,"head":{"ref":"feature/deep"}}]' ;;

  # --- pr-list: state=open, paginated --------------------------------------
  # page 1 = the rich #42 item + 49 pad (50 total). page 2 = 1 item (#900).
  "repos/acme/widgets/pulls?state=open&limit=50&page=1")
    jq -cn '[{number:42,title:"Add widget",html_url:"https://git.example.com/acme/widgets/pulls/42",url:"https://git.example.com/api/v1/repos/acme/widgets/pulls/42",body:"PR body",state:"open",created_at:"2026-07-01T10:00:00Z",user:{login:"alice"},requested_reviewers:[{login:"bob"},{login:null}],draft:true}] + [range(49)|{number:(1000+.),title:"pad",html_url:"u",body:"",state:"open",created_at:"d",user:{login:"pad"},requested_reviewers:[],draft:false}]' ;;
  "repos/acme/widgets/pulls?state=open&limit=50&page=2")
    echo '[{"number":900,"title":"Deep open PR","html_url":"https://git.example.com/acme/widgets/pulls/900","body":"deep","state":"open","created_at":"2026-07-01T11:00:00Z","user":{"login":"erin"},"requested_reviewers":[],"draft":false}]' ;;

  # --- recently-merged: state=closed, paginated ----------------------------
  # page 1 = 50 items, only #40 merged (the rest merged:false pad). page 2 = 1
  # merged item (#901) — so a merged PR beyond page 1 must still surface.
  "repos/acme/widgets/pulls?state=closed&limit=50&page=1")
    jq -cn '[{number:40,title:"Done PR",html_url:"https://git.example.com/acme/widgets/pulls/40",body:"merged body",state:"closed",merged:true,merged_at:"2026-07-05T12:00:00Z",created_at:"2026-07-02T09:00:00Z",head:{ref:"feature/done"}},{number:39,title:"Abandoned",state:"closed",merged:false,head:{ref:"feature/abandoned"}}] + [range(48)|{number:(2000+.),title:"pad",state:"closed",merged:false,head:{ref:"pad"}}]' ;;
  "repos/acme/widgets/pulls?state=closed&limit=50&page=2")
    echo '[{"number":901,"title":"Deep merge","html_url":"https://git.example.com/acme/widgets/pulls/901","body":"deep merged","state":"closed","merged":true,"merged_at":"2026-07-06T12:00:00Z","created_at":"2026-07-03T09:00:00Z","head":{"ref":"feature/deep-merge"}}]' ;;

  # --- issue-view ----------------------------------------------------------
  repos/acme/widgets/issues/99)
    echo '{"number":99,"title":"Bug here","body":"issue body","state":"open","html_url":"https://git.example.com/acme/widgets/issues/99","url":"https://git.example.com/api/v1/repos/acme/widgets/issues/99","comments":2}' ;;
  repos/acme/widgets/issues/99/comments)
    echo '[{"body":"On it! Working on a fix now.","created_at":"2026-07-06T08:00:00Z","user":{"login":"carol"}},{"body":"second","created_at":"2026-07-06T09:00:00Z","user":{"login":"dave"}}]' ;;
  # issue 98: the issue object fetches fine but its comments endpoint fails,
  # exercising the degraded (stderr-warned) []-comments path.
  repos/acme/widgets/issues/98)
    echo '{"number":98,"title":"No comments reachable","body":"body","state":"open","html_url":"https://git.example.com/acme/widgets/issues/98","comments":5}' ;;
  repos/acme/widgets/issues/98/comments)
    echo "fake-tea: comments endpoint down" >&2; exit 7 ;;

  *) echo "fake-tea: no fixture for: $2" >&2; exit 4 ;;
esac
`;

let fixture: string;
let binDir: string;
let repoDir: string;
let runEnv: NodeJS.ProcessEnv;

function hasJq(): boolean {
  try {
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const jqAvailable = hasJq();

/** Run a gitea forge script under the fake `tea`, return trimmed stdout. */
function runScript(name: string, env: Record<string, string> = {}): string {
  return execFileSync('sh', [join(giteaDir, name)], {
    cwd: repoDir,
    env: { ...runEnv, ...env },
    encoding: 'utf-8',
  }).trim();
}

/** Run a script capturing stdout, stderr and exit status (for failure paths). */
function runScriptFull(
  name: string,
  env: Record<string, string> = {},
  cwd: string = repoDir,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('sh', [join(giteaDir, name)], {
    cwd,
    env: { ...runEnv, ...env },
    encoding: 'utf-8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe.skipIf(!jqAvailable)('bugfix #1137: gitea preset routes reads through `tea api`', () => {
  beforeAll(() => {
    fixture = mkdtempSync(join(tmpdir(), 'codev-1137-'));
    binDir = join(fixture, 'bin');
    repoDir = join(fixture, 'repo');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    const teaPath = join(binDir, 'tea');
    writeFileSync(teaPath, FAKE_TEA, { mode: 0o755 });
    chmodSync(teaPath, 0o755);

    // Throwaway repo with a scp-style gitea remote → owner/repo = acme/widgets.
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['remote', 'add', 'origin', 'git@git.example.com:acme/widgets.git'], { cwd: repoDir });

    runEnv = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` };
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('user-identity emits the bare login (not JSON)', () => {
    expect(runScript('user-identity.sh')).toBe('octo');
  });

  it('pr-view returns the PrViewResult shape from the PR object', () => {
    const pr = JSON.parse(runScript('pr-view.sh', { CODEV_PR_NUMBER: '42' }));
    expect(pr).toEqual({
      title: 'Add widget',
      body: 'PR body',
      state: 'open',
      // PIR #1179: `url` is the browser page. The fixture carries both fields,
      // so this also pins that Gitea's `url` (the API endpoint, which would
      // render raw JSON) is NOT what lands in the contract.
      url: 'https://git.example.com/acme/widgets/pulls/42',
      author: { login: 'alice' },
      baseRefName: 'main',
      headRefName: 'feature/x',
      additions: 10,
      deletions: 3,
    });
  });

  it('pr-list normalizes to PrListItem[] incl. real reviewRequests/isDraft/body', () => {
    const list = JSON.parse(runScript('pr-list.sh'));
    const first = list.find((p: { number: number }) => p.number === 42);
    expect(first).toMatchObject({
      number: 42,
      title: 'Add widget',
      url: 'https://git.example.com/acme/widgets/pulls/42',
      reviewDecision: '',
      body: 'PR body',
      createdAt: '2026-07-01T10:00:00Z',
      author: { login: 'alice' },
      reviewRequests: ['bob'], // null-login (team) reviewers dropped
      isDraft: true,
    });
    expect(typeof first.number).toBe('number');
  });

  it('pr-list paginates: a PR only on page 2 still appears (51 total)', () => {
    const list = JSON.parse(runScript('pr-list.sh'));
    expect(list).toHaveLength(51); // 50 (page 1) + 1 (page 2)
    expect(list.some((p: { number: number }) => p.number === 900)).toBe(true);
  });

  it('pr-exists is true for an OPEN pull on the branch', () => {
    expect(runScript('pr-exists.sh', { CODEV_BRANCH_NAME: 'feature/x' })).toBe('true');
  });

  it('pr-exists is true for a MERGED pull on the branch', () => {
    expect(runScript('pr-exists.sh', { CODEV_BRANCH_NAME: 'feature/done' })).toBe('true');
  });

  it('pr-exists is false for a closed-not-merged branch', () => {
    expect(runScript('pr-exists.sh', { CODEV_BRANCH_NAME: 'feature/abandoned' })).toBe('false');
  });

  it('pr-exists is false when no PR matches the branch', () => {
    expect(runScript('pr-exists.sh', { CODEV_BRANCH_NAME: 'no-such-branch' })).toBe('false');
  });

  it('pr-exists paginates: a merged PR only on page 2 is found', () => {
    // page 1 is a full 50 items; feature/deep exists ONLY on page 2, so this
    // would false-negative (and block a porch pr_exists gate) without paging.
    expect(runScript('pr-exists.sh', { CODEV_BRANCH_NAME: 'feature/deep' })).toBe('true');
  });

  it('issue-view returns body, browser url, and comments as an ARRAY', () => {
    const issue = JSON.parse(runScript('issue-view.sh', { CODEV_ISSUE_ID: '99' }));
    expect(issue.title).toBe('Bug here');
    expect(issue.body).toBe('issue body');
    expect(issue.state).toBe('open');
    // html_url (browser page), NOT the API endpoint
    expect(issue.url).toBe('https://git.example.com/acme/widgets/issues/99');
    // Contract requires an array — Gitea's issue object reports `comments` as an
    // integer count, which would crash `issue.comments.filter(...)`.
    expect(Array.isArray(issue.comments)).toBe(true);
    expect(issue.comments).toEqual([
      { body: 'On it! Working on a fix now.', createdAt: '2026-07-06T08:00:00Z', author: { login: 'carol' } },
      { body: 'second', createdAt: '2026-07-06T09:00:00Z', author: { login: 'dave' } },
    ]);
  });

  it('issue-view degrades to [] comments AND warns on stderr when the fetch fails', () => {
    // Issue 98's comments endpoint errors. stdout must stay pure JSON with an
    // empty array; stderr must carry a trace so [] is distinguishable from
    // "genuinely no comments".
    const { status, stdout, stderr } = runScriptFull('issue-view.sh', { CODEV_ISSUE_ID: '98' });
    expect(status).toBe(0);
    const issue = JSON.parse(stdout);
    expect(issue.comments).toEqual([]);
    expect(stderr).toContain('comments fetch failed for issue 98');
  });

  it('recently-merged keeps merged pulls only and uses merged_at', () => {
    const merged = JSON.parse(runScript('recently-merged.sh'));
    const done = merged.find((p: { number: number }) => p.number === 40);
    expect(done).toEqual({
      number: 40,
      title: 'Done PR',
      url: 'https://git.example.com/acme/widgets/pulls/40',
      body: 'merged body',
      createdAt: '2026-07-02T09:00:00Z',
      mergedAt: '2026-07-05T12:00:00Z',
      headRefName: 'feature/done',
    });
    // closed-not-merged pulls are excluded.
    expect(merged.some((p: { number: number }) => p.number === 39)).toBe(false);
  });

  it('recently-merged paginates: a merged PR only on page 2 is included', () => {
    const merged = JSON.parse(runScript('recently-merged.sh'));
    expect(merged).toHaveLength(2); // #40 (page 1) + #901 (page 2)
    const deep = merged.find((p: { number: number }) => p.number === 901);
    expect(deep).toMatchObject({
      number: 901,
      mergedAt: '2026-07-06T12:00:00Z',
      headRefName: 'feature/deep-merge',
    });
  });

  it('issue-comment uses `tea comments add` and exits 0', () => {
    // Would exit non-zero (throwing) if it invoked the non-existent
    // `tea issues comment` subcommand.
    expect(runScript('issue-comment.sh', { CODEV_ISSUE_ID: '99', CODEV_COMMENT_BODY: 'hi' })).toBe('commented');
  });

  it('CODEV_REPO overrides the git-remote-derived owner/repo', () => {
    // A repo whose remote does NOT resolve to acme/widgets still works when
    // CODEV_REPO is supplied explicitly (the repo-archive-style callers).
    const other = mkdtempSync(join(tmpdir(), 'codev-1137-other-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: other });
      execFileSync('git', ['remote', 'add', 'origin', 'https://git.example.com/someone/else.git'], { cwd: other });
      const out = execFileSync('sh', [join(giteaDir, 'pr-view.sh')], {
        cwd: other,
        env: { ...runEnv, CODEV_REPO: 'acme/widgets', CODEV_PR_NUMBER: '42' },
        encoding: 'utf-8',
      }).trim();
      expect(JSON.parse(out).title).toBe('Add widget');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('fails fast (non-zero + stderr naming CODEV_REPO) with no usable origin remote', () => {
    const bare = mkdtempSync(join(tmpdir(), 'codev-1137-noremote-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: bare });
      // No origin remote at all.
      const { status, stdout, stderr } = runScriptFull(
        'pr-exists.sh',
        { CODEV_BRANCH_NAME: 'feature/x' },
        bare,
      );
      expect(status).not.toBe(0);
      expect(stdout.trim()).toBe('');
      expect(stderr).toContain('CODEV_REPO');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('fails fast with a garbage origin URL that has no owner/repo', () => {
    const garbage = mkdtempSync(join(tmpdir(), 'codev-1137-garbage-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: garbage });
      execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/'], { cwd: garbage });
      const { status, stderr } = runScriptFull(
        'issue-view.sh',
        { CODEV_ISSUE_ID: '99' },
        garbage,
      );
      expect(status).not.toBe(0);
      expect(stderr).toContain('CODEV_REPO');
    } finally {
      rmSync(garbage, { recursive: true, force: true });
    }
  });
});
