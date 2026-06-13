import { defineConfig } from 'tsup';
import { copyFileSync, mkdirSync } from 'node:fs';

/**
 * Dual-format build (spec: CJS + ESM + type declarations) — the repo's first such build.
 * React is externalized (peer dependency). The default theme stylesheet is copied to
 * `dist/default-theme.css` and exposed via the package's `./default-theme.css` export.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ['react', 'react-dom'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
  onSuccess: async () => {
    mkdirSync('dist', { recursive: true });
    copyFileSync('src/styles/default-theme.css', 'dist/default-theme.css');
  },
});
