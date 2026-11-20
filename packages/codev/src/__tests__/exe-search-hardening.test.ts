/**
 * Issue #1911: every Codev process turns off Windows' current-folder program
 * lookup before anything can spawn.
 *
 * `lib/exe-search-hardening.ts` sets `NoDefaultCurrentDirectoryInExePath` on
 * Windows. It only protects a process that loads it before its first spawn, so
 * each process entry point must import it FIRST: every installed command in
 * `bin/` and the two scripts Tower starts by path. Static, so it runs on every OS.
 * The behaviour itself is proven on Windows by `windows-exe-search.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { hardenExeSearch, NO_CWD_EXE_SEARCH_ENV } from '../lib/exe-search-hardening.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Process entry points that are not `bin/` commands, with the specifier each must import first. */
const SERVER_ENTRY_POINTS: Record<string, string> = {
  'src/agent-farm/servers/tower-server.ts': '../../lib/exe-search-hardening.js',
  'src/terminal/shellper-main.ts': '../lib/exe-search-hardening.js',
};
const BIN_SPECIFIER = '../dist/lib/exe-search-hardening.js';

/** The module specifier of the first `import` declaration in a file, or null. */
function firstImport(file: string): string | null {
  const text = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      return statement.moduleSpecifier.text;
    }
  }
  return null;
}

/** The first top-level statement, so nothing (even a side effect) runs ahead of the import. */
function firstStatementIsImport(file: string): boolean {
  const text = fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  return source.statements.length > 0 && ts.isImportDeclaration(source.statements[0]);
}

describe('hardenExeSearch', () => {
  it('turns off the current-folder lookup on Windows', () => {
    const env: NodeJS.ProcessEnv = {};
    hardenExeSearch('win32', env);
    expect(env).toEqual({ [NO_CWD_EXE_SEARCH_ENV]: '1' });
  });

  it.each(['linux', 'darwin'] as const)('leaves the environment alone on %s', (platform) => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    hardenExeSearch(platform, env);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });
});

describe('every Codev entry point loads the hardening first', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { bin: Record<string, string> };
  const bins = Object.values(pkg.bin).map((p) => path.posix.normalize(p));

  it('covers every installed command', () => {
    const onDisk = fs.readdirSync(path.join(PACKAGE_ROOT, 'bin')).filter((f) => f.endsWith('.js')).map((f) => `bin/${f}`);
    expect(bins.sort()).toEqual(onDisk.sort());
    expect(bins.length).toBeGreaterThanOrEqual(6);
  });

  it.each(bins)('%s', (bin) => {
    expect(firstStatementIsImport(bin)).toBe(true);
    expect(firstImport(bin)).toBe(BIN_SPECIFIER);
  });

  it.each(Object.entries(SERVER_ENTRY_POINTS))('%s', (file, specifier) => {
    expect(firstStatementIsImport(file)).toBe(true);
    expect(firstImport(file)).toBe(specifier);
  });
});
