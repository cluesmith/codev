import { defineConfig } from 'tsdown';
import { copyFileSync, mkdirSync } from 'node:fs';

/**
 * Dual-format build (CJS + ESM + type declarations) via tsdown (Rolldown-powered).
 * React is externalized (it's a peer dependency — tsdown auto-externalizes deps/peerDeps).
 * The default theme stylesheet is copied to `dist/default-theme.css` and exposed via the
 * package's `./default-theme.css` export.
 *
 * The `build` script loads this config with `--config-loader native` on purpose. tsdown's
 * default `auto` loader only imports the config natively when the Node runtime has native
 * TypeScript support (Bun / Node >=24.11) and otherwise falls back to `unrun` — an optional
 * peer dependency pnpm doesn't install, so a clean `--frozen-lockfile` install (CI, older
 * Node) fails with "Failed to import module 'unrun'". Forcing `native` makes Node import
 * this plain-ESM `.mjs` file directly, which works on every supported Node version.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  onSuccess: () => {
    mkdirSync('dist', { recursive: true });
    copyFileSync('src/styles/default-theme.css', 'dist/default-theme.css');
  },
});
