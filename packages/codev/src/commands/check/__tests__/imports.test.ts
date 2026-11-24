/**
 * Spec 1951 — audited imports: `runner.ts` is the only path to a subprocess in
 * `commands/check/`.
 *
 * Every import in the other source files must be on the list below. Adding one means
 * adding it here WITH A REASON, which keeps the "single subprocess path" rule reviewable.
 * Type-only imports (`import type …`) are erased at compile time and so are not audited.
 * The stub-PATH recorder in git-facts.test.ts catches anything that slips past at run time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const CHECK_DIR = path.resolve(__dirname, '..');

interface ImportRule {
  /** Named imports allowed; `'*'` allows any (only for modules inside commands/check/). */
  names: readonly string[] | '*';
  reason: string;
}

/** Imports allowed in every source file other than runner.ts. */
const ALLOWED: Record<string, ImportRule> = {
  'node:path': { names: '*', reason: 'path arithmetic only; no I/O' },
  'node:fs': {
    names: ['existsSync', 'readFileSync', 'realpathSync', 'statSync', 'lstatSync'],
    reason: 'read-only file system calls',
  },
  '../../lib/config.js': {
    names: ['loadConfig', 'findConfigSource'],
    reason: 'reads configuration files; never writes or spawns',
  },
  commander: {
    names: ['Command', 'CommanderError'],
    reason: 'argument parsing for the check group (index.ts); only action-handler subcommands, never the executable form that spawns',
  },
};

/** runner.ts alone may reach a subprocess. */
const RUNNER_ALLOWED: Record<string, ImportRule> = {
  'node:child_process': { names: ['spawn', 'ChildProcess', 'SpawnOptions'], reason: 'git is spawned from argv here, after the allow-list check' },
  '../../lib/forge.js': {
    names: ['executeForgeCommandDetailed', 'getForgeCommand', 'loadForgeConfig', 'ForgeConfig'],
    reason: 'the forge dispatcher, called only for the four read concepts',
  },
};

interface ParsedImport {
  specifier: string;
  names: string[] | '*';
  typeOnly: boolean;
}

/** Static imports and re-exports, plus any dynamic import() or require(). */
export function parseImports(source: string): { imports: ParsedImport[]; dynamic: string[] } {
  const imports: ParsedImport[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(statement)) {
    const clause = match[3];
    const typeOnly = Boolean(match[2]);
    let names: string[] | '*';
    if (/\*\s+as\s+\w+/.test(clause) || clause.trim() === '*') {
      names = '*';
    } else {
      const braces = /\{([\s\S]*)\}/.exec(clause);
      names = braces
        ? braces[1].split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]).filter(Boolean)
        : [];
      const defaultName = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim();
      if (defaultName) names.push(`default:${defaultName}`);
    }
    imports.push({ specifier: match[4], names, typeOnly });
  }
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    imports.push({ specifier: match[1], names: [], typeOnly: false });
  }
  const dynamic = [...source.matchAll(/\b(import|require)\s*\(\s*['"]?([^'")]*)/g)].map((m) => `${m[1]}(${m[2]})`);
  return { imports, dynamic };
}

const sources = fs
  .readdirSync(CHECK_DIR)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  .sort();

describe('Spec 1951 — audited imports in commands/check/', () => {
  it('audits every source file in the directory', () => {
    expect(sources).toEqual(
      expect.arrayContaining([
        'allow-list.ts', 'git-facts.ts', 'index.ts', 'pr.ts', 'render.ts', 'report.ts', 'roots.ts', 'runner.ts', 'settings.ts', 'validate.ts',
      ]),
    );
  });

  it.each(sources)('%s imports only what the list allows', (file) => {
    const { imports, dynamic } = parseImports(fs.readFileSync(path.join(CHECK_DIR, file), 'utf-8'));
    expect(dynamic, `${file} uses a dynamic import or require`).toEqual([]);
    const rules = file === 'runner.ts' ? { ...ALLOWED, ...RUNNER_ALLOWED } : ALLOWED;
    for (const imp of imports) {
      if (imp.typeOnly) continue;
      if (imp.specifier.startsWith('./')) {
        expect(fs.existsSync(path.join(CHECK_DIR, imp.specifier.replace(/\.js$/, '.ts'))), `${file}: ${imp.specifier}`).toBe(true);
        continue;
      }
      const rule = rules[imp.specifier];
      expect(rule, `${file} imports ${imp.specifier}, which is not on the audited list`).toBeDefined();
      if (rule.names === '*') continue;
      expect(imp.names, `${file} imports ${imp.specifier} as a namespace`).not.toBe('*');
      for (const name of imp.names as string[]) {
        expect(rule.names, `${file} imports ${name} from ${imp.specifier}`).toContain(name);
      }
    }
  });

  it('only runner.ts imports child_process or the forge dispatcher', () => {
    for (const file of sources.filter((f) => f !== 'runner.ts')) {
      const { imports } = parseImports(fs.readFileSync(path.join(CHECK_DIR, file), 'utf-8'));
      const specifiers = imports.filter((i) => !i.typeOnly).map((i) => i.specifier);
      expect(specifiers.filter((s) => /child_process|lib\/forge\.js$/.test(s)), file).toEqual([]);
    }
  });

  it('the parser sees every kind of import it audits', () => {
    const parsed = parseImports(
      [
        "import { a, type B, c as d } from 'x';",
        "import * as ns from 'y';",
        "import def, { e } from 'z';",
        "import type { T } from 't';",
        "export { f } from 'w';",
        "import 'side-effect';",
        "const m = await import('dyn');",
        "const r = require('req');",
      ].join('\n'),
    );
    expect(parsed.imports).toEqual([
      { specifier: 'x', names: ['a', 'B', 'c'], typeOnly: false },
      { specifier: 'y', names: '*', typeOnly: false },
      { specifier: 'z', names: ['e', 'default:def'], typeOnly: false },
      { specifier: 't', names: ['T'], typeOnly: true },
      { specifier: 'w', names: ['f'], typeOnly: false },
      { specifier: 'side-effect', names: [], typeOnly: false },
    ]);
    expect(parsed.dynamic).toEqual(['import(dyn)', 'require(req)']);
  });
});
