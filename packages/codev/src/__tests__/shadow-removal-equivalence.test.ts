/**
 * Shadow-tree removal equivalence (Spec 1252, M10 / T9).
 *
 * Phase 4 deleted 77 shadow copies from `codev/protocols|roles|consult-types`.
 * The entire claim of that deletion is that it is a NO-OP for what agents are
 * served: after Phases 3 and 4b reconciled every survivor to the skeleton, the
 * resolver must now return the skeleton counterpart for every deleted path,
 * with content byte-identical to what was resolved immediately before
 * deletion (captured in `fixtures/shadow-removal-manifest.json`).
 *
 * Assembled-prompt equivalence (M10 clause ii) reduces to this content
 * equivalence: `buildPromptFromTemplate` renders the RESOLVED
 * `builder-prompt.md` through `renderTemplate`, a pure function of (template,
 * context) — identical resolved bytes ⇒ identical assembled prompt for any
 * fixed context. The manifest covers every template and protocol file that
 * assembly consumes.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveCodevFile } from '../lib/skeleton.js';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const MANIFEST: Record<string, string> = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'fixtures/shadow-removal-manifest.json'), 'utf-8')
);

const sha = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

describe('shadow-removal equivalence (M10)', () => {
  it('manifest covers all 77 deleted shadow copies', () => {
    expect(Object.keys(MANIFEST).length).toBe(77);
  });

  it('every deleted path resolves to the skeleton with pre-deletion content', () => {
    const mismatches: string[] = [];
    for (const [rel, expectedSha] of Object.entries(MANIFEST)) {
      // (i) the local copy must be gone — tier 2 no longer shadows tier 4
      const local = path.join(REPO_ROOT, 'codev', rel);
      if (fs.existsSync(local)) {
        mismatches.push(`${rel}: local shadow copy still exists`);
        continue;
      }
      // (ii) the resolver must still serve the file, now from the skeleton
      const resolved = resolveCodevFile(rel, REPO_ROOT);
      if (!resolved) {
        mismatches.push(`${rel}: resolver returned nothing after deletion`);
        continue;
      }
      // (iii) content must be byte-identical to what was served pre-deletion
      if (sha(resolved) !== expectedSha) {
        mismatches.push(`${rel}: resolved content differs from pre-deletion snapshot`);
      }
    }
    expect(
      mismatches,
      mismatches.length
        ? `Deletion was NOT a no-op:\n` + mismatches.map((m) => `  - ${m}`).join('\n')
        : undefined
    ).toEqual([]);
  });

  it('local-only entries survived and still resolve (M8 preservation / T8)', () => {
    const preserved = [
      'protocols/release/protocol.md',
      'protocols/maintain/templates/audit-report.md',
      'protocols/maintain/templates/lessons-learned.md',
    ];
    for (const rel of preserved) {
      const local = path.join(REPO_ROOT, 'codev', rel);
      expect(fs.existsSync(local), `${rel} must survive deletion`).toBe(true);
      // and the resolver serves the local copy (they have no skeleton counterpart)
      expect(resolveCodevFile(rel, REPO_ROOT)).toBe(local);
    }
  });
});
