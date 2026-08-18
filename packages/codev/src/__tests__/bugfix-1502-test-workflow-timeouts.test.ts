/**
 * Regression test for bugfix #1502: Tests workflow jobs must carry a timeout bound.
 *
 * The `Artifact-Canvas Browser Tests` job intermittently hung for hours because
 * `playwright install --with-deps` runs an `apt-get update` whose index fetch to
 * archive.ubuntu.com can stall indefinitely, and no job in `test.yml` had a
 * `timeout-minutes`. GitHub's 6-hour default let the stall pend for hours, leaving
 * the PR check set permanently incomplete and blocking merges.
 *
 * The fix bounds every job so a stall fails fast and visibly instead of pending.
 * This test pins that invariant: each job in test.yml must declare a numeric
 * timeout-minutes below GitHub's 6-hour (360-minute) default.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const workflowPath = path.join(repoRoot, '.github/workflows/test.yml');

interface WorkflowJob {
  'timeout-minutes'?: number;
}

interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

describe('bugfix-1502: test.yml jobs carry a timeout bound', () => {
  const workflow = yaml.load(
    fs.readFileSync(workflowPath, 'utf-8'),
  ) as Workflow;

  const jobEntries = Object.entries(workflow.jobs);

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
