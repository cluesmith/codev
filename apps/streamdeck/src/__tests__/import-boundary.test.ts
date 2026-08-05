import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Import-boundary guard (issue #1347, mirroring the sdk's own guard for #1189):
 * the plugin is a curated sdk consumer. Shipped source imports ONLY
 * `@cluesmith/codev-sdk/<subpath>`, `@elgato/streamdeck`, `node:` builtins,
 * and relative modules. In particular:
 *
 * - `@cluesmith/codev-client` is the dissolved predecessor — banned outright.
 * - `@cluesmith/codev-types` must not be imported directly; wire types arrive
 *   via `@cluesmith/codev-sdk/controller` (the curated surface, #1357).
 * - `@cluesmith/codev-core` is server-side — never reachable from a controller.
 * - `@cluesmith/codev-sdk/node` (the Node-only adapter) is allowed ONLY in
 *   `plugin.ts`, the composition root, keeping store/actions
 *   environment-agnostic and unit-testable without the sdk's dist.
 *
 * Test files are excluded (they legitimately use node:fs to scan the tree).
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

/** Every static import/export-from specifier in a module's source text. */
function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) out.push(match[1]);
  return out;
}

const ALLOWED = [
  /^@cluesmith\/codev-sdk\/[a-z-]+$/,
  /^@elgato\/streamdeck$/,
  /^node:/,
  /^\.\.?\//,
];

const files = collectSourceFiles(srcRoot);

describe('import boundary', () => {
  it('finds the shipped source files', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it.each(files.map((f) => [relative(srcRoot, f), f]))(
    '%s imports only sdk subpaths, @elgato/streamdeck, node builtins, and relative modules',
    (_label, file) => {
      const specifiers = importSpecifiers(readFileSync(file, 'utf-8'));
      const violations = specifiers.filter(
        (spec) => !ALLOWED.some((rule) => rule.test(spec)),
      );
      expect(violations).toEqual([]);
    },
  );

  it('confines @cluesmith/codev-sdk/node to plugin.ts (the composition root)', () => {
    const offenders = files.filter((file) => {
      if (relative(srcRoot, file).split(sep).join('/') === 'plugin.ts') return false;
      const specifiers = importSpecifiers(readFileSync(file, 'utf-8'));
      return specifiers.includes('@cluesmith/codev-sdk/node');
    });
    expect(offenders.map((f) => relative(srcRoot, f))).toEqual([]);
  });
});
