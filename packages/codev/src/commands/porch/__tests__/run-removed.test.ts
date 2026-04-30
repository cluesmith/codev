/**
 * Regression test for issue #710.
 *
 * `porch run` was removed in spec 0095 (commit ed2012ae) when the
 * orchestrator was deleted in favor of the `porch next` planner. This
 * test pins the migration message so the deprecation remains discoverable
 * for anyone (including the E2E test runner) that still invokes the old
 * command.
 *
 * Calls `cli()` directly rather than spawning `bin/porch.js` as a
 * subprocess: unit tests run before `pnpm build`, so `dist/` may be
 * absent in CI.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cli } from '../index.js';

function captureRun(args: string[]): { stderr: string; exitCode: number } {
  const stderr: string[] = [];
  let exitCode = 0;

  const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    stderr.push(a.map(String).join(' '));
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('__process_exit__');
  }) as never);

  try {
    // cli() is async and the 'run' branch calls process.exit synchronously
    // inside the switch. Our mock throws to unwind the stack so the test
    // doesn't hang waiting on the promise.
    cli(args).catch(() => { /* swallowed: __process_exit__ */ });
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }

  return { stderr: stderr.join('\n'), exitCode };
}

describe('porch run (removed)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 1 with a migration message pointing to porch next', () => {
    const { stderr, exitCode } = captureRun(['run', 'some-id']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("'porch run' has been removed");
    expect(stderr).toContain('porch next');
  });

  it('exits 1 even when extra flags are passed (e.g. --single-phase)', () => {
    const { stderr, exitCode } = captureRun(['run', 'some-id', '--single-phase']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("'porch run' has been removed");
  });
});
