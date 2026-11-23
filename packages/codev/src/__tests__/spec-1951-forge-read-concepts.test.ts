/**
 * Spec 1951 — forge read concepts for `codev check`.
 *
 * Pins:
 *   1. `commit-checks` and `workflow-runs` are known concepts; github (and the hybrid
 *      providers, which fall through to it) implement them, gitlab and gitea disable them
 *      explicitly instead of silently falling through to `gh`.
 *   2. The github scripts honour their contracts and make only read-only `gh` calls.
 *   3. `pr-view` carries the new optional fields on github, gitlab and gitea.
 *   4. The dispatcher's `timeoutMs` option and `timedOut` error flag.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  executeForgeCommandDetailed,
  getForgeCommand,
  getKnownConcepts,
  resolveAllConcepts,
} from '../lib/forge.js';
import type { CommitChecksResult, PrViewResult, WorkflowRunsResult } from '../lib/forge-contracts.js';

const forgeScripts = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'forge');
const NEW_CONCEPTS = ['commit-checks', 'workflow-runs'] as const;
const SHA = 'a'.repeat(40);

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
 * A fake `gh` implementing the read-only slice the github scripts use. Every call is
 * appended to `gh-calls`; any call outside the read-only list is appended to `violations`
 * and exits 97, so a script that tries to write fails loudly and the test sees it.
 *
 *   pr view …            → pr-view.json
 *   run list …           → run-list.json
 *   api … check-runs …   → each check-runs.<n>.json page through the --jq expression
 *   api … /status …      → status.json through the --jq expression
 *
 * STUB_FAIL_API=1 makes `gh api` fail, to prove the capture-then-jq shape propagates it.
 */
const GH_STUB = `#!/bin/sh
dir="$(dirname "$0")"
printf '%s\\n' "$*" >> "$dir/gh-calls"
refuse() { printf '%s\\n' "$*" >> "$dir/violations"; exit 97; }
case "$1" in
  pr)  case "$2" in view|list) ;; *) refuse "$@" ;; esac ;;
  run) [ "$2" = list ] || refuse "$@" ;;
  api)
    for a in "$@"; do
      case "$a" in
        -X|-X*|--method|--method=*|-f|-F|--field|--field=*|--raw-field|--raw-field=*|--input|--input=*) refuse "$@" ;;
      esac
    done ;;
  *) refuse "$@" ;;
esac
if [ "$1" = pr ]; then cat "$dir/pr-view.json"; exit 0; fi
if [ "$1" = run ]; then cat "$dir/run-list.json"; exit 0; fi
[ "$STUB_FAIL_API" = 1 ] && { echo "HTTP 502" >&2; exit 1; }
expr=""; endpoint=""; prev=""
for a in "$@"; do
  [ "$prev" = "--jq" ] && expr="$a"
  case "$a" in repos/*) endpoint="$a" ;; esac
  prev="$a"
done
case "$endpoint" in
  */check-runs*) for page in "$dir"/check-runs.*.json; do jq -c "$expr" "$page"; done ;;
  */status*) jq -c "$expr" "$dir/status.json" ;;
  *) refuse "$@" ;;
esac
`;

