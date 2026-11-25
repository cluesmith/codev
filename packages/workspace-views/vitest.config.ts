import { defineConfig } from 'vitest/config';

/** jsdom, as the dashboard's tests used before these components moved here. */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
