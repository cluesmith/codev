/**
 * Regression tests for #1323 — the test suites must not reach user-global state.
 *
 * Two escapes were live before this: any test that touched the gemini consult
 * lane without pinning `CODEV_AGY_BIN` spawned the developer's real `agy`
 * (a browser login window per spawn once agy's auth lapsed), and every
 * in-process test recorded metrics into the real `~/.codev/metrics.db`.
 *
 * These tests pin down both the harness (`vitest-setup.ts` really does sandbox
 * every suite) and the belt-and-braces guards that catch a future test which
 * slips past it.
 *
 * `node:child_process.spawn` is stubbed to throw, so a regression in the guard
 * surfaces as a failed assertion here rather than as a real agy invocation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const spawnAttempts: unknown[][] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((...args: unknown[]) => {
      spawnAttempts.push(args);
      throw new Error('spawn() must never be reached by these tests');
    }),
  };
});

const AGY_ENV = ['CODEV_AGY_BIN', 'CODEV_ALLOW_REAL_AGY', 'CODEV_METRICS_DB'] as const;

describe('test-suite isolation (#1323)', () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of AGY_ENV) saved[key] = process.env[key];
    spawnAttempts.length = 0;
  });

  afterEach(() => {
    for (const key of AGY_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
  });

  describe('the vitest harness sandboxes every suite', () => {
    it('pins CODEV_AGY_BIN to a fake outside the real agy install locations', () => {
      const pinned = process.env.CODEV_AGY_BIN;
      expect(pinned, 'vitest-setup.ts must pin a fake agy for every suite').toBeTruthy();
      // The two places resolveAgyBin() would otherwise find the real binary.
      expect(pinned).not.toBe(join(homedir(), '.local', 'bin', 'agy'));
      expect(pinned!.startsWith(homedir() + '/.local')).toBe(false);
      expect(existsSync(pinned!)).toBe(true);
    });

    it('redirects the consult metrics DB away from the user-global path', () => {
      const pinned = process.env.CODEV_METRICS_DB;
      expect(pinned, 'vitest-setup.ts must pin a sandbox metrics DB').toBeTruthy();
      expect(pinned).not.toBe(join(homedir(), '.codev', 'metrics.db'));
    });

    it('names an agy auth-cache dir, so #1077 burst protection is active in tests', async () => {
      // agyAuthCacheDisabled() switches itself off under VITEST unless a dir is
      // named — which is precisely what left burst protection inert for tests.
      const { agyAuthCacheDisabled, agyAuthCacheDir } = await import('../commands/consult/agy-auth-cache.js');
      expect(agyAuthCacheDisabled()).toBe(false);
      expect(agyAuthCacheDir()).not.toBe(join(homedir(), '.cache', 'codev'));
    });
  });

  describe('agy lane guard', () => {
    it('throws instead of resolving a binary when a test forgets to pin one', async () => {
      const { assertAgyLaneAllowedUnderTest } = await import('../lib/test-env.js');
      delete process.env.CODEV_AGY_BIN;
      delete process.env.CODEV_ALLOW_REAL_AGY;

      expect(() => assertAgyLaneAllowedUnderTest()).toThrow(/CODEV_AGY_BIN/);
    });

    it('stands down when the test pins a binary', async () => {
      const { assertAgyLaneAllowedUnderTest } = await import('../lib/test-env.js');
      process.env.CODEV_AGY_BIN = '/definitely/not/real/agy';
      delete process.env.CODEV_ALLOW_REAL_AGY;

      expect(() => assertAgyLaneAllowedUnderTest()).not.toThrow();
    });

    it('stands down under the explicit real-agy opt-in', async () => {
      const { assertAgyLaneAllowedUnderTest } = await import('../lib/test-env.js');
      delete process.env.CODEV_AGY_BIN;
      process.env.CODEV_ALLOW_REAL_AGY = '1';

      expect(() => assertAgyLaneAllowedUnderTest()).not.toThrow();
    });

    it('_runAgyConsultation fails loudly — and spawns nothing — when unpinned', async () => {
      vi.resetModules();
      const { _runAgyConsultation } = await import('../commands/consult/index.js');
      delete process.env.CODEV_AGY_BIN;
      delete process.env.CODEV_ALLOW_REAL_AGY;

      const dir = mkdtempSync(join(tmpdir(), 'codev-1323-'));
      try {
        // The lane's contract is "never throw" — under a test runner that is
        // deliberately inverted, so a misconfigured suite cannot degrade to a
        // silent non-blocking skip while spawning the real CLI.
        await expect(
          _runAgyConsultation('review this', 'reviewer', dir, join(dir, 'out.txt')),
        ).rejects.toThrow(/#1323/);
        expect(spawnAttempts).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('metrics DB isolation', () => {
    it('opens CODEV_METRICS_DB when set, leaving the user-global DB untouched', async () => {
      const { MetricsDB } = await import('../commands/consult/metrics.js');
      const dir = mkdtempSync(join(tmpdir(), 'codev-1323-metrics-'));
      const dbPath = join(dir, 'metrics.db');
      process.env.CODEV_METRICS_DB = dbPath;

      try {
        expect(MetricsDB.defaultPath).toBe(dbPath);
        const db = new MetricsDB();
        try {
          db.record({
            timestamp: new Date().toISOString(),
            model: 'gemini',
            reviewType: null,
            subcommand: 'general',
            protocol: 'bugfix',
            projectId: null,
            durationSeconds: 0,
            inputTokens: null,
            cachedInputTokens: null,
            outputTokens: null,
            costUsd: null,
            exitCode: 0,
            workspacePath: dir,
            errorMessage: null,
          });
        } finally {
          db.close();
        }
        expect(existsSync(dbPath)).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('refuses the user-global DB under a test runner with no redirect', async () => {
      const { MetricsDB } = await import('../commands/consult/metrics.js');
      delete process.env.CODEV_METRICS_DB;

      expect(() => new MetricsDB()).toThrow(/CODEV_METRICS_DB/);
      expect(() => MetricsDB.defaultPath).toThrow(/CODEV_METRICS_DB/);
    });

    it('still honours an explicit path argument', async () => {
      const { MetricsDB } = await import('../commands/consult/metrics.js');
      delete process.env.CODEV_METRICS_DB;

      const dir = mkdtempSync(join(tmpdir(), 'codev-1323-explicit-'));
      try {
        const db = new MetricsDB(join(dir, 'metrics.db'));
        db.close();
        expect(existsSync(join(dir, 'metrics.db'))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
