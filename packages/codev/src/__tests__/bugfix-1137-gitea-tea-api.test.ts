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
 * fake `tea` on PATH that answers `api <endpoint>` (and `comment`) with
 * captured Gitea REST fixtures, points the scripts at a throwaway git repo with
 * a gitea remote, runs each real script, and asserts the normalized output
 * conforms to the contract in forge-contracts.ts.
 *
 * Integration-review follow-up (2026-08-17, amrmelsayed):
 *   - `issue-comment` now calls the top-level `tea comment` shorthand rather
 *     than `tea comments add`, which only exists on tea 0.14.2+ and fails on
 *     the still-current 0.14.1 release.
 *   - `pr-exists`/`pr-list`/`recently-merged` now capture `tea_api_paged`'s
 *     output before piping to jq, so a mid-walk failure exits non-zero instead
 *     of surfacing as jq's exit-0-on-empty-stdin.
 *   - `tea_api_paged`'s stop condition now compares against the page size
 *     actually observed on page 1, not the requested limit, so a server whose
 *     `max_response_items` is tuned below the requested limit doesn't stop
 *     after page 1 while more pages remain.
 *
 * Maintainer review follow-up (2026-09-03, waleedkadous):
 *   - the five scripts that source `_lib.sh` (plus `user-identity`, whose fix
 *     below moves `tea` off the first substantive line) declare
 *     `# forge-executable: tea` so `codev doctor` reports the real CLI instead
 *     of `.` / `tea_api_paged` / `printf`.
 *   - `tea_api_paged` FAILS at the `GITEA_MAX_PAGES` ceiling instead of
 *     returning a partial array at exit 0.
 *   - `pr-view`, `user-identity` and `issue-view` validate the response shape
 *     before normalizing: `tea api` exits 0 on HTTP errors and prints the error
 *     body, which used to become an all-null contract object (leaking the error
 *     body's own `url` as the browser page) or the literal username `null`.
 *   - `recently-merged` honors `CODEV_SINCE_DATE`, bounding a walk that would
 *     otherwise cover the repo's entire merge history inside forge's 30s
 *     timeout.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
if [ "$1" = "comment" ]; then
  # comment <id> <body> (the tea 0.14.1-compatible shorthand for
  # \`tea comments add\`, which only exists on 0.14.2+)
  echo "commented"
  exit 0
fi
[ "$1" = "api" ] || { echo "fake-tea: unsupported: $*" >&2; exit 3; }
case "$2" in
  user)
    # FAKE_TEA_USER_ERROR reproduces \`tea api\`'s exit-0-on-HTTP-error: an
    # error body on stdout with no \`.login\`, at exit status 0.
    if [ -n "$FAKE_TEA_USER_ERROR" ]; then
      echo '{"message":"token does not exist","url":"https://git.example.com/api/swagger"}'
    else
      echo '{"login":"octo","id":7}'
    fi ;;
  repos/acme/widgets/pulls/42)
    echo '{"number":42,"title":"Add widget","body":"PR body","state":"open","html_url":"https://git.example.com/acme/widgets/pulls/42","url":"https://git.example.com/api/v1/repos/acme/widgets/pulls/42","user":{"login":"alice"},"base":{"ref":"main"},"head":{"ref":"feature/x"},"additions":10,"deletions":3}' ;;

  # --- mid-walk pagination failure: page 1 is a full 50 items (so the
  # paginator commits to a page 2), page 2 errors. Used to prove pr-exists/
  # pr-list/recently-merged exit non-zero instead of silently succeeding with
  # a truncated/empty result (the jq-exit-status-masks-a-failed-pipe bug). ---
  "repos/acme/failing/pulls?state=all&limit=50&page=1")
    jq -cn '[range(50)|{number:(3000+.),state:"open",merged:false,head:{ref:("pad-"+(.|tostring))}}]' ;;
  "repos/acme/failing/pulls?state=all&limit=50&page=2")
    echo "fake-tea: page 2 unavailable" >&2; exit 9 ;;
  "repos/acme/failing/pulls?state=open&limit=50&page=1")
    jq -cn '[range(50)|{number:(3000+.),title:"pad",html_url:"u",body:"",state:"open",created_at:"d",user:{login:"pad"},requested_reviewers:[],draft:false}]' ;;
  "repos/acme/failing/pulls?state=open&limit=50&page=2")
    echo "fake-tea: page 2 unavailable" >&2; exit 9 ;;
  "repos/acme/failing/pulls?state=closed&limit=50&page=1")
    jq -cn '[range(50)|{number:(3000+.),title:"pad",state:"closed",merged:false,head:{ref:"pad"}}]' ;;
  "repos/acme/failing/pulls?state=closed&limit=50&page=2")
    echo "fake-tea: page 2 unavailable" >&2; exit 9 ;;

  # --- sub-limit server cap: max_response_items tuned to 30 (below the
  # requested limit of 50), so EVERY page — including the last — is capped at
  # 30. Three pages: 30 + 30 + 6 (66 total). Proves the paginator keeps
  # walking past a full-but-capped page instead of stopping after page 1
  # because 30 < the requested 50. ---
  "repos/acme/capped/pulls?state=open&limit=50&page=1")
    jq -cn '[range(30)|{number:(4000+.),title:"pad",html_url:"u",body:"",state:"open",created_at:"d",user:{login:"pad"},requested_reviewers:[],draft:false}]' ;;
  "repos/acme/capped/pulls?state=open&limit=50&page=2")
    jq -cn '[range(30)|{number:(4100+.),title:"pad",html_url:"u",body:"",state:"open",created_at:"d",user:{login:"pad"},requested_reviewers:[],draft:false}]' ;;
  "repos/acme/capped/pulls?state=open&limit=50&page=3")
    jq -cn '[range(5)|{number:(4200+.),title:"pad",html_url:"u",body:"",state:"open",created_at:"d",user:{login:"pad"},requested_reviewers:[],draft:false}] + [{number:4299,title:"Last capped page item",html_url:"u",body:"",state:"open",created_at:"d",user:{login:"pad"},requested_reviewers:[],draft:false}]' ;;

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

  # --- error bodies at exit 0 -------------------------------------------
  # \`tea api\` exits 0 on an HTTP error and prints the error body. These
  # fixtures reproduce that exactly: exit status 0, an error OBJECT on stdout.
  # Note the \`url\` key — Gitea's error bodies carry one (the swagger link),
  # which an unvalidated normalizer would ship as the PR/issue browser page.
  repos/acme/widgets/pulls/404)
    echo '{"message":"pull request does not exist [id: 0, index: 404]","url":"https://git.example.com/api/swagger"}' ;;
  repos/acme/widgets/issues/404)
    echo '{"message":"issue does not exist [id: 0, index: 404]","url":"https://git.example.com/api/swagger"}' ;;
  # issue 97: the issue itself is fine, but its comments endpoint answers with
  # an error OBJECT at exit 0 (not a blank body and not a failure), which used
  # to reach \`jq --argjson\` and blow up with a raw iteration error.
  repos/acme/widgets/issues/97)
    echo '{"number":97,"title":"Comments error body","body":"body","state":"open","html_url":"https://git.example.com/acme/widgets/issues/97","comments":3}' ;;
  repos/acme/widgets/issues/97/comments)
    echo '{"message":"token does not have at least one of required scope(s): [read:issue]","url":"https://git.example.com/api/swagger"}' ;;

  # --- endless pagination: every page is a full 50 items, forever, so no
  # terminal short/empty page is ever reached and the GITEA_MAX_PAGES ceiling
  # fires. Proves the paginator errors rather than returning a partial array. ---
  # (5 items/page, not 50: the paginator's short-page check compares against
  # the size observed on page 1, so a uniform page size of any value is never
  # "short" — this just keeps a 100-page walk cheap in CI.)
  repos/acme/endless/pulls*)
    jq -cn '[range(5)|{number:(5000+.),title:"pad",html_url:"u",body:"",state:"open",merged:false,created_at:"d",updated_at:"2026-07-09T00:00:00Z",user:{login:"pad"},requested_reviewers:[],draft:false,head:{ref:"pad"}}]' ;;

  # --- recently-merged bounded by CODEV_SINCE_DATE ------------------------
  # Page 1 is a full 50 items sorted by updated_at DESC and reaches back past
  # the cutoff (2026-07-05T00:00:00Z): two merges after it, then 48 older ones.
  # Page 2 ERRORS, so a clean exit proves the walk stopped at page 1.
  "repos/acme/dated/pulls?state=closed&sort=recentupdate&limit=50&page=1")
    jq -cn '[{number:10,title:"Recent merge",html_url:"https://git.example.com/acme/dated/pulls/10",body:"r",state:"closed",merged:true,merged_at:"2026-07-08T10:00:00Z",created_at:"2026-07-01T00:00:00Z",updated_at:"2026-07-08T10:00:00Z",head:{ref:"feature/recent"}},{number:9,title:"Also recent",html_url:"u",body:"",state:"closed",merged:true,merged_at:"2026-07-06T09:00:00+02:00",created_at:"2026-06-01T00:00:00Z",updated_at:"2026-07-06T09:00:00+02:00",head:{ref:"feature/offset"}}] + [range(48)|{number:(6000+.),title:"old",html_url:"u",body:"",state:"closed",merged:true,merged_at:"2026-06-01T00:00:00Z",created_at:"2026-05-01T00:00:00Z",updated_at:"2026-06-01T00:00:00Z",head:{ref:"old"}}]' ;;
  "repos/acme/dated/pulls?state=closed&sort=recentupdate&limit=50&page=2")
    echo "fake-tea: dated page 2 requested" >&2; exit 9 ;;

  # --- server that IGNORES sort=recentupdate ------------------------------
  # Page 1 is a full 50 items in arbitrary update order that includes items
  # older than the cutoff. The stop filter must NOT fire (the page isn't
  # non-increasing), so the walk continues to the short page 2 and the merge
  # that lives there is still reported.
  "repos/acme/unsorted/pulls?state=closed&sort=recentupdate&limit=50&page=1")
    jq -cn '[range(50)|{number:(7000+.),title:"mixed",html_url:"u",body:"",state:"closed",merged:false,created_at:"c",updated_at:(if (. % 2) == 0 then "2026-06-01T00:00:00Z" else "2026-07-09T00:00:00Z" end),head:{ref:"mixed"}}]' ;;
  "repos/acme/unsorted/pulls?state=closed&sort=recentupdate&limit=50&page=2")
    echo '[{"number":7100,"title":"Deep recent merge","html_url":"https://git.example.com/acme/unsorted/pulls/7100","body":"d","state":"closed","merged":true,"merged_at":"2026-07-07T00:00:00Z","created_at":"2026-07-01T00:00:00Z","updated_at":"2026-07-07T00:00:00Z","head":{"ref":"feature/deep-unsorted"}}]' ;;

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

  it('issue-comment uses `tea comment` (not the 0.14.2-only `tea comments add`) and exits 0', () => {
    // Would exit non-zero (throwing) if it invoked the non-existent
    // `tea issues comment` subcommand, or the 0.14.2+-only `tea comments add`.
    expect(runScript('issue-comment.sh', { CODEV_ISSUE_ID: '99', CODEV_COMMENT_BODY: 'hi' })).toBe('commented');
  });

  it('pr-exists exits non-zero (not "false") on a mid-walk pagination failure', () => {
    // Page 1 is a full 50 items so the paginator commits to fetching page 2,
    // which the fixture makes error. Without capturing tea_api_paged's output
    // before the jq pipe, POSIX sh (no pipefail) reports jq's exit status (0)
    // on empty stdin, which prints "false" — a silent false-negative that
    // would pass a porch pr_exists gate instead of surfacing the failure.
    const { status, stdout } = runScriptFull('pr-exists.sh', {
      CODEV_BRANCH_NAME: 'whatever',
      CODEV_REPO: 'acme/failing',
    });
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('pr-list exits non-zero on a mid-walk pagination failure', () => {
    const { status, stdout } = runScriptFull('pr-list.sh', { CODEV_REPO: 'acme/failing' });
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('recently-merged exits non-zero on a mid-walk pagination failure', () => {
    const { status, stdout } = runScriptFull('recently-merged.sh', { CODEV_REPO: 'acme/failing' });
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('pr-list keeps walking past a page capped below the requested limit', () => {
    // Server's max_response_items is tuned to 30 (below the requested 50), so
    // every page — including the last — returns exactly 30 or fewer. Stopping
    // when a page is shorter than the *requested* limit (50) would break after
    // page 1, even though pages 2 and 3 carry real items.
    const list = JSON.parse(runScript('pr-list.sh', { CODEV_REPO: 'acme/capped' }));
    expect(list).toHaveLength(66); // 30 + 30 + 6
    expect(list.some((p: { number: number }) => p.number === 4299)).toBe(true);
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

  // --- maintainer review follow-up (2026-09-03) ----------------------------

  it('every script that hides `tea` behind a helper declares forge-executable', () => {
    // `codev doctor` infers the CLI a concept needs from the script's first
    // substantive line. In these six that line is `. _lib.sh` / an assignment /
    // `printf`, none of which is on PATH, so doctor reported them as missing
    // tools and stopped checking for `tea`. The `# forge-executable:` header
    // (#1458) declares it explicitly.
    for (const name of [
      'pr-exists.sh',
      'pr-list.sh',
      'pr-view.sh',
      'recently-merged.sh',
      'issue-view.sh',
      'user-identity.sh',
    ]) {
      const src = readFileSync(join(giteaDir, name), 'utf-8');
      expect(src, name).toMatch(/^#\s*forge-executable:\s*tea$/m);
    }
  });

  it('pagination fails loudly at the page ceiling instead of truncating', () => {
    // Every page from this repo is a full 50 items, so no terminal short/empty
    // page is ever reached. Returning the partial array at exit 0 would be the
    // silent truncation the paginator exists to prevent — for `pr-exists` it
    // reads as "no PR exists" and passes a porch pr_exists gate.
    const { status, stdout, stderr } = runScriptFull('pr-exists.sh', {
      CODEV_BRANCH_NAME: 'feature/x',
      CODEV_REPO: 'acme/endless',
    });
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe('');
    expect(stderr).toContain('page ceiling');
    // 100 sequential fake-`tea` + jq invocations; the default 5s is too tight.
  }, 30_000);

  it('pr-view fails with the server message on an error body (not an all-null PR)', () => {
    // `tea api` exits 0 and prints the error body. Unvalidated, that produced a
    // structurally valid PrViewResult with every field null except `url`, which
    // took the error body's own `url` — the swagger link — and shipped it as
    // the PR's browser page.
    const { status, stdout, stderr } = runScriptFull('pr-view.sh', { CODEV_PR_NUMBER: '404' });
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe('');
    expect(stderr).toContain('pull request does not exist');
    expect(stderr).not.toContain('swagger');
  });

  it('user-identity fails on an error body instead of printing "null"', () => {
    const { status, stdout, stderr } = runScriptFull('user-identity.sh', {
      FAKE_TEA_USER_ERROR: '1',
    });
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe('');
    expect(stderr).toContain('token does not exist');
  });

  it('issue-view fails with the server message on an error body', () => {
    const { status, stdout, stderr } = runScriptFull('issue-view.sh', { CODEV_ISSUE_ID: '404' });
    expect(status).not.toBe(0);
    expect(stdout.trim()).toBe('');
    expect(stderr).toContain('issue does not exist');
    // The issue is validated BEFORE its comments are fetched, so a bad id
    // doesn't also warn about degraded comments on an issue that isn't there
    // (and doesn't spend a request on them).
    expect(stderr).not.toContain('comments fetch failed');
  });

  it('issue-view degrades to [] when the comments endpoint answers with an error OBJECT', () => {
    // Distinct from issue 98 (comments fetch FAILS): here the fetch succeeds at
    // exit 0 with an error object, which reached `jq --argjson` and blew up
    // with a raw iteration error instead of the warned [] degrade.
    const { status, stdout, stderr } = runScriptFull('issue-view.sh', { CODEV_ISSUE_ID: '97' });
    expect(status).toBe(0);
    const issue = JSON.parse(stdout);
    expect(issue.title).toBe('Comments error body');
    expect(issue.comments).toEqual([]);
    expect(stderr).toContain('comments fetch failed for issue 97');
  });

  it('recently-merged bounds its walk with CODEV_SINCE_DATE', () => {
    // Page 1 is sorted by updated_at DESC and reaches back past the cutoff, so
    // the walk must stop there. The fixture's page 2 errors, so a clean exit is
    // itself the assertion that no second request was made.
    const { status, stdout, stderr } = runScriptFull('recently-merged.sh', {
      CODEV_REPO: 'acme/dated',
      CODEV_SINCE_DATE: '2026-07-05T00:00:00Z',
    });
    expect(stderr).toBe('');
    expect(status).toBe(0);
    const merged = JSON.parse(stdout);
    // Only the two merges after the cutoff — the 48 older ones on the same page
    // are filtered out. The second one carries a +02:00 offset rather than `Z`,
    // pinning that Gitea's server-timezone timestamps compare correctly.
    expect(merged.map((p: { number: number }) => p.number).sort((a: number, b: number) => a - b))
      .toEqual([9, 10]);
    expect(merged[0]).toMatchObject({
      number: 10,
      title: 'Recent merge',
      url: 'https://git.example.com/acme/dated/pulls/10',
      mergedAt: '2026-07-08T10:00:00Z',
      headRefName: 'feature/recent',
    });
  });

  it('recently-merged accepts a bare YYYY-MM-DD CODEV_SINCE_DATE', () => {
    // `github.ts` passes a full ISO timestamp but `team-update.ts` passes a bare
    // date, so both must bound the walk. A bare date reads as midnight UTC —
    // same cutoff as the test above, same fixture, same result.
    const { status, stdout, stderr } = runScriptFull('recently-merged.sh', {
      CODEV_REPO: 'acme/dated',
      CODEV_SINCE_DATE: '2026-07-05',
    });
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(JSON.parse(stdout).map((p: { number: number }) => p.number).sort()).toEqual([10, 9]);
  });

  it('an unparseable CODEV_SINCE_DATE falls back to the unbounded walk', () => {
    // Degrade toward MORE work, never toward silently dropping merges: with no
    // usable cutoff the stop filter must not fire, so page 2 IS requested (and
    // this fixture's page 2 errors, which is how we can see it happened).
    const { status, stderr } = runScriptFull('recently-merged.sh', {
      CODEV_REPO: 'acme/dated',
      CODEV_SINCE_DATE: 'last tuesday',
    });
    expect(status).not.toBe(0);
    expect(stderr).toContain('dated page 2 requested');
  });

  it('gitea_epoch normalizes Gitea\'s server-timezone timestamps', () => {
    // Gitea marshals RFC3339 in the SERVER's timezone, so `Z` is not
    // guaranteed. These four spell the same instant; a lexicographic compare
    // would order them wrongly, which is why the offset is parsed out.
    const program = `. "${join(giteaDir, '_lib.sh')}"; `
      + `printf '%s' "$INPUT" | jq -c "\${GITEA_JQ_LIB} [ .[] | gitea_epoch ]"`;
    const out = execFileSync('sh', ['-c', program], {
      encoding: 'utf-8',
      env: {
        ...runEnv,
        INPUT: JSON.stringify([
          '2026-07-05T12:00:00Z',
          '2026-07-05T14:00:00+02:00',
          '2026-07-05T10:00:00-02:00',
          '2026-07-05T12:00:00.123Z',
          '2026-07-05',        // bare date -> midnight UTC
          '2026-13-99',        // right shape, impossible date -> null, not a throw
          'garbage',
          null,
          42,
        ]),
      },
    }).trim();
    expect(JSON.parse(out)).toEqual([
      1783252800, 1783252800, 1783252800, 1783252800,
      1783209600,
      null, null, null, null,
    ]);
  });

  it('recently-merged keeps walking when the server ignores sort=recentupdate', () => {
    // The since-date bound must not cost data on a server that doesn't honor
    // the sort parameter: page 1 contains items older than the cutoff but is
    // NOT in descending update order, so the stop filter must not fire and the
    // merge that lives only on page 2 must still be reported.
    const merged = JSON.parse(runScript('recently-merged.sh', {
      CODEV_REPO: 'acme/unsorted',
      CODEV_SINCE_DATE: '2026-07-05T00:00:00Z',
    }));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ number: 7100, headRefName: 'feature/deep-unsorted' });
  });

  it('recently-merged without CODEV_SINCE_DATE still walks the whole history', () => {
    // The unbounded path is unchanged: no `sort` parameter, every page walked.
    const merged = JSON.parse(runScript('recently-merged.sh'));
    expect(merged).toHaveLength(2); // #40 (page 1) + #901 (page 2)
  });
});
