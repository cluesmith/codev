import { defineConfig } from 'vite';

/**
 * Dev-only config for the `examples/` page (`pnpm dev:example`). Kept minimal — no React plugin
 * dependency; esbuild's automatic JSX runtime transpiles the .tsx (HMR full-reload is fine for a
 * smoke page). The example is never built into the published package.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
});
