import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
  resolve: {
    // Resolve the workspace SDK to its source so tests run without first building
    // the client's dist (the package's `default` export points at dist for consumers).
    alias: {
      '@cluesmith/codev-client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url)),
    },
  },
});
