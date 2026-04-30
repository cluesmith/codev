/**
 * Regression test for issue #710.
 *
 * `porch run` was removed in spec 0095 (commit ed2012ae) when the
 * orchestrator was deleted in favor of the `porch next` planner. This
 * test pins the migration message so the deprecation remains discoverable
 * for anyone (including the E2E test runner) that still invokes the old
 * command.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const PORCH_BIN = path.resolve(__dirname, '..', '..', '..', '..', 'bin', 'porch.js');

describe('porch run (removed)', () => {
  it('exits 1 with a migration message pointing to porch next', () => {
    const result = spawnSync('node', [PORCH_BIN, 'run', 'some-id'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'porch run' has been removed");
    expect(result.stderr).toContain("porch next");
  });

  it('exits 1 even when extra flags are passed (e.g. --single-phase)', () => {
    const result = spawnSync('node', [PORCH_BIN, 'run', 'some-id', '--single-phase'], {
      encoding: 'utf-8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("'porch run' has been removed");
  });
});
