/**
 * Regression test for bugfix #566: Dashboard E2E scheduled runs need GH_TOKEN
 *
 * Scheduled GitHub Actions workflows do not propagate GITHUB_TOKEN to child
 * processes. The dashboard-e2e workflow must explicitly pass GH_TOKEN so Tower
 * can call `gh` CLI commands during E2E tests.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

describe('bugfix-566: dashboard-e2e.yml passes GH_TOKEN', () => {
  const workflowPath = path.join(repoRoot, '.github/workflows/dashboard-e2e.yml');

  it('Run Playwright tests step includes GH_TOKEN in env', () => {
    const content = fs.readFileSync(workflowPath, 'utf-8');

    // Find the "Run Playwright tests" step section
    const stepStart = content.indexOf('- name: Run Playwright tests');
    expect(stepStart, '"Run Playwright tests" step must exist').toBeGreaterThan(-1);

    // Extract text from this step to the next step (or end of file)
    const afterStep = content.slice(stepStart);
    const nextStep = afterStep.indexOf('\n      - name:', 1);
    const stepBlock = nextStep > 0 ? afterStep.slice(0, nextStep) : afterStep;

    expect(
      stepBlock,
      'GH_TOKEN must be set in the env block of the Playwright test step',
    ).toContain('GH_TOKEN');
  });
});
