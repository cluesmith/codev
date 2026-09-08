/**
 * Vitest configuration for E2E tests.
 *
 * Includes:
 *   - Porch e2e: Real AI interactions (~$4/run, ~40 min)
 *   - Tower integration: Spawns real server processes (~60s)
 *
 * Run with: npm run test:e2e
 * Prerequisites: npm run build (creates skeleton/ and dist/)
 *
 * The porch benchmark drives a real agent that shells out to `consult`. Its
 * gemini lane runs against the harness's fake agy unless you opt in:
 *   CODEV_ALLOW_REAL_AGY=1 pnpm --filter @cluesmith/codev test:e2e
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Sandboxes the real agy binary and the user-global metrics DB (#1323).
    setupFiles: ['./vitest-setup.ts', './vitest-e2e-setup.ts'],
    include: [
      'src/commands/porch/__tests__/e2e/**/*.test.ts',
      'src/**/*.e2e.test.ts',  // All server-spawning / integration tests
    ],
    testTimeout: 1200000, // 20 minutes per test
    hookTimeout: 300000,  // 5 minutes for setup/teardown
    pool: 'forks',        // Isolate tests
    maxConcurrency: 1,    // Run sequentially (expensive)
    globals: true,
  },
});
