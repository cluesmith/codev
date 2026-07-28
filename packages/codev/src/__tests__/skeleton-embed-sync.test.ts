/**
 * Embedded-skeleton sync guard (Spec 1252, Phase 4 iter-3).
 *
 * `resolveCodevFile()` serves the EMBEDDED skeleton (`packages/codev/skeleton`,
 * a build-time copy made by `pnpm copy-skeleton`), while developers edit the
 * SOURCE tree (`codev-skeleton/`). That copy relationship is the same drift
 * class this project deleted the codev/ shadow tree over — a stale embedded
 * copy would let source-tree tests pass while agents are served old content.
 *
 * This guard closes the loop: every framework file in the source tree must be
 * byte-identical to its embedded counterpart, and vice versa (no extra or
 * missing files). With it green, a test that reads `codev-skeleton/...` and a
 * test that reads through the resolver are validating the same bytes — the
 * source-reading tests guard the commit surface (fail where the dev edits),
 * this guard ties that surface to the serving surface.
 *
 * Skips loudly if the embedded skeleton has not been built.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { getSkeletonDir } from '../lib/skeleton.js';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const SOURCE_SKELETON = path.join(REPO_ROOT, 'codev-skeleton');

const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('embedded skeleton ↔ source skeleton sync', () => {
  const embedded = getSkeletonDir();
  const built = fs.existsSync(embedded);

  it('embedded skeleton exists (run `pnpm copy-skeleton` if this fails locally)', () => {
    expect(built, `embedded skeleton missing at ${embedded}`).toBe(true);
  });

  it.skipIf(!built)('every source file is embedded byte-identically, and nothing extra ships', () => {
    const srcFiles = new Map(
      walk(SOURCE_SKELETON).map((p) => [path.relative(SOURCE_SKELETON, p), p])
    );
    const embFiles = new Map(walk(embedded).map((p) => [path.relative(embedded, p), p]));

    const problems: string[] = [];
    for (const [rel, srcPath] of srcFiles) {
      const embPath = embFiles.get(rel);
      if (!embPath) {
        problems.push(`missing from embedded: ${rel}`);
      } else if (sha(srcPath) !== sha(embPath)) {
        problems.push(`stale in embedded: ${rel}`);
      }
    }
    for (const rel of embFiles.keys()) {
      if (!srcFiles.has(rel)) problems.push(`embedded but not in source: ${rel}`);
    }

    expect(
      problems,
      problems.length
        ? `Embedded skeleton is out of sync with codev-skeleton/ — agents are ` +
          `being served different bytes than the source tree tests validate.\n` +
          `Run \`pnpm copy-skeleton\` in packages/codev.\n` +
          problems.map((p) => `  - ${p}`).join('\n')
        : undefined
    ).toEqual([]);
  });
});
