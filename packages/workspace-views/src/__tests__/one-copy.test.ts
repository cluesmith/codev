import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative as relativeNative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spec 1963: the Work and Decisions components exist once, here. The dashboard keeps thin
 * wrappers (apps/web/src/components/WorkView.tsx and DecisionsView.tsx) that pass its host; no
 * app keeps a copy of a component or the polling hook. (The key grammar's single home is checked
 * by packages/codev's issue-id-parity test.)
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageSrc = join(here, '..');
const repoRoot = join(packageSrc, '..', '..', '..');

/** A repo-relative path with `/` separators on every platform. */
const relative = (from: string, to: string) => relativeNative(from, to).split(sep).join('/');

/** The moved modules, by file name. */
const MOVED = [
  'BuilderCard.tsx',
  'NeedsAttentionList.tsx',
  'BacklogList.tsx',
  'RecentlyClosedList.tsx',
  'useDecisions.ts',
];

/** The two dashboard wrappers, which keep their names and their place in App.tsx. */
const WRAPPERS = ['apps/web/src/components/WorkView.tsx', 'apps/web/src/components/DecisionsView.tsx'];

/** Source trees an app or package ships from (never node_modules, build output or tests). */
const TREES = ['apps', 'packages'];
const SKIP = new Set(['node_modules', 'dist', 'out', 'dashboard-dist', 'skeleton', '__tests__', '.vscode-test']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('one copy of the Work and Decisions components', () => {
  const files = TREES.flatMap((tree) => sourceFiles(join(repoRoot, tree)));

  it.each(MOVED)('%s exists only in packages/workspace-views/src', (name) => {
    const found = files.filter((f) => basename(f) === name).map((f) => relative(repoRoot, f));
    expect(found).toHaveLength(1);
    expect(found[0].startsWith('packages/workspace-views/src/')).toBe(true);
  });

  it('WorkView.tsx and DecisionsView.tsx are the package\'s components plus the dashboard\'s wrappers, nothing else', () => {
    const found = files
      .filter((f) => ['WorkView.tsx', 'DecisionsView.tsx'].includes(basename(f)))
      .map((f) => relative(repoRoot, f))
      .sort();
    expect(found).toEqual([
      ...WRAPPERS,
      'packages/workspace-views/src/components/DecisionsView.tsx',
      'packages/workspace-views/src/components/WorkView.tsx',
    ].sort());
  });

  it.each(WRAPPERS)('%s renders the package\'s component and defines none of its own', (rel) => {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    expect(text).toMatch(/from '@cluesmith\/codev-workspace-views'/);
    // A wrapper renders the shared component; it never re-implements one (no card, list or form).
    expect(text).not.toMatch(/className="(builder-table|decisions-card|attention-rows|backlog-rows|decisions-form)/);
  });

  it('no file outside the package defines the decisions poll interval', () => {
    for (const f of files) {
      if (f.startsWith(packageSrc)) continue;
      expect(/\bDECISIONS_POLL_MS\s*=/.test(readFileSync(f, 'utf8')), relative(repoRoot, f)).toBe(false);
    }
  });
});
