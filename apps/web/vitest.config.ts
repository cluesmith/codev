import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./__tests__/setup.ts'],
    // Real-browser specs run under Playwright (`pnpm test:browser`).
    exclude: [...configDefaults.exclude, 'playwright/**'],
  },
});
