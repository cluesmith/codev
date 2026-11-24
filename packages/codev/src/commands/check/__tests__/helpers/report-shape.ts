/**
 * Scenario 28 (Spec 1951 § JSON schema): a `PrReport`, `DeployReport` or `WorktreeReport` survives JSON
 * and has the schema-1 shape, with every check id present in order and the verdict following the statuses.
 */

import { expect } from 'vitest';
import { PR_CHECK_IDS, WORKTREE_CHECK_IDS, type DeployReport, type PrReport, type WorktreeReport } from '../../report.js';

const STATUSES = ['ok', 'attention', 'info', 'not-run', 'off', 'skip'];
const WITH_REASON = new Set(['not-run', 'off', 'skip']);
const SHA = /^[0-9a-f]{40}$/;

function expectCommitRuns(value: unknown, where: string): void {
  expect(value, where).toMatchObject({
    sha: expect.stringMatching(SHA),
    runs: expect.any(Array),
    passed: expect.any(Number),
    failed: expect.any(Number),
    pending: expect.any(Number),
  });
  const runs = (value as { runs: unknown[] }).runs;
  for (const run of runs) {
    expect(run, where).toMatchObject({ name: expect.any(String), state: expect.stringMatching(/^(pass|fail|pending|skipped|neutral)$/) });
  }
}

export function expectPrReportShape(report: PrReport): void {
  const parsed = JSON.parse(JSON.stringify(report)) as PrReport;
  expect(parsed).toMatchObject({ schema: 1, command: 'pr', verdict: expect.stringMatching(/^(clear|attention)$/), generatedAt: expect.any(String) });
  expect(Number.isNaN(Date.parse(parsed.generatedAt))).toBe(false);

  const { pr } = parsed;
  expect(pr).toMatchObject({ number: expect.any(Number), title: expect.any(String), state: expect.any(String), headRef: expect.any(String), baseRef: expect.any(String) });
  expect(pr.head).toMatch(SHA);
  expect(pr.baseTip === null || SHA.test(pr.baseTip)).toBe(true);
  expect(pr.draft === null || typeof pr.draft === 'boolean').toBe(true);
  if (pr.localBranch !== null) expect(pr.localBranch).toEqual({ name: expect.any(String), sha: expect.stringMatching(SHA) });

  expect(parsed.checks.map((c) => c.id)).toEqual([...PR_CHECK_IDS]);
  for (const c of parsed.checks) {
    expect(STATUSES, c.id).toContain(c.status);
    expect(typeof c.summary, c.id).toBe('string');
    expect(typeof c.details === 'object' && c.details !== null && !Array.isArray(c.details), c.id).toBe(true);
    expect(typeof c.reason === 'string', `${c.id} reason`).toBe(WITH_REASON.has(c.status));
    if (c.status === 'not-run' || c.status === 'off' || c.status === 'skip') continue;
    if (c.id === 'state') expect(c.details).toEqual({ state: expect.any(String), draft: expect.any(Boolean) });
    if (c.id === 'forge') expect(c.details).toHaveProperty('mergeable');
    if (c.id === 'checks') {
      expectCommitRuns(c.details.head, 'checks.head');
      if ('code' in c.details) expectCommitRuns(c.details.code, 'checks.code');
      expect(c.details.lastCodeCommit === null || SHA.test(String(c.details.lastCodeCommit))).toBe(true);
      expect(typeof c.details.porchOnlyAbove).toBe('number');
    }
  }
  const attention = parsed.checks.some((c) => c.status === 'attention' || c.status === 'not-run');
  expect(parsed.verdict).toBe(attention ? 'attention' : 'clear');
}

