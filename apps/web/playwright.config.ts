import { defineConfig } from '@playwright/test';

/**
 * Real-browser regressions for the dashboard terminal (Issue #1883). jsdom has
 * no IME, so mobile keyboard edits are driven through Chromium's own IME
 * pipeline (CDP) against the real xterm.js and the real Terminal component.
 * The webServer is this package's vite dev server; the fixture page mounts the
 * Terminal over a fake PTY socket.
 */
export default defineConfig({
  testDir: './playwright',
  reporter: 'list',
  use: {
    browserName: 'chromium',
    baseURL: 'http://localhost:5197',
  },
  webServer: {
    command: 'pnpm exec vite --port 5197 --strictPort',
    port: 5197,
    reuseExistingServer: !process.env.CI,
  },
});
