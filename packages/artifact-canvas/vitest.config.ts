import { defineConfig } from 'vitest/config';

/**
 * jsdom environment — the renderer (Phase 2), DOMPurify sanitization, and the overlay
 * (Phase 3) all touch the DOM, matching the dashboard's vitest convention.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'],
  },
});
