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

    // Scope this guard to the 1280 project (CMAP round 1 — Gemini/Codex/Claude). As a permanent
    // suite test living on `main`, an unscoped `origin/main...HEAD` diff fires on EVERY unrelated
    // feature branch that touches a prompt surface — e.g. Spec 1313's arch-critical→CLAUDE/AGENTS
    // propagation tripped it the moment main was merged in. Enforce only when this IS 1280 work:
    // the branch name references 1280, or the diff touches the 1280 project tree. Branch-name
    // detection keeps the guard armed on the 1280 branch from its first prompt change (a
    // manifest-dir-touch predicate would silently skip the "changed a prompt file, forgot the
    // manifest entirely" case — the exact failure T16 exists to catch). `git diff` paths are
    // always '/'-separated, so this is Windows-safe (unlike a `path.relative()` compare).
    // NOTE: Spec 1280 is already integrated, so this dev-time guard is now largely vestigial —
    // its owner should remove or re-scope it (e.g. to explicit per-phase commit ranges). Flagged
    // in the PR; not owned by Spec 1313.
    let branch = '';
    try {
      branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).trim();
    } catch {
      /* detached HEAD / no git — fall through to the file-touch signal */
    }
    const isProject1280 = /1280/.test(branch) || names.some((f) => f.startsWith('codev/projects/1280'));
    if (!isProject1280) return;

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
