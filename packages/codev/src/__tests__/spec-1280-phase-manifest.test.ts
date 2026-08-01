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

  it('every prompt-bearing file THIS PROJECT changed appears in some manifest', () => {
    // SCOPED TO THIS PROJECT'S OWN CHANGES — and that scoping is a bug fix, not a convenience.
    //
    // The first version's predicate was repo-global: "any prompt-bearing path in
    // origin/main...HEAD must appear in a 1280 manifest". Since this test lives in the SHARED
    // suite, it fired on other projects — Spec 1307 was blocked by it and would have had to
    // file paperwork in 1280's project directory to go green. A guard that taxes work it does
    // not govern is a broken guard, however well it protects its own project.
    //
    // Provenance, not paths, is the right predicate: only files touched by THIS project's
    // commits are this project's to document. Attribution is by commit-subject tag, which is
    // the same marker the protocol already requires of every commit here.
    const gitOut = (args: string[]): string => {
      try {
        return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' });
      } catch {
        return '';
      }
    };

    // Commits on this branch, not on main, that belong to Spec 1280.
    const ownCommits = gitOut(['log', '--format=%H %s', 'origin/main..HEAD'])
      .split('\n')
      .filter((l) => /\[Spec 1280\]/.test(l))
      .map((l) => l.split(' ')[0])
      .filter(Boolean);

    const onThisProjectsBranch =
      ownCommits.length > 0 || /1280/.test(gitOut(['rev-parse', '--abbrev-ref', 'HEAD']));

    // Any other project's branch: this test has nothing to say. Skip, taxing nobody.
    if (!onThisProjectsBranch) return;

    const changed = new Set<string>();
    for (const sha of ownCommits) {
      for (const f of gitOut(['show', '--name-only', '--format=', sha]).split('\n')) {
        if (PROMPT_BEARING.test(f.trim())) changed.add(f.trim());
      }
    }
    // Uncommitted work counts too: running before committing must not pass vacuously (the
    // failure that cost an inspection cycle in Phase 3).
    for (const l of gitOut(['status', '--porcelain']).split('\n')) {
      const f = l.slice(3).trim();
      if (f && PROMPT_BEARING.test(f)) changed.add(f);
    }
    if (changed.size === 0) return;

    const listed = new Set(manifests().flatMap((m) => m.rows.map((r) => r.path)));
    const missing = [...changed].filter((f) => !listed.has(f));
    expect(
      missing,
      `changed by Spec 1280 but absent from every manifest — the architect cannot inspect what is not listed:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});
