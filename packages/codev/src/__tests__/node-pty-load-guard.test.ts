/**
 * #1944: node-pty is loaded only through `terminal/node-pty-loader.ts`.
 *
 * A dynamic `import('node-pty')` inside Tower on Node 22.17+ (pnpm workspace) returned a second,
 * empty copy of the module whose `spawn` was undefined; only the Tower integration job caught it,
 * and only on that Node. This guard fails on any reintroduction, on every OS and Node:
 *
 * - no runtime static import or re-export of `node-pty` (type-only imports are fine);
 * - no call taking `'node-pty'` as its first argument: `import('node-pty')`, `require('node-pty')`,
 *   `createRequire(...)('node-pty')`, and also `vi.mock('node-pty')` / `vi.doMock('node-pty')`,
 *   since a test that mocks `node-pty` directly no longer intercepts the loader (mock the loader).
 *
 * Type positions such as `typeof import('node-pty')` are type nodes, not calls, so they pass.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MODULE = 'node-pty';
const LOADER = 'packages/codev/src/terminal/node-pty-loader.ts';

/** Files allowed to load node-pty directly, each with its reason. */
const ALLOWED: Record<string, string> = {
  [LOADER]: 'the one loader',
  'packages/codev/src/terminal/__tests__/node-pty-loader.test.ts': 'checks the loader returns the instance require holds',
};

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function sourceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = path.join(REPO_ROOT, group);
    if (!fs.existsSync(groupDir)) continue;
    for (const pkg of fs.readdirSync(groupDir)) {
      const src = path.join(groupDir, pkg, 'src');
      if (fs.existsSync(src) && fs.statSync(src).isDirectory()) roots.push(src);
    }
  }
  return roots;
}

function walk(dir: string, out: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && SOURCE_EXT.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false; // `import 'node-pty'` runs the module
  if (clause.isTypeOnly) return true;
  if (clause.name) return false; // a default import is a value
  const bindings = clause.namedBindings;
  if (!bindings || ts.isNamespaceImport(bindings)) return false;
  return bindings.elements.length > 0 && bindings.elements.every((element) => element.isTypeOnly);
}

/** Every direct load of node-pty in `file`, as `<relative path>:<line> <kind>`. */
function findLoads(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(MODULE)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
  const loads: string[] = [];
  const at = (node: ts.Node, kind: string): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    loads.push(`${rel}:${line} ${kind}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === MODULE && !isTypeOnlyImport(node)) {
      at(node, 'static import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === MODULE && !node.isTypeOnly) {
      at(node, 're-export');
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
      && node.arguments[0].text === MODULE) {
      at(node, `call ${node.expression.getText(source)}(...)`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return loads;
}

describe('#1944: node-pty loads only through terminal/node-pty-loader.ts', () => {
  it('no source or test file outside the loader imports, requires or mocks node-pty', () => {
    const files = sourceRoots().flatMap((root) => walk(root, []));
    const violations = files
      .filter((file) => !(path.relative(REPO_ROOT, file).split(path.sep).join('/') in ALLOWED))
      .flatMap(findLoads);
    expect(violations, [
      'Load node-pty with loadNodePty() from packages/codev/src/terminal/node-pty-loader.ts, and in',
      "tests mock that module instead of 'node-pty'. A dynamic import('node-pty') returned empty",
      'bindings inside Tower on Node 22.17+ (#1944); a node-pty mock does not intercept the loader.',
    ].join('\n')).toEqual([]);
  });

  it('detects a load (the loader itself), so the scan is not vacuous', () => {
    expect(findLoads(path.join(REPO_ROOT, LOADER))).toEqual([expect.stringMatching(/^packages\/codev\/src\/terminal\/node-pty-loader\.ts:\d+ call require\(\.\.\.\)$/)]);
  });
});
