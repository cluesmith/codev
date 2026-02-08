/**
 * Default Vitest configuration.
 *
 * Excludes E2E tests which are expensive (~$4/run, 20min+ per test).
 * Run E2E separately with: npm run test:e2e
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',  // E2E tests excluded by default
      '**/dashboard/__tests__/**',  // Dashboard tests use their own vitest config
      '**/worktrees/**',   // Git worktrees have their own test files
      '**/.builders/**',   // Builder worktrees
      '**/tower-baseline.test.ts',  // Integration tests - spawn real servers, need built dist/
      '**/tower-api.test.ts',       // Run these via: npm run test:e2e
      '**/tower-terminals.test.ts',
      '**/cli-tower-mode.test.ts',
    ],
  },
});
