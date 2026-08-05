/**
 * Issue #1352: packages/codev's build must derive its workspace-dependency
 * closure from the pnpm graph, never from a hand-maintained package list.
 *
 * The hand-list in the root build script had already drifted from the graph
 * (it built artifact-canvas, which is not in codev's closure, and omitted
 * apps/web, which is). A missing or stale dep dist/ then surfaced as
 * convincing false TS errors in codev's own sources (TS2339/TS2307).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const readScripts = (rel: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(repoRoot, rel), 'utf-8')).scripts;

describe('Issue #1352 — graph-derived build closure', () => {
  it('packages/codev build starts with the graph-derived dependency closure', () => {
    const scripts = readScripts('packages/codev/package.json');
    expect(scripts.build).toContain('--filter "@cluesmith/codev^..." build');
  });

  it('root build does not hand-list codev workspace deps (drift class removed)', () => {
    const scripts = readScripts('package.json');
    for (const dep of ['codev-types', 'codev-sdk', 'codev-core', 'codev-web']) {
      expect(scripts.build, `root build should not hand-list ${dep}`).not.toContain(dep);
    }
  });
});