/** A `DeployReport` survives JSON and has the schema-1 shape; each PR's verdict follows its checks. */
export function expectDeployReportShape(report: DeployReport): void {
  const parsed = JSON.parse(JSON.stringify(report)) as DeployReport;
  expect(parsed).toMatchObject({ schema: 1, command: 'deploy', verdict: expect.stringMatching(/^(clear|attention)$/), generatedAt: expect.any(String) });
  expect(Number.isNaN(Date.parse(parsed.generatedAt))).toBe(false);
  expect(parsed.deployBranch === null || typeof parsed.deployBranch === 'string').toBe(true);
  expect(parsed.workflow === null || typeof parsed.workflow === 'string').toBe(true);
  expect(parsed.prs.length).toBeGreaterThan(0);

  const ids = ['merged', 'on-branch', 'deploy-run', ...(parsed.workflow === null ? ['merge-checks'] : [])];
  for (const pr of parsed.prs) {
    const where = `#${pr.number}`;
    expect(typeof pr.number, where).toBe('number');
    expect(pr.mergedAt === null || typeof pr.mergedAt === 'string', where).toBe(true);
    expect(pr.mergeCommit === null || SHA.test(pr.mergeCommit), where).toBe(true);
    expect(pr.baseRef === null || typeof pr.baseRef === 'string', where).toBe(true);
    expect(pr.checks.map((c) => c.id), where).toEqual(ids);
    for (const c of pr.checks) {
      expect(STATUSES, `${where} ${c.id}`).toContain(c.status);
      expect(typeof c.summary, `${where} ${c.id}`).toBe('string');
      expect(typeof c.details === 'object' && c.details !== null && !Array.isArray(c.details), `${where} ${c.id}`).toBe(true);
      expect(typeof c.reason === 'string', `${where} ${c.id} reason`).toBe(WITH_REASON.has(c.status));
      if (c.status === 'not-run' || c.status === 'off' || c.status === 'skip') continue;
      if (c.id === 'merged') expect(c.details).toEqual({ state: expect.any(String), mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit });
      if (c.id === 'on-branch') {
        expect(c.details).toEqual({ branch: expect.any(String), tip: expect.stringMatching(SHA), contains: expect.any(Boolean) });
      }
      if (c.id === 'deploy-run') {
        expect(c.details).toMatchObject({ workflow: parsed.workflow });
        if ('run' in c.details) expect(c.details.run).toMatchObject({ headSha: expect.stringMatching(SHA), url: expect.any(String), createdAt: expect.any(String) });
        if ('contains' in c.details) expect(typeof c.details.contains).toBe('boolean');
      }
      if (c.id === 'merge-checks') expectCommitRuns(c.details, `${where} merge-checks`);
    }
    const attention = pr.checks.some((c) => c.status === 'attention' || c.status === 'not-run');
    expect(pr.verdict, where).toBe(attention ? 'attention' : 'clear');
  }
  expect(parsed.verdict).toBe(parsed.prs.some((p) => p.verdict === 'attention') ? 'attention' : 'clear');
}

/** A `WorktreeReport` survives JSON and has the schema-1 shape, its details as the spec's table says. */
export function expectWorktreeReportShape(report: WorktreeReport): void {
  const parsed = JSON.parse(JSON.stringify(report)) as WorktreeReport;
  expect(parsed).toMatchObject({ schema: 1, command: 'worktree', verdict: expect.stringMatching(/^(clear|attention)$/), generatedAt: expect.any(String) });
  expect(Number.isNaN(Date.parse(parsed.generatedAt))).toBe(false);
  expect(['removable', 'removable-after-keeping', 'not-removable']).toContain(parsed.removable);
  const { worktree } = parsed;
  expect(typeof worktree.path).toBe('string');
  expect(worktree.builderId === null || typeof worktree.builderId === 'string').toBe(true);
  expect(typeof worktree.branch).toBe('string');
  expect(worktree.baseRef === null || typeof worktree.baseRef === 'string').toBe(true);
  expect(worktree.baseTip === null || SHA.test(worktree.baseTip)).toBe(true);

  expect(parsed.checks.map((c) => c.id)).toEqual([...WORKTREE_CHECK_IDS]);
  for (const c of parsed.checks) {
    expect(STATUSES, c.id).toContain(c.status);
    expect(typeof c.summary, c.id).toBe('string');
    expect(typeof c.details === 'object' && c.details !== null && !Array.isArray(c.details), c.id).toBe(true);
    expect(typeof c.reason === 'string', `${c.id} reason`).toBe(WITH_REASON.has(c.status));
    if (c.status === 'not-run' || c.status === 'off' || c.status === 'skip') continue;
    if (c.id === 'uncommitted') {
      expect(c.details).toEqual({ files: expect.any(Array), scaffold: expect.any(Array) });
      for (const f of c.details.files as unknown[]) expect(f).toEqual({ path: expect.any(String), change: expect.any(String) });
    }
    if (c.id === 'commits') {
      expect(c.details).toEqual({ total: expect.any(Number), notOnBase: expect.any(Array), unsafe: expect.any(Array) });
      for (const sha of [...(c.details.notOnBase as string[]), ...(c.details.unsafe as string[])]) expect(sha).toMatch(SHA);
    }
    if (c.id === 'remote') {
      expect(c.details.remoteSha === null || SHA.test(String(c.details.remoteSha))).toBe(true);
      expect(['matches', 'ahead', 'behind', 'diverged', 'absent']).toContain(c.details.relation);
    }
    if (c.id === 'pr' && 'mergedHead' in c.details) expect(c.details.mergedHead).toMatch(SHA);
    if (c.id === 'ignored') {
      expect(c.details).toEqual({ keep: expect.any(Array), regenerable: expect.any(Number), links: expect.any(Array), scaffold: expect.any(Array) });
      for (const link of c.details.links as unknown[]) expect(link).toEqual({ path: expect.any(String), target: expect.any(String), missing: expect.any(Boolean) });
    }
  }
  const attention = parsed.checks.some((c) => c.status === 'attention' || c.status === 'not-run');
  expect(parsed.verdict).toBe(attention ? 'attention' : 'clear');
}
