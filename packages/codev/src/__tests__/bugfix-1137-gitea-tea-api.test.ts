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
import { execFileSync } from 'node:child_process';

const giteaDir = resolve(__dirname, '..', '..', 'scripts', 'forge', 'gitea');

// A fake `tea` binary. It only implements `api <endpoint>` (the surface the
// fixed scripts use) plus `comments add`. Each endpoint returns the raw Gitea
// REST shape — nested objects, real `.merged`/`.merged_at`/`.draft`, integer
// `comments` count on the issue object, etc.
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
    echo '{"number":42,"title":"Add widget","body":"PR body","state":"open","user":{"login":"alice"},"base":{"ref":"main"},"head":{"ref":"feature/x"},"additions":10,"deletions":3}' ;;
  "repos/acme/widgets/pulls?state=open&limit=200")
    echo '[{"number":42,"title":"Add widget","html_url":"https://git.example.com/acme/widgets/pulls/42","url":"https://git.example.com/api/v1/repos/acme/widgets/pulls/42","body":"PR body","state":"open","created_at":"2026-07-01T10:00:00Z","user":{"login":"alice"},"requested_reviewers":[{"login":"bob"},{"login":null}],"draft":true}]' ;;
  "repos/acme/widgets/pulls?state=all&limit=200")
    echo '[{"number":42,"state":"open","merged":false,"head":{"ref":"feature/x"}},{"number":40,"state":"closed","merged":true,"head":{"ref":"feature/done"}},{"number":39,"state":"closed","merged":false,"head":{"ref":"feature/abandoned"}}]' ;;
  "repos/acme/widgets/pulls?state=closed&limit=200")
    echo '[{"number":40,"title":"Done PR","html_url":"https://git.example.com/acme/widgets/pulls/40","body":"merged body","state":"closed","merged":true,"merged_at":"2026-07-05T12:00:00Z","created_at":"2026-07-02T09:00:00Z","head":{"ref":"feature/done"}},{"number":39,"title":"Abandoned","state":"closed","merged":false,"head":{"ref":"feature/abandoned"}}]' ;;
  repos/acme/widgets/issues/99)
    echo '{"number":99,"title":"Bug here","body":"issue body","state":"open","html_url":"https://git.example.com/acme/widgets/issues/99","url":"https://git.example.com/api/v1/repos/acme/widgets/issues/99","comments":2}' ;;
  repos/acme/widgets/issues/99/comments)
    echo '[{"body":"On it! Working on a fix now.","created_at":"2026-07-06T08:00:00Z","user":{"login":"carol"}},{"body":"second","created_at":"2026-07-06T09:00:00Z","user":{"login":"dave"}}]' ;;
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
      author: { login: 'alice' },
      baseRefName: 'main',
      headRefName: 'feature/x',
      additions: 10,
      deletions: 3,
    });
  });

  it('pr-list normalizes to PrListItem[] incl. real reviewRequests/isDraft/body', () => {
    const list = JSON.parse(runScript('pr-list.sh'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
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
    expect(typeof list[0].number).toBe('number');
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

  it('recently-merged keeps merged pulls only and uses merged_at', () => {
    const merged = JSON.parse(runScript('recently-merged.sh'));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      number: 40,
      title: 'Done PR',
      url: 'https://git.example.com/acme/widgets/pulls/40',
      body: 'merged body',
      createdAt: '2026-07-02T09:00:00Z',
      mergedAt: '2026-07-05T12:00:00Z',
      headRefName: 'feature/done',
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
});
