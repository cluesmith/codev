import { defineConfig } from 'vitest/config';

// No resolve alias needed: outside plugin.ts (the entry, not under test) every
// sdk import is type-only, so the suite runs without the sdk's dist built.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});
