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
      '**/e2e/**',                   // E2E tests excluded by default
      '**/*.e2e.test.ts',            // Convention: server-spawning / integration tests
      '**/dashboard/__tests__/**',   // Dashboard tests use their own vitest config
      '**/worktrees/**',             // Git worktrees have their own test files
      '**/.builders/**',             // Builder worktrees
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 62,
        branches: 55,
      },
      exclude: [
        '**/dist/**',
        '**/e2e/**',
        '**/__tests__/**',
        '**/dashboard/**',
        '**/*.e2e.test.ts',
      ],
    },
  },
});
