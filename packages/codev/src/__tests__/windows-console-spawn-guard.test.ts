/**
 * Issue #1919: no console window may flash from a process that has no console.
 *
 * Tower runs detached (no console), the VS Code extension host is started by a
 * GUI app, and the extension starts `afx spawn` / `afx tower start` detached.
 * On Windows, a console program started from any of them without `windowsHide`
 * gets a new, visible console window for as long as it runs.
 *
 * This guard walks the relative-import graph from those entry points and checks
 * every `node:child_process` call in every reachable module: it must pass an
 * options object carrying `windowsHide`, or be explained by a
 * `// windows-console: <reason>` comment on its line or the line above (a
 * POSIX-only branch, say). Static, so it runs on every OS.
 *
 * Limits: it follows relative imports only (spawns inside other workspace
 * packages such as codev-sdk are not scanned), recognises named and
 * dynamic-import-destructured `child_process` bindings only (not
 * `import * as cp` or `require`), and cannot see a spawn passed in as a
 * function (those sites carry the comment by hand).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Processes that may run with no console of their own. */
const CONSOLE_LESS_ENTRY_POINTS = [
  'packages/codev/src/agent-farm/servers/tower-server.ts', // Tower (detached)
  'packages/codev/src/agent-farm/commands/spawn.ts', // `afx spawn`, launched detached by the extension
  'packages/codev/src/agent-farm/commands/tower.ts', // `afx tower start`, launched detached by the extension
  'apps/vscode/src/extension.ts', // the VS Code extension host
  'packages/codev/src/commands/porch/index.ts', // `porch approve` etc., run hidden by the extension (execCodevCli)
  'packages/codev/src/agent-farm/commands/cleanup.ts', // `afx cleanup`, run hidden by the extension (execCodevCli)
];

const SPAWN_FUNCTIONS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']);
const ANNOTATION = /\/\/\s*windows-console:\s*\S/;

/** Resolve a relative import specifier to a `.ts` source file, if there is one. */
function resolveImport(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, path.join(base, 'index.ts')];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function relativeSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers.filter((specifier) => specifier.startsWith('.'));
}

function parse(file: string, text = fs.readFileSync(file, 'utf8')): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every production module reachable from the console-less entry points. */
function reachableModules(): string[] {
  const seen = new Set<string>();
  const stack = CONSOLE_LESS_ENTRY_POINTS.map((entry) => path.join(REPO_ROOT, entry));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of relativeSpecifiers(parse(file))) {
      const resolved = resolveImport(file, specifier);
      if (resolved) stack.push(resolved);
    }
  }
  return [...seen].sort();
}

