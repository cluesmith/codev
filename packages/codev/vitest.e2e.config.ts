/**
 * Vitest configuration for E2E tests.
 *
 * Includes:
 *   - Porch e2e: Real AI interactions (~$4/run, ~40 min)
 *   - Tower integration: Spawns real server processes (~60s)
 *
 * Run with: npm run test:e2e
 * Prerequisites: npm run build (creates skeleton/ and dist/)
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
