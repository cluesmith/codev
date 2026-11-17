/**
 * Issue #1740: the tracker-key grammar has one home per package that cannot
 * import another (codev, the VS Code extension, the web dashboard) plus the
 * Jira shell scripts. Sync notes alone have let twins drift in this repo
 * before (#1196, #1489), so this test extracts every copy from source and
 * compares it with the codev-side constants.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CANONICAL_KEY_SOURCE, ISSUE_KEY_SOURCE } from '../lib/issue-id.js';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(resolve(repoRoot, rel), 'utf-8');

/** The string literal assigned to `export const <name> = '...'`, as the regex source it denotes. */
function exportedSource(rel: string, name: string): string {
  const m = read(rel).match(new RegExp(`export const ${name} = '([^']+)';`));
  if (!m) throw new Error(`${name} not found in ${rel}`);
  // The literal escapes its backslash ('\\d'); the source it denotes has one (\d).
  return m[1].replace(/\\\\/g, '\\');
}

/** Shell/jq copies spell \d as the POSIX [0-9]. */
const posix = (source: string) => source.replace(/\\d/g, '[0-9]');

describe('issue-key grammar parity (#1740)', () => {
  it('the VS Code extension carries the same key grammar', () => {
    expect(exportedSource('apps/vscode/src/issue-id.ts', 'ISSUE_KEY_SOURCE')).toBe(ISSUE_KEY_SOURCE);
    expect(exportedSource('apps/vscode/src/issue-id.ts', 'CANONICAL_KEY_SOURCE')).toBe(CANONICAL_KEY_SOURCE);
  });

  it('the web dashboard carries the same canonical-key grammar', () => {
    expect(exportedSource('apps/web/src/lib/issueIds.ts', 'CANONICAL_KEY_SOURCE')).toBe(CANONICAL_KEY_SOURCE);
  });

  it('the Jira scripts validate ids with the same grammar', () => {
    const anchored = `^${posix(ISSUE_KEY_SOURCE)}$`;
    expect(read('packages/codev/scripts/forge/jira/_lib.sh')).toContain(`grep -Eq '${anchored}'`);
    expect(read('packages/codev/scripts/forge/jira/recently-closed.sh')).toContain(`test("${anchored}")`);
  });

  it('no extension or dashboard file hand-writes the key grammar outside its home', () => {
    // Everything else derives from the exported constants; a literal copy elsewhere is a drift risk.
    const literal = /\[A-Za-z\]\[A-Za-z0-9_\]\*-\\d\+|\[A-Z\]\[A-Z0-9_\]\*-\\d\+/;
    for (const rel of [
      'apps/vscode/src/views/backlog-search.ts',
      'apps/vscode/src/views/backlog-filter.ts',
      'apps/vscode/src/commands/open-issue-by-id.ts',
      'apps/web/src/components/WorkView.tsx',
    ]) {
      expect(literal.test(read(rel)), rel).toBe(false);
    }
  });
});
