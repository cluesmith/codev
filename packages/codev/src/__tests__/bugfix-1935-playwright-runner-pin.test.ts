/**
 * Regression test for bugfix #1935: Playwright jobs broke when `ubuntu-latest` rolled to
 * Ubuntu 26.04.
 *
 * The Playwright this repo resolves (1.59.x) ships no Chromium build for ubuntu26.04, so
 * `playwright install chromium` failed on the new image and every browser test with it.
 * The fix is two-part, and this test pins both halves for every job that installs a
 * Playwright browser, in every workflow:
 *   1. The job runs on an explicitly versioned Ubuntu image, never the floating
 *      `ubuntu-latest`, so the image changes only by a deliberate edit.
 *   2. A failed browser install is reported once, at its own step. A later step whose `if:`
 *      overrides the default success() gate (`!cancelled()`, `always()`, `failure()`) must
 *      also require the install step's success; otherwise it runs with no browser and
 *      buries the real cause under launch errors (the Decisions tab step did exactly that).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const workflowsDir = path.join(repoRoot, '.github/workflows');

interface WorkflowStep {
  id?: string;
  name?: string;
  if?: string;
  run?: string;
}

interface WorkflowJob {
  'runs-on'?: string | string[];
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

interface PlaywrightJob {
  label: string;
  job: WorkflowJob;
  installIndex: number;
}

const playwrightJobs: PlaywrightJob[] = fs
  .readdirSync(workflowsDir)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .flatMap((file) => {
    const workflow = yaml.load(
      fs.readFileSync(path.join(workflowsDir, file), 'utf-8'),
    ) as Workflow;
    return Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) => {
      const installIndex = (job.steps ?? []).findIndex((step) =>
        step.run?.includes('playwright install'),
      );
      if (installIndex === -1) {
        return [];
      }
      return [{ label: `${file}:${jobId}`, job, installIndex }];
    });
  });

const overridesSuccessGate = (condition: string): boolean =>
  /\b(always|failure)\(\)|!\s*cancelled\(\)/.test(condition);

describe('bugfix-1935: Playwright jobs survive runner image rollouts', () => {
  it('finds the known Playwright jobs', () => {
    const labels = playwrightJobs.map((entry) => entry.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        'dashboard-e2e.yml:playwright',
        'test.yml:canvas-browser',
        'test.yml:web-browser',
      ]),
    );
  });

  it.each(playwrightJobs.map((entry) => [entry.label, entry] as const))(
    '%s runs on a pinned Ubuntu image, not ubuntu-latest',
    (label, { job }) => {
      expect(
        job['runs-on'],
        `${label} installs a Playwright browser, so its image must change only by a ` +
          'deliberate edit verified against Playwright support (see #1935)',
      ).toMatch(/^ubuntu-\d+\.\d+$/);
    },
  );

  it.each(playwrightJobs.map((entry) => [entry.label, entry] as const))(
    '%s runs no browser step after a failed install',
    (label, { job, installIndex }) => {
      const steps = job.steps ?? [];
      const installId = steps[installIndex].id;
      const ungated = steps
        .slice(installIndex + 1)
        .filter((step) => step.if !== undefined && overridesSuccessGate(step.if))
        .filter(
          (step) =>
            installId === undefined ||
            !step.if?.includes(`steps.${installId}.outcome == 'success'`),
        )
        .map((step) => step.name ?? step.run);
      expect(
        ungated,
        `${label}: steps that run past a failure must also require the browser install ` +
          'to have succeeded, so a missing browser is reported at the install step (#1935)',
      ).toEqual([]);
    },
  );
});
