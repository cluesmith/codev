import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Import-boundary guard (Spec 1963): the shared views do no I/O of their own and import nothing
 * host-specific. Every read and action goes through the host adapter (`host.ts`), which is what
 * lets a VS Code webview run them without ever contacting Tower. Test files are excluded (they
 * use node:fs to scan the tree).
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
  { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { label: 'WebSocket', pattern: /\bWebSocket\b/ },
  { label: 'EventSource', pattern: /\bEventSource\b/ },
  { label: 'sendBeacon', pattern: /\bsendBeacon\b/ },
  { label: 'window.open', pattern: /\bwindow\.open\s*\(/ },
  { label: 'codev-core', pattern: /['"]@cluesmith\/codev-core['"/]/ },
];

describe('import boundary', () => {
  const files = collectSourceFiles(srcRoot);

  it('finds source files to scan', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('shipped source does no I/O of its own and imports nothing host-specific', () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const { label, pattern } of FORBIDDEN) {
        if (pattern.test(text)) violations.push(`${file}: ${label}`);
      }
    }
    expect(violations).toEqual([]);
  });

  /** codev-types is a compile-time contract here; a value import would make it a runtime one. */
  it('imports @cluesmith/codev-types as types only', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes('@cluesmith/codev-types') || !/^\s*import\s/.test(line)) continue;
        if (!/^\s*import\s+type\s/.test(line)) violations.push(`${file}: ${line.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  /** Of the sdk, only the environment-agnostic builder helpers. */
  it('imports only @cluesmith/codev-sdk/builder-helpers from the sdk', () => {
    const violations: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/from\s+['"](@cluesmith\/codev-sdk[^'"]*)['"]/g)) {
        if (m[1] !== '@cluesmith/codev-sdk/builder-helpers') violations.push(`${file}: ${m[1]}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
