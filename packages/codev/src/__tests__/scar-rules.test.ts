/**
 * Scar-rule registry enforcement (Spec 1252, M5 / T6 / decision D3).
 *
 * Scar rules are prohibitions born from real incidents (data loss, bypassed
 * human gates). They are exempt from the single-owner rule: the canonical
 * wording is replicated VERBATIM on every surface it applies to. What this
 * test makes impossible:
 *
 *   - silently deleting a rule (count and ids are pinned to D3's ratified 8);
 *   - rewording a copy on any surface (byte comparison against the registry);
 *   - weakening the registry itself (schema assertions).
 *
 * Changing a canonical wording requires editing the registry AND every listed
 * surface in one commit — deliberately loud and reviewable.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const REGISTRY = path.join(REPO_ROOT, 'codev', 'resources', 'scar-rules.yaml');

interface ScarRule {
  id: string;
  canonical: string;
  must_appear_on: string[];
}

function loadRegistry(): ScarRule[] {
  const doc = yaml.load(fs.readFileSync(REGISTRY, 'utf-8')) as { scar_rules: ScarRule[] };
  return doc.scar_rules;
}

/** The eight ratified rule ids (D3, 2026-07-28). Changing this list is a spec-level act. */
const RATIFIED_IDS = [
  'git-add-explicit',
  'never-destroy-worktrees',
  'no-destructive-git',
  'human-gates',
  'no-hand-edit-status',
  'afx-from-root',
  'shellper-verified-orphan',
  'tower-restart-permission',
];

describe('scar-rule registry (M5 / T6)', () => {
  it('contains exactly the eight ratified rules', () => {
    const rules = loadRegistry();
    expect(rules.map((r) => r.id).sort()).toEqual([...RATIFIED_IDS].sort());
  });

  it('every rule has a canonical wording of at most two sentences', () => {
    for (const r of loadRegistry()) {
      expect(r.canonical.trim().length, `${r.id}: empty canonical`).toBeGreaterThan(0);
      // D3: one sentence, two max. Count terminal periods not inside backticks
      // or parentheses-final abbreviations — approximate but effective: split
      // on '. ' boundaries plus trailing period.
      const stripped = r.canonical.replace(/`[^`]*`/g, 'CODE');
      const sentences = stripped.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
      expect(
        sentences.length,
        `${r.id}: ${sentences.length} sentences — D3 caps at two`
      ).toBeLessThanOrEqual(2);
    }
  });

  it('every rule appears on CLAUDE.md and AGENTS.md (always-on surfaces)', () => {
    for (const r of loadRegistry()) {
      expect(r.must_appear_on, `${r.id} missing CLAUDE.md`).toContain('CLAUDE.md');
      expect(r.must_appear_on, `${r.id} missing AGENTS.md`).toContain('AGENTS.md');
    }
  });

  it('every canonical wording appears LINE-EXACTLY on every listed surface', () => {
    // Substring matching (`includes`) is not enough: an appended qualifier —
    // "…explicitly by path, unless convenient." — would weaken the rule while
    // still containing the canonical substring (caught by Codex at the Phase-5
    // review). Enforce line-exactness instead: some line on the surface must
    // BE the canonical wording, allowing only a list prefix ("- ", "4. ") and
    // bold markers. Contextual notes (exceptions, conventions) live on their
    // own adjacent lines, where they cannot mutate the rule sentence.
    const lineMatches = (content: string, canonical: string): boolean =>
      content.split('\n').some((line) => {
        const stripped = line.trim().replace(/^(?:[-*]|\d+\.)\s+/, '').replace(/^\*\*|\*\*$/g, '');
        return stripped === canonical;
      });
    const failures: string[] = [];
    for (const r of loadRegistry()) {
      for (const rel of r.must_appear_on) {
        const p = path.join(REPO_ROOT, rel);
        if (!fs.existsSync(p)) {
          failures.push(`${r.id}: surface missing entirely — ${rel}`);
          continue;
        }
        if (!lineMatches(fs.readFileSync(p, 'utf-8'), r.canonical)) {
          failures.push(`${r.id}: no line-exact canonical wording in ${rel}`);
        }
      }
    }
    expect(
      failures,
      failures.length
        ? `Scar-rule enforcement failures — a rule was deleted, reworded, or its ` +
          `surface dropped. This is never a test to weaken; fix the surface or ` +
          `change the registry and ALL surfaces in one reviewed commit.\n` +
          failures.map((f) => `  - ${f}`).join('\n')
        : undefined
    ).toEqual([]);
  });

  it('no stale wording variants survive on registry surfaces', () => {
    // The convergence's point is ONE wording. Old variants of the two most
    // duplicated rules must not linger next to the canonical.
    const staleVariants = [
      'NEVER USE `git add -A`', // the old banner
      'Never use `git add .` or `git add -A`',
      "Don't use `git add .` or `git add -A`",
      'NEVER edit `status.yaml` directly',
      'NEVER edit status.yaml directly',
      'porch manages all state',
    ];
    const surfaces = new Set(loadRegistry().flatMap((r) => r.must_appear_on));
    const failures: string[] = [];
    for (const rel of surfaces) {
      const p = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf-8');
      for (const v of staleVariants) {
        if (content.includes(v)) failures.push(`${rel}: stale variant "${v}"`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });

  it('CLAUDE.md and AGENTS.md remain byte-identical (N3)', () => {
    const a = fs.readFileSync(path.join(REPO_ROOT, 'CLAUDE.md'));
    const b = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'));
    expect(a.equals(b), 'CLAUDE.md and AGENTS.md have diverged').toBe(true);
  });
});
