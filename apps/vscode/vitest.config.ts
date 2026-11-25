import { defineConfig } from 'vitest/config';

/**
 * Spec 786 Phase 6: vitest config for unit-level tests of VSCode extension
 * code. The existing `src/test/` suite uses `vscode-test` (an Electron
 * harness) for integration tests; this config covers pure-logic units that
 * mock the `vscode` module entirely. Two separate harnesses: each does what
 * it does well.
 *
 * Test files live under `src/__tests__/` (kept distinct from `src/test/`
 * which is the vscode-test integration suite).
 */
export default defineConfig({
  // The webview TSX (Spec 1963) uses the automatic runtime, as `tsconfig.webview.json` and esbuild's
  // bundle do. Vite reads the nearest tsconfig.json, the host's, which sets no `jsx`.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    // The webview tests (Spec 1963) are TSX, type-checked with the webview config, so they live
    // beside the webview sources that the host tsconfig excludes.
    include: ['src/__tests__/**/*.test.ts', 'src/workspace-views/webview/__tests__/**/*.test.{ts,tsx}'],
  },
});