function hasWindowsHide(node: ts.Expression, constObjects: Map<string, ts.ObjectLiteralExpression>): boolean {
  let target: ts.Expression = node;
  if (ts.isIdentifier(target)) {
    const declared = constObjects.get(target.text);
    if (!declared) return false;
    target = declared;
  }
  if (!ts.isObjectLiteralExpression(target)) return false;
  // Only the literal `windowsHide: true` counts: `false`, a variable or a
  // shorthand can turn the flag off, so those need an annotation instead.
  return target.properties.some((property) =>
    ts.isPropertyAssignment(property)
    && ts.isIdentifier(property.name) && property.name.text === 'windowsHide'
    && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

/**
 * The `file:line` of each child_process use in `source` that neither passes
 * `windowsHide` nor carries a `windows-console:` annotation.
 */
const CHILD_PROCESS_MODULES = new Set(['node:child_process', 'child_process']);

/** `await import('node:child_process')` (or `import(...)` without the await). */
function isChildProcessDynamicImport(node: ts.Expression): boolean {
  const call = ts.isAwaitExpression(node) ? node.expression : node;
  return ts.isCallExpression(call) && call.expression.kind === ts.SyntaxKind.ImportKeyword
    && call.arguments[0] !== undefined && ts.isStringLiteral(call.arguments[0])
    && CHILD_PROCESS_MODULES.has(call.arguments[0].text);
}

function isPromisifyOf(node: ts.Node, bindings: Set<string>): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'promisify'
    && node.arguments[0] !== undefined && ts.isIdentifier(node.arguments[0]) && bindings.has(node.arguments[0].text);
}

export function findUnhiddenSpawns(source: ts.SourceFile, label: string): string[] {
  const bindings = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!CHILD_PROCESS_MODULES.has(statement.moduleSpecifier.text)) continue;
    const named = statement.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        const imported = (element.propertyName ?? element.name).text;
        if (SPAWN_FUNCTIONS.has(imported)) bindings.add(element.name.text);
      }
    }
  }

  // `const { spawn } = await import('node:child_process')`, `const x = promisify(execFile)`
  // aliases, and same-file `const opts = { ... }` literals.
  const constObjects = new Map<string, ts.ObjectLiteralExpression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer;
      if (ts.isObjectBindingPattern(node.name) && isChildProcessDynamicImport(init)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName ?? element.name;
          if (ts.isIdentifier(imported) && ts.isIdentifier(element.name) && SPAWN_FUNCTIONS.has(imported.text)) {
            bindings.add(element.name.text);
          }
        }
      } else if (ts.isIdentifier(node.name) && isPromisifyOf(init, bindings)) {
        bindings.add(node.name.text);
      } else if (ts.isIdentifier(node.name) && ts.isObjectLiteralExpression(init)) {
        constObjects.set(node.name.text, init);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  if (bindings.size === 0) return [];

  const lines = source.text.split('\n');
  const annotated = (line: number): boolean => ANNOTATION.test(lines[line] ?? '') || ANNOTATION.test(lines[line - 1] ?? '');

  const violations: string[] = [];
  const check = (node: ts.Identifier, call: ts.CallExpression | null): void => {
    const hidden = call !== null && call.arguments.some((arg) => hasWindowsHide(arg, constObjects));
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
    if (!hidden && !annotated(line)) {
      violations.push(`${label}:${line + 1} ${node.text}${call ? '(...)' : ' (passed as a value)'}`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && bindings.has(node.text)) {
      const parent = node.parent;
      // Positions that name the binding rather than use it: its declaration, a
      // property or method name (`deps.spawn`, `{ spawn: ... }`, `spawn() {}`),
      // and a type (`typeof spawn`).
      const isName = ts.isImportSpecifier(parent)
        || (ts.isVariableDeclaration(parent) && parent.name === node)
        || ts.isBindingElement(parent)
        || (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === node)
        || ts.isTypeQueryNode(parent);
      if (isPromisifyOf(parent, bindings)) {
        // `promisify(exec)(...)` inline is a call; `const x = promisify(exec)` is an alias, checked at its calls.
        const outer = parent.parent;
        if (ts.isCallExpression(outer) && outer.expression === parent) {
          check(node, outer);
        } else if (!ts.isVariableDeclaration(outer)) {
          check(node, null);
        }
      } else if (!isName) {
        check(node, ts.isCallExpression(parent) && parent.expression === node ? parent : null);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

describe('Issue #1919: spawns reachable from a console-less process are hidden', () => {
  it('the import walk reaches Tower, the CLIs and the extension host', () => {
    const modules = reachableModules().map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
    expect(modules).toContain('packages/codev/src/lib/team-github.ts');
    expect(modules).toContain('packages/codev/src/agent-farm/servers/tower-cron.ts');
    expect(modules).toContain('packages/codev/src/agent-farm/commands/spawn-worktree.ts');
    expect(modules).toContain('apps/vscode/src/commands/view-diff.ts');
  });

  it('every child_process call passes windowsHide or explains why not', () => {
    const violations = reachableModules().flatMap((file) =>
      findUnhiddenSpawns(parse(file), path.relative(REPO_ROOT, file).split(path.sep).join('/')));
    expect(violations, [
      'These child_process uses can run in a process with no console (Tower, a detached CLI, the VS Code',
      'extension host). On Windows an unhidden console child opens a visible window there (Issue #1919).',
      'Pass `windowsHide: true` in the options (a no-op on POSIX), route through commandLaunch(), or, if',
      'the call never runs on Windows, add `// windows-console: <reason>` on its line or the line above.',
    ].join('\n')).toEqual([]);
  });

  describe('the scanner', () => {
    const scan = (text: string): string[] => findUnhiddenSpawns(parse('fixture.ts', text), 'fixture.ts');

    it('flags an unhidden call, a promisified alias and a binding passed as a value', () => {
      expect(scan([
        "import { execFile, spawn } from 'node:child_process';",
        "import { promisify } from 'node:util';",
        'const run = promisify(execFile);',
        "execFile('git', ['status'], { cwd: '/x' }, () => {});",
        "await run('git', ['status']);",
        'const deps = { spawn };',
      ].join('\n'))).toEqual([
        'fixture.ts:4 execFile(...)',
        'fixture.ts:5 run(...)',
        'fixture.ts:6 spawn (passed as a value)',
      ]);
    });

    it('flags an inline promisify call and a dynamically imported binding', () => {
      expect(scan([
        "import { exec } from 'node:child_process';",
        "import { promisify } from 'node:util';",
        "await promisify(exec)('ls', { cwd: '/x' });",
        'async function f() {',
        "  const { spawn: run } = await import('node:child_process');",
        "  run('tail', ['-f', 'x']);",
        '}',
      ].join('\n'))).toEqual([
        'fixture.ts:3 exec(...)',
        'fixture.ts:6 run(...)',
      ]);
    });

    it('ignores method names and type positions', () => {
      expect(scan([
        "import { spawn } from 'node:child_process';",
        'let child: ReturnType<typeof spawn>;',
        'const launcher = { spawn(command: string) { return command; } };',
      ].join('\n'))).toEqual([]);
    });

    it('accepts windowsHide inline, through a const, renamed imports and annotations', () => {
      expect(scan([
        "import { execFile as ef, spawn } from 'child_process';",
        "ef('git', ['status'], { windowsHide: true }, () => {});",
        "const opts = { stdio: 'pipe', windowsHide: true };",
        "spawn('git', [], opts);",
        '// windows-console: posix-only',
        "spawn('ps', []);",
        "const deps = { spawn: spawn }; // windows-console: injected; the caller's options carry windowsHide",
        'deps.spawn();',
      ].join('\n'))).toEqual([]);
    });

    it('rejects windowsHide that is not the literal true', () => {
      expect(scan([
        "import { spawn } from 'node:child_process';",
        "spawn('git', [], { windowsHide: false });",
        'const hide = true;',
        "spawn('git', [], { windowsHide: hide });",
        "spawn('git', [], { windowsHide });",
      ].join('\n'))).toHaveLength(3);
    });
  });
});
