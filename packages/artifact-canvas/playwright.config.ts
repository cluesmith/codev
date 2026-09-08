import { defineConfig } from '@playwright/test';

/**
 * Real-browser regression harness (spec 1380, plan phase 2). jsdom cannot express CSS
 * fragmentation, so the load-bearing spike findings — protection rects, tall-block caps,
 * per-fragment prose rects, self-bounding — are asserted against real Chromium layout here.
 * The webServer is the package's own vite `examples/` page in fixture mode.
 */
export default defineConfig({
  testDir: './playwright',
  fullyParallel: true,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 1600, height: 900 },
    baseURL: 'http://localhost:5199',
  },
  webServer: {
    command: 'pnpm exec vite examples --port 5199 --strictPort',
    port: 5199,
    reuseExistingServer: !process.env.CI,
  },
});
