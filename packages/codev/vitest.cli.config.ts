/**
 * Vitest configuration for CLI integration tests.
 *
 * CLI tests run the built binary (dist/) against temp directories.
 * They use *.e2e.test.ts suffix but don't need the extreme timeouts
 * of the main e2e config (porch scenarios, tower tests).
 *
 * Run with: npx vitest run --config vitest.cli.config.ts
 * Prerequisites: npm run build (creates dist/)
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/__tests__/cli/*.e2e.test.ts',
    ],
    testTimeout: 30000, // 30 seconds per test
    hookTimeout: 15000, // 15 seconds for setup/teardown
  },
});