function writeStub(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function withPath(dir: string): Record<string, string> {
  return { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` };
}

describe('Spec 1951 — new concepts are registered per provider', () => {
  it('both concepts are known', () => {
    for (const concept of NEW_CONCEPTS) expect(getKnownConcepts()).toContain(concept);
  });

  it.each(['github', 'linear', 'jira'])('%s runs the github scripts', (provider) => {
    for (const concept of NEW_CONCEPTS) {
      expect(getForgeCommand(concept, { provider })).toBe(path.join(forgeScripts, 'github', `${concept}.sh`));
      const resolution = resolveAllConcepts({ provider }).find((r) => r.concept === concept);
      expect(resolution?.executable).toBe('gh');
    }
  });

  it.each(['gitlab', 'gitea'])('%s disables them explicitly — never a silent fall-through to gh', (provider) => {
    for (const concept of NEW_CONCEPTS) {
      expect(getForgeCommand(concept, { provider })).toBeNull();
      const resolution = resolveAllConcepts({ provider }).find((r) => r.concept === concept);
      expect(resolution?.source).toBe('disabled');
    }
  });

  it('doctor names glab as the gitlab pr-view executable, not printf (#1455)', () => {
    const resolution = resolveAllConcepts({ provider: 'gitlab' }).find((r) => r.concept === 'pr-view');
    expect(resolution?.executable).toBe('glab');
  });

  it.skipIf(process.platform === 'win32').each(NEW_CONCEPTS)('the github %s script is executable', (concept) => {
    expect(fs.statSync(path.join(forgeScripts, 'github', `${concept}.sh`)).mode & 0o111).not.toBe(0);
  });
});

describe.skipIf(!posixWithJq)('Spec 1951 — github scripts honour the contracts, read-only', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1951-forge-'));
    writeStub(tmp, 'gh', GH_STUB);
  });

  afterEach(() => {
    // Every test ends with the read-only audit: no refused gh call happened.
    expect(fs.existsSync(path.join(tmp, 'violations')), 'a gh call outside the read-only list').toBe(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const run = (concept: string, env: Record<string, string>) =>
    executeForgeCommandDetailed(concept, { ...env, ...withPath(tmp) }, { forgeConfig: { provider: 'github' }, cwd: tmp });

  it('pr-view asks gh for the new fields and passes them through', async () => {
    const pr = {
      title: 't', body: 'b', state: 'OPEN', url: 'u', author: { login: 'x' }, baseRefName: 'main',
      headRefName: 'builder/spir-1', additions: 1, deletions: 2, headRefOid: SHA, isDraft: false,
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', mergeCommit: null, mergedAt: null,
      reviewDecision: 'REVIEW_REQUIRED',
    };
    fs.writeFileSync(path.join(tmp, 'pr-view.json'), JSON.stringify(pr));
    const result = await run('pr-view', { CODEV_PR_NUMBER: '7' });
    expect(result.error).toBeNull();
    expect(result.data as PrViewResult).toEqual(pr);
    const call = fs.readFileSync(path.join(tmp, 'gh-calls'), 'utf-8').trim();
    for (const field of ['headRefOid', 'isDraft', 'mergeable', 'mergeStateStatus', 'mergeCommit', 'mergedAt', 'reviewDecision']) {
      expect(call).toContain(field);
    }
  });

  it('commit-checks normalizes every check-run conclusion and commit status, across pages', async () => {
    const checkRun = (name: string, status: string, conclusion: string | null) =>
      ({ name, status, conclusion, html_url: `https://ci.example/${name}` });
    fs.writeFileSync(path.join(tmp, 'check-runs.1.json'), JSON.stringify({
      check_runs: [
        checkRun('unit', 'completed', 'success'),
        checkRun('lint', 'completed', 'failure'),
        checkRun('docs', 'completed', 'skipped'),
        checkRun('info', 'completed', 'neutral'),
        checkRun('e2e', 'in_progress', null),
      ],
    }));
    fs.writeFileSync(path.join(tmp, 'check-runs.2.json'), JSON.stringify({
      check_runs: [
        checkRun('cancelled', 'completed', 'cancelled'),
        checkRun('slow', 'completed', 'timed_out'),
        checkRun('queued', 'queued', null),
      ],
    }));
    fs.writeFileSync(path.join(tmp, 'status.json'), JSON.stringify({
      statuses: [
        { context: 'legacy/ok', state: 'success', target_url: 'https://legacy/ok' },
        { context: 'legacy/bad', state: 'error', target_url: '' },
        { context: 'legacy/wait', state: 'pending', target_url: null },
      ],
    }));
    const result = await run('commit-checks', { CODEV_COMMIT_SHA: SHA });
    expect(result.error).toBeNull();
    expect(result.data as CommitChecksResult).toEqual([
      { name: 'unit', state: 'pass', url: 'https://ci.example/unit' },
      { name: 'lint', state: 'fail', url: 'https://ci.example/lint' },
      { name: 'docs', state: 'skipped', url: 'https://ci.example/docs' },
      { name: 'info', state: 'neutral', url: 'https://ci.example/info' },
      { name: 'e2e', state: 'pending', url: 'https://ci.example/e2e' },
      { name: 'cancelled', state: 'fail', url: 'https://ci.example/cancelled' },
      { name: 'slow', state: 'fail', url: 'https://ci.example/slow' },
      { name: 'queued', state: 'pending', url: 'https://ci.example/queued' },
      { name: 'legacy/ok', state: 'pass', url: 'https://legacy/ok' },
      { name: 'legacy/bad', state: 'fail' },
      { name: 'legacy/wait', state: 'pending' },
    ]);
    const calls = fs.readFileSync(path.join(tmp, 'gh-calls'), 'utf-8');
    expect(calls).toContain(`repos/{owner}/{repo}/commits/${SHA}/check-runs`);
    expect(calls).toContain('--paginate');
    expect(calls).toContain(`repos/{owner}/{repo}/commits/${SHA}/status`);
  });

  it('commit-checks reports a commit with nothing on it as an empty list', async () => {
    fs.writeFileSync(path.join(tmp, 'check-runs.1.json'), JSON.stringify({ check_runs: [] }));
    fs.writeFileSync(path.join(tmp, 'status.json'), JSON.stringify({ statuses: [] }));
    const result = await run('commit-checks', { CODEV_COMMIT_SHA: SHA });
    expect(result).toEqual({ data: [], error: null });
  });

  it('commit-checks fails when gh fails — never "no checks" (#1645)', async () => {
    fs.writeFileSync(path.join(tmp, 'check-runs.1.json'), JSON.stringify({ check_runs: [] }));
    fs.writeFileSync(path.join(tmp, 'status.json'), JSON.stringify({ statuses: [] }));
    const result = await run('commit-checks', { CODEV_COMMIT_SHA: SHA, STUB_FAIL_API: '1' });
    expect(result.data).toBeNull();
    expect(result.error?.timedOut).toBe(false);
    expect(result.error?.exitCode).not.toBe(0);
  });

  it('workflow-runs lists the runs of one workflow on one branch', async () => {
    const runs: WorkflowRunsResult = [
      { headSha: SHA, status: 'completed', conclusion: 'success', url: 'https://ci/1', createdAt: '2026-11-22T18:04:00Z' },
      { headSha: 'b'.repeat(40), status: 'in_progress', conclusion: '', url: 'https://ci/2', createdAt: '2026-11-22T17:00:00Z' },
    ];
    fs.writeFileSync(path.join(tmp, 'run-list.json'), JSON.stringify(runs));
    const result = await run('workflow-runs', { CODEV_WORKFLOW: 'deploy.yml', CODEV_BRANCH: 'production' });
    expect(result).toEqual({ data: runs, error: null });
    const call = fs.readFileSync(path.join(tmp, 'gh-calls'), 'utf-8').trim();
    expect(call).toBe('run list --workflow deploy.yml --branch production --limit 50 --json headSha,status,conclusion,url,createdAt');
  });
});

