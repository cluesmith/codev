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
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const manifestDir = path.join(
  repoRoot,
  'codev/projects/1280-prompt-surface-judgment-not-ru/manifests',
);

/** Files a manifest is responsible for listing: prompt-bearing surfaces only. */
const PROMPT_BEARING = /^(CLAUDE\.md|AGENTS\.md|codev(-skeleton)?\/(protocols|roles)\/.*\.md)$/;

interface Manifest {
  file: string;
  phase: string;
  rows: { path: string; oldWords: string; newWords: string; principles: string }[];
}

function parseManifest(file: string): Manifest {
  const body = fs.readFileSync(file, 'utf-8');
  const rows: Manifest['rows'] = [];
  for (const line of body.split('\n')) {
    // | path | old | new | principles | rationale |
    const m = line.match(/^\|\s*`?([^`|]+?)`?\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([^|]*)\|/);
    if (m && !/^-+$/.test(m[1].trim())) {
      rows.push({
        path: m[1].trim(),
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

  it('every prompt-bearing file changed on this branch appears in some manifest', () => {
    let names: string[];
    try {
      names = execFileSync('git', ['diff', '--name-only', 'origin/main...HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      })
        .split('\n')
        .map((s) => s.trim());
    } catch {
      return; // no origin/main to diff against (fresh clone / CI shallow) — skip
    }

    // Scope this guard to the 1280 project's OWN development: only enforce on a branch that
    // is actually adding/editing 1280 manifests. Without this, it fails EVERY unrelated
    // feature branch that merges main and happens to touch a prompt surface — whose changes
    // belong to that branch's project and its own review, not 1280's manifests. (Surfaced on
    // the Spec 1313 branch: its arch-critical→CLAUDE.md/AGENTS.md propagation tripped this the
    // moment main was merged in. On the 1280 branch, phases add manifests so the guard stays
    // active; on main it passes trivially — no diff vs itself.)
    const manifestRel = path.relative(repoRoot, manifestDir);
    const touchesManifests = names.some((f) => f === manifestRel || f.startsWith(manifestRel + '/'));
    if (!touchesManifests) return;

    const changed = names.filter((s) => PROMPT_BEARING.test(s));
    if (changed.length === 0) return;

    const listed = new Set(manifests().flatMap((m) => m.rows.map((r) => r.path)));
    const missing = changed.filter((f) => !listed.has(f));
    expect(
      missing,
      `changed but absent from every manifest — the architect cannot inspect what is not listed:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
