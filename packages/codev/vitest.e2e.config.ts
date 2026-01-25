/**
 * Vitest configuration for E2E tests.
 *
 * E2E tests run real AI interactions and are expensive (~$4/run).
 * Run with: npm run test:e2e
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/commands/porch/__tests__/e2e/**/*.test.ts'],
    testTimeout: 1200000, // 20 minutes per test
    hookTimeout: 300000,  // 5 minutes for setup/teardown
    pool: 'forks',        // Isolate tests
    maxConcurrency: 1,    // Run sequentially (expensive)
    globals: true,
  },
});
