/**
 * Scenario 28 (Spec 1951 § JSON schema): a `PrReport` survives JSON and has the schema-1
 * shape, with every check id present in order and the verdict following the statuses.
 */

import { expect } from 'vitest';
import { PR_CHECK_IDS, type PrReport } from '../../report.js';

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
