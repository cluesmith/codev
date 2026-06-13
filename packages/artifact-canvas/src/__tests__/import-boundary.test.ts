import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Import-boundary guard (spec: the package has zero direct filesystem / fetch / VSCode-API
 * imports). All I/O flows through host-supplied adapters. Test files themselves are excluded
 * (they legitimately use node:fs to scan the tree).
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

const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  { label: 'vscode', pattern: /from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)/ },
  { label: 'node:* builtin', pattern: /from\s+['"]node:[^'"]+['"]|require\(\s*['"]node:[^'"]+['"]\s*\)/ },
  { label: "bare 'fs'", pattern: /from\s+['"]fs['"]|require\(\s*['"]fs['"]\s*\)/ },
  { label: 'fetch()', pattern: /\bfetch\s*\(/ },
];

describe('import boundary', () => {
  const files = collectSourceFiles(srcRoot);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('shipped source contains no vscode / node:* / fs / fetch usage', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(text)) violations.push(`${file}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
