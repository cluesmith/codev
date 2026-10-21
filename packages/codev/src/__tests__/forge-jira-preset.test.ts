/**
 * Issue #1740: the Jira Cloud forge preset (scripts/forge/jira/), which wraps
 * Atlassian's `acli`.
 *
 * `acli` isn't available in CI, so this test puts a fake `acli` on PATH that
 * answers the calls the scripts make with fixtures shaped like acli 1.3.39's
 * real `--json` output (REST v3 work items: `key`, `self` on an infrastructure
 * host, `fields.*`, Atlassian Document Format bodies). Every value is synthetic.
 * Each real script runs against it, and the tests assert:
 *   - output conforms to the forge-contracts.ts shapes;
 *   - the JQL sent: project scoping, status-category (never status-name)
 *     clauses, the since-date bound, and that queries are never unbounded;
 *   - browser URLs come from the site, never from the REST `self` host;
 *   - input validation (project key, issue key) fails before acli runs;
 *   - comment bodies survive quotes and newlines via --body-file.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const jiraDir = resolve(__dirname, '..', '..', 'scripts', 'forge', 'jira');

// The fake records each invocation's argv (one arg per line, invocations
// separated by a `---` line) and serves fixtures from $FAKE_ACLI_DIR.
const FAKE_ACLI = `#!/bin/sh
{ for a in "$@"; do printf '%s\\n' "$a"; done; echo ---; } >> "$FAKE_ACLI_DIR/calls.log"
case "$1 $2 $3" in
  "jira auth status")
    if [ -n "$FAKE_ACLI_AUTH_FAIL" ]; then echo "✗ Error: failed to retrieve authenticated status" >&2; exit 1; fi
    printf '✓ Authenticated\\n  Site: %s\\n  Email: dev@example.com\\n  Authentication Type: oauth\\n' "\${FAKE_ACLI_SITE:-example.atlassian.net}"
    exit 0 ;;
  "jira workitem search")
    cat "$FAKE_ACLI_DIR/search.json"; exit 0 ;;
  "jira workitem view")
    f="$FAKE_ACLI_DIR/view-$4.json"
    if [ -f "$f" ]; then cat "$f"; exit 0; fi
    echo "✗ Error: Issue does not exist or you do not have permission to see it." >&2; exit 1 ;;
  "jira workitem comment")
    if [ "$4" != "create" ]; then exit 2; fi
    shift 4
    while [ $# -gt 0 ]; do
      case "$1" in
        --key) printf '%s' "$2" > "$FAKE_ACLI_DIR/comment-key.txt"; shift 2 ;;
        --body-file) cp "$2" "$FAKE_ACLI_DIR/comment-body.txt"; shift 2 ;;
        *) shift ;;
      esac
    done
    echo "✓ Comment added"; exit 0 ;;
esac
echo "fake acli: unexpected call: $*" >&2
exit 2
`;

const INFRA = 'https://jira-prod-xx-1.prod.example-paas.net';

function user(name: string, email?: string) {
  return { accountId: `id-${name}`, displayName: name, ...(email ? { emailAddress: email } : {}), active: true };
}

function adfDoc(...content: unknown[]) {
  return { type: 'doc', version: 1, content };
}
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string) => ({ type: 'text', text });

function searchItem(key: string, fields: Record<string, unknown>) {
  return { key, id: '1', self: `${INFRA}/rest/api/3/issue/1`, expand: '', fields };
}

const SEARCH_FIXTURE = [
  searchItem('ENG-12', {
    summary: 'Fix the login flow',
    status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
    labels: ['bug', 'auth'],
    creator: user('Ada', 'ada@example.com'),
    assignee: user('Dev', 'dev@example.com'),
    description: adfDoc(p(t('Steps:')), { type: 'orderedList', content: [{ type: 'listItem', content: [p(t('open'))] }, { type: 'listItem', content: [p(t('click'))] }] }),
  }),
  searchItem('ENG-11', {
    summary: 'Hidden-email assignee',
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    labels: [],
    creator: user('Grace'),
    assignee: user('Private Person'),
    description: null,
  }),
  // acli emits a bare null when only `key` is requested; the scripts skip them.
  null,
];

const VIEW_ENG_12 = {
  key: 'ENG-12',
  self: `${INFRA}/rest/api/3/issue/1`,
  fields: {
    summary: 'Fix the login flow',
    status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
    creator: user('Ada', 'ada@example.com'),
    reporter: user('Ada', 'ada@example.com'),
    assignee: null,
    labels: ['bug'],
    created: '2026-07-08T11:28:34.315+1000',
    fixVersions: [{ name: 'v2.1' }],
    description: adfDoc(
      p(t('First line'), { type: 'hardBreak' }, t('second line')),
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(t('alpha'))] }, { type: 'listItem', content: [p(t('beta'))] }] },
      { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'x' } }] },
      p({ type: 'mention', attrs: { text: '@Ada' } }, t(' see '), { type: 'inlineCard', attrs: { url: 'https://example.com/doc' } }),
    ),
    comment: {
      total: 2, maxResults: 2, startAt: 0,
      comments: [
        { id: '1', author: user('Ada', 'ada@example.com'), body: adfDoc(p(t('LGTM'))), created: '2026-07-09T09:00:00.000+1000' },
        { id: '2', author: user('Private Person'), body: adfDoc(p(t('Second'))), created: '2026-07-10T09:00:00.000+1000' },
      ],
    },
  },
};

const DONE = { name: 'Shipped', statusCategory: { key: 'done' } };
const CLOSED_SEARCH = [
  searchItem('ENG-5', { summary: 'Closed later', status: DONE, labels: ['x'] }),
  searchItem('ENG-4', { summary: 'Closed earlier', status: DONE, labels: [] }),
  searchItem('ENG-3', { summary: 'View fails', status: DONE, labels: [] }),
];
const closedView = (key: string, created: string, changed: string | null, resolved: string | null) => ({
  key, self: `${INFRA}/rest/api/3/issue/9`,
  fields: { created, statuscategorychangedate: changed, resolutiondate: resolved },
});

let fakeBin: string;
let fixtures: string;

function run(script: string, env: Record<string, string> = {}) {
  const res = spawnSync(join(jiraDir, `${script}.sh`), [], {
    env: { PATH: `${fakeBin}:${process.env.PATH}`, FAKE_ACLI_DIR: fixtures, HOME: fixtures, ...env },
    encoding: 'utf-8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function calls(): string[][] {
  const log = join(fixtures, 'calls.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf-8').split('---\n').filter(Boolean).map((c) => c.split('\n').filter((l) => l !== ''));
}

function jqlSent(): string[] {
  return calls().filter((c) => c[1] === 'workitem' && c[2] === 'search').map((c) => c[c.indexOf('--jql') + 1]);
}

function fixture(name: string, value: unknown) {
  writeFileSync(join(fixtures, name), JSON.stringify(value));
}

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), 'codev-fake-acli-'));
  writeFileSync(join(fakeBin, 'acli'), FAKE_ACLI);
  chmodSync(join(fakeBin, 'acli'), 0o755);
});

afterAll(() => {
  rmSync(fakeBin, { recursive: true, force: true });
});

beforeEach(() => {
  if (fixtures) rmSync(fixtures, { recursive: true, force: true });
  fixtures = mkdtempSync(join(tmpdir(), 'codev-jira-fixtures-'));
  mkdirSync(fixtures, { recursive: true });
  fixture('search.json', SEARCH_FIXTURE);
  fixture('view-ENG-12.json', VIEW_ENG_12);
});

describe('jira auth-status / user-identity', () => {
  it('auth-status succeeds when acli reports an authenticated session', () => {
    expect(run('auth-status').status).toBe(0);
  });

  it('auth-status fails when acli cannot confirm the session', () => {
    const r = run('auth-status', { FAKE_ACLI_AUTH_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('failed to retrieve authenticated status');
  });

  it('auth-status fails when acli is logged into a different site than forge.jira-site', () => {
    const r = run('auth-status', { CODEV_JIRA_SITE: 'https://other.atlassian.net/' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('acli jira auth switch');
  });

  it('auth-status accepts a matching site with or without scheme, in any case', () => {
    expect(run('auth-status', { CODEV_JIRA_SITE: 'https://Example.atlassian.net/' }).status).toBe(0);
    expect(run('auth-status', { CODEV_JIRA_SITE: 'example.atlassian.net' }).status).toBe(0);
  });

  it('user-identity prints the account email', () => {
    const r = run('user-identity');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('dev@example.com');
  });
});

describe('jira issue-view', () => {
  it('maps a work item to the IssueViewResult contract', () => {
    const r = run('issue-view', { CODEV_ISSUE_ID: 'ENG-12' });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.title).toBe('Fix the login flow');
    expect(out.state).toBe('In Review');
    expect(out.url).toBe('https://example.atlassian.net/browse/ENG-12');
    expect(out.author).toEqual({ login: 'ada@example.com' });
    expect(out.createdAt).toBe('2026-07-08T11:28:34.315+1000');
    expect(out.assignees).toEqual([]);
    expect(out.labels).toEqual([{ name: 'bug' }]);
    expect(out.milestone).toEqual({ title: 'v2.1' });
    expect(out.comments).toEqual([
      { body: 'LGTM', createdAt: '2026-07-09T09:00:00.000+1000', author: { login: 'ada@example.com' } },
      { body: 'Second', createdAt: '2026-07-10T09:00:00.000+1000', author: { login: 'Private Person' } },
    ]);
  });

  it('flattens Atlassian Document Format to plain text', () => {
    const out = JSON.parse(run('issue-view', { CODEV_ISSUE_ID: 'ENG-12' }).stdout);
    expect(out.body).toBe('First line\nsecond line\n\n- alpha\n- beta\n\n@Ada see https://example.com/doc');
  });

  it('never builds the URL from the REST self host', () => {
    const out = JSON.parse(run('issue-view', { CODEV_ISSUE_ID: 'ENG-12' }).stdout);
    expect(out.url).not.toContain('example-paas');
  });

  it('prefers forge.jira-site over the site acli reports, with no extra auth call', () => {
    const r = run('issue-view', { CODEV_ISSUE_ID: 'ENG-12', CODEV_JIRA_SITE: 'https://configured.atlassian.net/' });
    expect(JSON.parse(r.stdout).url).toBe('https://configured.atlassian.net/browse/ENG-12');
    expect(calls().some((c) => c[1] === 'auth')).toBe(false);
  });

  it('fails non-zero for a missing work item', () => {
    expect(run('issue-view', { CODEV_ISSUE_ID: 'ENG-999' }).status).not.toBe(0);
  });

  it('rejects an id that is not a work item key before calling acli', () => {
    for (const id of ['', '--help', '42', 'ENG', 'ENG-12; rm x']) {
      const r = run('issue-view', { CODEV_ISSUE_ID: id, CODEV_JIRA_SITE: 'example.atlassian.net' });
      expect(r.status, id).not.toBe(0);
    }
    expect(calls()).toEqual([]);
  });
});

describe('jira issue-list / issue-search', () => {
  it('issue-list emits IssueListItem rows keyed by work item key, skipping nulls', () => {
    const r = run('issue-list', { CODEV_JIRA_SITE: 'example.atlassian.net' });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual([
      {
        number: 'ENG-12', title: 'Fix the login flow', url: 'https://example.atlassian.net/browse/ENG-12',
        labels: [{ name: 'bug' }, { name: 'auth' }],
        author: { login: 'ada@example.com' }, assignees: [{ login: 'dev@example.com' }],
      },
      {
        number: 'ENG-11', title: 'Hidden-email assignee', url: 'https://example.atlassian.net/browse/ENG-11',
        labels: [], author: { login: 'Grace' }, assignees: [{ login: 'Private Person' }],
      },
    ]);
  });

  it('issue-list asks for open items by status category, newest first', () => {
    run('issue-list', { CODEV_JIRA_SITE: 'example.atlassian.net' });
    expect(jqlSent()).toEqual(['statusCategory != Done ORDER BY created DESC']);
  });

  it('issue-list never requests key alone (acli returns nulls for that)', () => {
    run('issue-list', { CODEV_JIRA_SITE: 'example.atlassian.net' });
    const search = calls().find((c) => c[2] === 'search')!;
    expect(search[search.indexOf('--fields') + 1]).not.toBe('key');
  });

  it('scopes to forge.jira-project, normalizing case', () => {
    run('issue-list', { CODEV_JIRA_SITE: 'example.atlassian.net', CODEV_JIRA_PROJECT: 'eng' });
    expect(jqlSent()).toEqual(['project = "ENG" AND statusCategory != Done ORDER BY created DESC']);
  });

  it('accepts project keys with digits and underscores', () => {
    run('issue-list', { CODEV_JIRA_SITE: 'example.atlassian.net', CODEV_JIRA_PROJECT: 'AB2_X' });
    expect(jqlSent()[0]).toContain('project = "AB2_X" AND ');
  });

  it('rejects a project key that could inject JQL, before calling acli', () => {
    for (const key of ['ENG" OR 1=1', '2ENG', 'EN G', 'ENG-1']) {
      const r = run('issue-list', { CODEV_JIRA_SITE: 'example.atlassian.net', CODEV_JIRA_PROJECT: key });
      expect(r.status, key).not.toBe(0);
      expect(r.stderr, key).toContain('invalid forge.jira-project');
    }
    expect(jqlSent()).toEqual([]);
  });

  it('issue-search adds the flattened description as body', () => {
    const out = JSON.parse(run('issue-search', { CODEV_JIRA_SITE: 'example.atlassian.net' }).stdout);
    expect(out[0].body).toBe('Steps:\n\n1. open\n2. click');
    expect(out[1].body).toBe('');
  });

  it('issue-search maps the requested state to a bounded status-category clause', () => {
    for (const state of ['open', 'closed', 'all', '']) {
      run('issue-search', { CODEV_JIRA_SITE: 'example.atlassian.net', CODEV_ISSUE_STATE: state });
    }
    expect(jqlSent()).toEqual([
      'statusCategory != Done ORDER BY created DESC',
      'statusCategory = Done ORDER BY created DESC',
      'statusCategory is not EMPTY ORDER BY created DESC',
      'statusCategory != Done ORDER BY created DESC',
    ]);
  });
});

describe('jira recently-closed', () => {
  beforeEach(() => {
    fixture('search.json', CLOSED_SEARCH);
    fixture('view-ENG-5.json', closedView('ENG-5', '2026-01-01T00:00:00.000+0000', '2026-10-20T12:00:00.000+0000', '2026-10-20T11:59:00.000+0000'));
    fixture('view-ENG-4.json', closedView('ENG-4', '2026-01-02T00:00:00.000+0000', null, '2026-10-19T08:00:00.000+0000'));
  });

  it('queries Done by status category with a since bound one day early', () => {
    run('recently-closed', { CODEV_JIRA_SITE: 'example.atlassian.net', CODEV_SINCE_DATE: '2026-10-20T10:00:00Z' });
    expect(jqlSent()).toEqual([
      'statusCategory = Done AND statusCategoryChangedDate >= "2026-10-19" ORDER BY statusCategoryChangedDate DESC',
    ]);
  });

  it('accepts a bare-date and a millisecond since value', () => {
    run('recently-closed', { CODEV_JIRA_SITE: 'example.atlassian.net', CODEV_SINCE_DATE: '2026-03-01' });
    run('recently-closed', { CODEV_JIRA_SITE: 'example.atlassian.net', CODEV_SINCE_DATE: '2026-03-01T00:00:00.123Z' });
    expect(jqlSent().map((q) => q.match(/>= "([^"]+)"/)?.[1])).toEqual(['2026-02-28', '2026-02-28']);
  });

  it('rejects a since value that is not a date, before calling acli', () => {
    for (const since of ['2026" OR 1=1', 'yesterday', '20261-01-01x']) {
      const r = run('recently-closed', { CODEV_JIRA_SITE: 'example.atlassian.net', CODEV_SINCE_DATE: since });
      expect(r.status, since).not.toBe(0);
      expect(r.stderr, since).toContain('invalid CODEV_SINCE_DATE');
    }
    expect(jqlSent()).toEqual([]);
  });

  it('omits the date clause when no since is given', () => {
    run('recently-closed', { CODEV_JIRA_SITE: 'example.atlassian.net' });
    expect(jqlSent()).toEqual(['statusCategory = Done ORDER BY statusCategoryChangedDate DESC']);
  });

  it('fills closedAt and createdAt from a per-item view, falling back to resolutiondate', () => {
    const r = run('recently-closed', { CODEV_JIRA_SITE: 'example.atlassian.net', CODEV_SINCE_DATE: '2026-10-19T00:00:00Z' });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.map((i: { number: string }) => i.number)).toEqual(['ENG-5', 'ENG-4', 'ENG-3']);
    expect(out[0]).toEqual({
      number: 'ENG-5', title: 'Closed later', url: 'https://example.atlassian.net/browse/ENG-5',
      labels: [{ name: 'x' }], createdAt: '2026-01-01T00:00:00.000+0000', closedAt: '2026-10-20T12:00:00.000+0000',
    });
    expect(out[1].closedAt).toBe('2026-10-19T08:00:00.000+0000');
  });

  it('leaves an item without dates (so the consumer drops it) and warns when its view fails', () => {
    const r = run('recently-closed', { CODEV_JIRA_SITE: 'example.atlassian.net' });
    const eng3 = JSON.parse(r.stdout).find((i: { number: string }) => i.number === 'ENG-3');
    expect(eng3.closedAt).toBeNull();
    expect(r.stderr).toContain('could not fetch dates for ENG-3');
  });

  it('emits [] and makes no view calls when nothing closed', () => {
    fixture('search.json', []);
    const r = run('recently-closed', { CODEV_JIRA_SITE: 'example.atlassian.net' });
    expect(r.stdout.trim()).toBe('[]');
    expect(calls().some((c) => c[2] === 'view')).toBe(false);
  });
});

describe('jira issue-comment', () => {
  it('passes the body through a file, preserving quotes and newlines', () => {
    const body = `On it! "quoted" and 'single'\nsecond line $HOME \`tick\``;
    const r = run('issue-comment', { CODEV_ISSUE_ID: 'ENG-12', CODEV_COMMENT_BODY: body });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(fixtures, 'comment-key.txt'), 'utf-8')).toBe('ENG-12');
    expect(readFileSync(join(fixtures, 'comment-body.txt'), 'utf-8')).toBe(`${body}\n`);
  });

  it('fails without a body variable, and for a non-key id, before calling acli', () => {
    expect(run('issue-comment', { CODEV_ISSUE_ID: 'ENG-12' }).status).not.toBe(0);
    expect(run('issue-comment', { CODEV_ISSUE_ID: '--key', CODEV_COMMENT_BODY: 'x' }).status).not.toBe(0);
    expect(calls()).toEqual([]);
  });
});