describe.skipIf(!posixWithJq)('Spec 1951 — gitlab and gitea pr-view carry the new fields', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1951-prview-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const glabMr = (overrides: Record<string, unknown>) => JSON.stringify({
    iid: 7, title: 't', state: 'opened', description: 'body text', web_url: 'https://gl/mr/7',
    target_branch: 'main', source_branch: 'builder/spir-7', sha: SHA, draft: false,
    merge_commit_sha: null, squash_commit_sha: null, merged_at: null, detailed_merge_status: 'mergeable',
    ...overrides,
  });

  const runGitlab = async (mr: string, exitCode = 0) => {
    writeStub(tmp, 'glab', `#!/bin/sh\ncat <<'JSON'\n${mr}\nJSON\nexit ${exitCode}\n`);
    return executeForgeCommandDetailed('pr-view', { CODEV_PR_NUMBER: '7', ...withPath(tmp) }, { forgeConfig: { provider: 'gitlab' }, cwd: tmp });
  };

  it('gitlab maps an open, clean MR', async () => {
    const result = await runGitlab(glabMr({}));
    expect(result.data).toMatchObject({
      url: 'https://gl/mr/7', body: 'body text', baseRefName: 'main', headRefName: 'builder/spir-7',
      headRefOid: SHA, isDraft: false, mergeCommit: null, mergedAt: null,
      mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    });
  });

  it.each([
    ['conflict', 'CONFLICTING', 'CONFLICT'],
    ['checking', 'UNKNOWN', 'CHECKING'],
    ['unchecked', 'UNKNOWN', 'UNCHECKED'],
    ['not_approved', 'MERGEABLE', 'NOT_APPROVED'],
  ])('gitlab maps detailed_merge_status %s', async (status, mergeable, mergeStateStatus) => {
    const result = await runGitlab(glabMr({ detailed_merge_status: status }));
    expect(result.data).toMatchObject({ mergeable, mergeStateStatus });
  });

  it('gitlab maps a squash-merged MR', async () => {
    const result = await runGitlab(glabMr({
      state: 'merged', merge_commit_sha: null, squash_commit_sha: 'c'.repeat(40), merged_at: '2026-11-22T00:00:00Z',
    }));
    expect(result.data).toMatchObject({ mergeCommit: { oid: 'c'.repeat(40) }, mergedAt: '2026-11-22T00:00:00Z' });
  });

  it('gitlab omits a field glab does not supply rather than inventing it', async () => {
    const result = await runGitlab(glabMr({ sha: null, draft: undefined, detailed_merge_status: undefined }));
    const data = result.data as Record<string, unknown>;
    expect('headRefOid' in data).toBe(false);
    expect('isDraft' in data).toBe(false);
    expect('mergeable' in data).toBe(false);
  });

  it('gitlab fails when glab fails, instead of reporting jq\'s exit 0 (#1645)', async () => {
    const result = await runGitlab('', 1);
    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
  });

  const runGitea = async (pull: Record<string, unknown>) => {
    const body = JSON.stringify({
      number: 7, title: 't', state: 'open', body: 'b', html_url: 'https://gt/pulls/7',
      user: { login: 'x' }, base: { ref: 'main' }, head: { ref: 'builder/spir-7', sha: SHA },
      additions: 1, deletions: 2, draft: false, mergeable: true, merge_commit_sha: null, merged_at: null,
      ...pull,
    });
    writeStub(tmp, 'tea', `#!/bin/sh\ncat <<'JSON'\n${body}\nJSON\n`);
    return executeForgeCommandDetailed('pr-view', { CODEV_PR_NUMBER: '7', CODEV_REPO: 'o/r', ...withPath(tmp) }, { forgeConfig: { provider: 'gitea' }, cwd: tmp });
  };

  it('gitea maps an open, mergeable pull', async () => {
    const result = await runGitea({});
    expect(result.data).toMatchObject({
      headRefOid: SHA, isDraft: false, mergeable: 'MERGEABLE', mergeCommit: null, mergedAt: null, reviewDecision: null,
    });
  });

  it('gitea maps a merged, unmergeable pull', async () => {
    const result = await runGitea({ mergeable: false, merge_commit_sha: 'd'.repeat(40), merged_at: '2026-11-22T00:00:00Z' });
    expect(result.data).toMatchObject({
      mergeable: 'CONFLICTING', mergeCommit: { oid: 'd'.repeat(40) }, mergedAt: '2026-11-22T00:00:00Z',
    });
  });

  it('gitea omits headRefOid, isDraft and mergeable when the server does not send them', async () => {
    const result = await runGitea({ head: { ref: 'b' }, draft: undefined, mergeable: undefined });
    const data = result.data as Record<string, unknown>;
    expect('headRefOid' in data).toBe(false);
    expect('isDraft' in data).toBe(false);
    expect('mergeable' in data).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('Spec 1951 — the dispatcher reports a timeout as a timeout', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-1951-timeout-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const script = (name: string, body: string): string => {
    writeStub(tmp, name, `#!/bin/sh\n${body}\n`);
    return path.join(tmp, name);
  };

  it('a concept that exec-s a hanging tool times out at timeoutMs', async () => {
    const hang = script('hang.sh', 'exec sleep 5');
    const started = Date.now();
    const result = await executeForgeCommandDetailed('pr-view', {}, { forgeConfig: { 'pr-view': hang }, timeoutMs: 300 });
    expect(result.data).toBeNull();
    expect(result.error?.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('a capture-pattern concept whose tool hangs is still flagged as timed out', async () => {
    // The killed shell's grandchild keeps stderr open until it exits, so the promise
    // settles late; `codev check`'s runner bounds that with its own deadline (Phase 2).
    const hang = script('hang-capture.sh', 'out="$(sleep 1)"\nprintf "%s" "$out"');
    const result = await executeForgeCommandDetailed('pr-view', {}, { forgeConfig: { 'pr-view': hang }, timeoutMs: 200 });
    expect(result.data).toBeNull();
    expect(result.error?.timedOut).toBe(true);
  });

  it('an ordinary failure is not a timeout', async () => {
    const fail = script('fail.sh', 'echo nope >&2\nexit 3');
    const result = await executeForgeCommandDetailed('pr-view', {}, { forgeConfig: { 'pr-view': fail } });
    expect(result.error).toMatchObject({ exitCode: 3, timedOut: false });
  });
});
