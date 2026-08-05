import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Issue #1189 invariant, server half: `@cluesmith/codev-core` (server-side)
 * and `@cluesmith/codev-sdk` (client-side) never import each other; both may
 * import only `@cluesmith/codev-types`. The sdk's own import-boundary test
 * enforces the client half.
 */

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('server/client package isolation', () => {
  it('no core module imports @cluesmith/codev-sdk', () => {
    const violations: string[] = [];
    for (const file of collectSourceFiles(srcRoot)) {
      if (/['"]@cluesmith\/codev-sdk/.test(readFileSync(file, 'utf8'))) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
