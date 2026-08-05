import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Import-boundary guard (issue #1189): the sdk must run unmodified in browser,
 * Node, and React Native (Metro). Shipped source therefore has zero Node
 * builtins, zero vscode imports, zero direct fetch calls (transport is an
 * injected adapter), zero DOM-global usage, and zero runtime dependencies.
 * `@cluesmith/codev-types` is type-only (erased at build). `@cluesmith/codev-core`
 * is forbidden outright: core and sdk never import each other.
 *
 * The single exception is `src/node/`, the explicitly Node-only adapter subpath
 * (`@cluesmith/codev-sdk/node`). It may use Node builtins; nothing outside it
 * may import it, so the core sdk graph stays Metro-resolvable.
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

function isNodeAdapter(file: string): boolean {
  return relative(srcRoot, file).split(sep)[0] === 'node';
}

/**
 * Remove block comments and whole-line `//` comments so a doc comment naming a
 * forbidden global (e.g. explaining WHY `Buffer` is banned) doesn't trip the
 * usage patterns. Inline trailing `//` comments are left in place (stripping
 * them naively corrupts `http://` literals), so keep forbidden names out of
 * those.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Rules for every shipped module, adapter subpath included. */
const UNIVERSAL: Array<{ label: string; pattern: RegExp }> = [
  { label: 'vscode', pattern: /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)/ },
  { label: 'fetch()', pattern: /\bfetch\s*\(/ },
  { label: '@cluesmith/codev-core', pattern: /['"]@cluesmith\/codev-core/ },
  { label: 'runtime import of @cluesmith/codev-types (must be `import type`)', pattern: /^import\s+(?!type\b)[^;]*['"]@cluesmith\/codev-types/m },
];

/** Additional rules for the environment-agnostic graph (everything outside src/node/). */
const AGNOSTIC_ONLY: Array<{ label: string; pattern: RegExp }> = [
  { label: 'node:* builtin', pattern: /from\s+['"]node:[^'"]+['"]|require\(\s*['"]node:[^'"]+['"]\s*\)/ },
  { label: "bare 'fs'", pattern: /from\s+['"]fs['"]|require\(\s*['"]fs['"]\s*\)/ },
  { label: 'DOM global', pattern: /\bwindow\.|\bdocument\./ },
  { label: 'process.env', pattern: /\bprocess\.env\b/ },
  { label: 'Buffer', pattern: /\bBuffer\b/ },
  { label: 'import of the node adapter subpath', pattern: /from\s+['"][^'"]*\/node\/[^'"]*['"]|from\s+['"]\.\/node['"]/ },
];

describe('import boundary', () => {
  const files = collectSourceFiles(srcRoot);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('shipped source honors the environment-agnostic boundary', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = stripComments(readFileSync(file, 'utf8'));
      let rules = UNIVERSAL;
      if (!isNodeAdapter(file)) {
        rules = [...UNIVERSAL, ...AGNOSTIC_ONLY];
      }
      for (const { label, pattern } of rules) {
        if (pattern.test(text)) violations.push(`${relative(srcRoot, file)}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('declares zero runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(srcRoot, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual([]);
  });
});
