/**
 * Spec 1280 — T16: phase-manifest completeness (the mechanical guard on M11).
 *
 * M11 requires the architect to inspect the old-vs-new diff of EVERY changed
 * file, per phase, in batches of <=12. That review is the project's acceptance
 * mechanism — but a human can only inspect what they are shown. A file changed
 * in a phase and omitted from that phase's manifest is invisible to the review,
 * so it fails the phase.
 *
 * This test is written in Phase 0, before the first manifest exists, precisely
 * because the guard must predate the thing it guards.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const manifestDir = path.join(
  repoRoot,
  'codev/projects/1280-prompt-surface-judgment-not-ru/manifests',
);

interface Manifest {
  file: string;
  phase: string;
  rows: { path: string; oldWords: string; newWords: string; principles: string }[];
}

/**
 * Expand `{a,b}/rest` into `a/rest`, `b/rest`.
 *
 * DELIBERATE FORMAT DECISION (Spec 1280, Phase 3): the plan's inspection model is per
 * DECISION, not per file — twins are byte-identical and T7 verifies the sync mechanically, so
 * the architect reads ~66 decisions rather than 131 diffs. One manifest row therefore names
 * both tree paths, and the ≤12 batch cap counts decisions. The parser has to understand that
 * notation or the skeleton twins read as uninspectable — which is exactly what it reported.
 */
function expandBraces(p: string): string[] {
  const m = p.match(/^\{([^}]+)\}(.*)$/);
  if (!m) return [p];
  return m[1].split(',').map((alt) => alt.trim() + m[2]);
}

function parseManifest(file: string): Manifest {
  const body = fs.readFileSync(file, 'utf-8');
  const rows: Manifest['rows'] = [];
  for (const line of body.split('\n')) {
    // | path | old | new | principles | rationale |
    const m = line.match(/^\|\s*`?([^`|]+?)`?\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([^|]*)\|/);
    if (m && !/^-+$/.test(m[1].trim())) {
      for (const expanded of expandBraces(m[1].trim())) rows.push({
        path: expanded,
        oldWords: m[2],
        newWords: m[3],
        principles: m[4].trim(),
      });

    }
  }
  return { file, phase: path.basename(file, '.md'), rows };
}

function manifests(): Manifest[] {
  if (!fs.existsSync(manifestDir)) return [];
  return fs
    .readdirSync(manifestDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => parseManifest(path.join(manifestDir, f)));
}

describe('T16 — manifest completeness (M11)', () => {
  it('the manifest directory is a known location, created when the first phase lands', () => {
    // Phase 0 changes no prompt-bearing file, so an absent directory is valid here.
    // From Phase 1 onward the per-phase check below does the real work.
    expect(path.isAbsolute(manifestDir)).toBe(true);
  });

  it('every manifest row carries all four required fields', () => {
    for (const m of manifests()) {
      expect(m.rows.length, `${m.phase} has no rows`).toBeGreaterThan(0);
      for (const r of m.rows) {
        expect(r.path, `${m.phase}: empty path`).not.toBe('');
        expect(r.oldWords, `${m.phase}/${r.path}: old word count`).toMatch(/^\d+$/);
        expect(r.newWords, `${m.phase}/${r.path}: new word count`).toMatch(/^\d+$/);
        expect(
          r.principles,
          `${m.phase}/${r.path}: must name the principles applied (P1..P7 or "none")`,
        ).toMatch(/P[1-7]|none/i);
      }
    }
  });

  it('no manifest declares a batch larger than 12 files', () => {
    for (const m of manifests()) {
      const body = fs.readFileSync(m.file, 'utf-8');
      // A manifest may declare several batches; each is capped independently.
      const batches = body.split(/^##+\s+Batch\s/im).slice(1);
      if (batches.length === 0) {
        expect(m.rows.length, `${m.phase}: single-batch manifest over the cap`).toBeLessThanOrEqual(12);
      } else {
        for (const [i, b] of batches.entries()) {
          const n = (b.match(/^\|\s*`?[^`|]+?`?\s*\|\s*\d+\s*\|/gm) || []).length;
          expect(n, `${m.phase} batch ${i + 1} over the cap`).toBeLessThanOrEqual(12);
        }
      }
    }
  });

  // RETIRED under Spec 1280 (retirement R5, Waleed's ruling 2026-08-06): the repo-wide
  // manifest-COMPLETENESS scan ("every prompt-bearing file THIS PROJECT changed appears in some
  // manifest"). Even scoped by [Spec 1280] commit provenance, it lived in the SHARED suite and ran
  // a repo diff + `git status` on every PR — its uncommitted-file check caught Mohid's #1330
  // (which had to strip its CLAUDE.md/AGENTS.md edits to pass CI). The cross-project CI tax isn't
  // worth the mechanical enforcement. What SURVIVES: the per-phase manifests themselves and the
  // M11 human inspection contract are unchanged — the architect still inspects against a complete
  // manifest — and the FORMAT checks above (four required fields, batch cap) still validate this
  // project's own manifests. Only the CI tripwire is gone. Full trace: codev/resources/1280-retirements.md (R5).
});
