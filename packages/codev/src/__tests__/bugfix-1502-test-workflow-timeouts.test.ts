/**
 * Regression test for bugfix #1502: the Tests workflow must not hang for hours.
 *
 * The `Artifact-Canvas Browser Tests` job intermittently hung because
 * `playwright install --with-deps` runs an `apt-get update` whose index fetch to
 * archive.ubuntu.com can stall indefinitely, and no job in `test.yml` had a
 * `timeout-minutes`. GitHub's 6-hour default let the stall pend for hours, leaving
 * the PR check set permanently incomplete and blocking merges.
 *
 * The fix is two-part, and this test pins both halves:
 *   1. Remove the cause: the Chromium install must NOT pass `--with-deps` (its apt
 *      phase is the sole stall; the runner image already carries Chromium's libs).
 *   2. Keep a backstop: every job must declare a numeric `timeout-minutes` below
 *      GitHub's 6-hour (360-minute) default, so any future stall fails fast.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const workflowPath = path.join(repoRoot, '.github/workflows/test.yml');

interface WorkflowStep {
  name?: string;
  run?: string;
}

interface WorkflowJob {
  'timeout-minutes'?: number;
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

const workflow = yaml.load(fs.readFileSync(workflowPath, 'utf-8')) as Workflow;
const jobEntries = Object.entries(workflow.jobs);

describe('bugfix-1502: test.yml jobs carry a timeout bound', () => {
  it('parses at least the known jobs', () => {
    expect(jobEntries.length).toBeGreaterThan(0);
    expect(workflow.jobs).toHaveProperty('canvas-browser');
  });

  it.each(jobEntries.map(([id]) => id))(
    'job "%s" declares a bounded numeric timeout-minutes',
    (jobId) => {
      const timeout = workflow.jobs[jobId]['timeout-minutes'];
      expect(
        typeof timeout,
        `job "${jobId}" must set timeout-minutes so a stall fails fast instead of ` +
          `pending for GitHub's 6-hour default (see #1502)`,
      ).toBe('number');
      // Must be a real bound, not a value at or above GitHub's default that would
      // never fire before the silent multi-hour stall the fix exists to prevent.
      expect(timeout).toBeGreaterThan(0);
      expect(timeout).toBeLessThan(360);
    },
  );
});

describe('bugfix-1502: the Chromium install does not run the stalling apt phase', () => {
  it('the canvas-browser install step does not pass --with-deps', () => {
    const installStep = (workflow.jobs['canvas-browser'].steps ?? []).find(
      (step) => step.run?.includes('playwright install'),
    );
    expect(
      installStep,
      'canvas-browser must have a "playwright install" step',
    ).toBeDefined();
    // `--with-deps` triggers the apt-get update that intermittently stalls (#1502).
    // Chromium's system libraries are already present on the ubuntu-latest image
    // (the dashboard-e2e workflow installs without it and launches Chromium fine).
    // If a future runner image ever drops a library canvas needs, the fix is to
    // restore --with-deps AND update this assertion with the reason — never to let
    // the stalling phase back in silently.
    expect(installStep?.run).not.toContain('--with-deps');
  });
});
