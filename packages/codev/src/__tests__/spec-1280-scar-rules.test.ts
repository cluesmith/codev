/**
 * T4 — scar-rule registry enforcement (Spec 1280, Phase 9).
 *
 * The scar rules are the one deliberate exception to P7 (Baked Decision 2): eight prohibitions,
 * kept VERBATIM, that guard irreversible acts (destroyed worktrees, killed sessions, bypassed
 * human gates) where the cost of being wrong once is unbounded. `codev/resources/scar-rules.yaml`
 * is the single source of truth: the canonical wording lives there once, and every surface listed
 * under a rule's `must_appear_on` must carry that exact string.
 *
 * This test — created in Phase 9, the first phase where the surface has stopped moving so
 * `must_appear_on` is meaningful — pins:
 *   1. the count at 8 and the exact ids (deleting or renaming a rule fails);
 *   2. byte-identical carriage of each canonical on every listed surface (rewording any copy fails);
 *   3. the carriage guarantee that all eight ride the primary always-on surface (CLAUDE.md + AGENTS.md).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const registryPath = path.join(repoRoot, 'codev/resources/scar-rules.yaml');

interface ScarRule {
  id: string;
  canonical: string;
  must_appear_on: string[];
}

const registry = yaml.load(fs.readFileSync(registryPath, 'utf-8')) as { scar_rules: ScarRule[] };
const rules = registry.scar_rules;

// The eight ratified ids, pinned. Deleting or renaming a rule breaks this list.
const EXPECTED_IDS = [
  'git-add-explicit',
  'never-destroy-worktrees',
  'no-destructive-git',
  'human-gates',
  'no-hand-edit-status',
  'afx-from-root',
  'shellper-verified-orphan',
  'tower-restart-permission',
];

describe('T4 — scar-rule registry (Spec 1280)', () => {
  it('pins the count at 8', () => {
    expect(rules).toHaveLength(8);
  });

  it('pins the exact ids', () => {
    expect(rules.map((r) => r.id).sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it('every rule has a non-empty canonical and at least one surface', () => {
    for (const r of rules) {
      expect(r.canonical, `${r.id}: empty canonical`).toBeTruthy();
      expect(r.must_appear_on?.length, `${r.id}: no surfaces`).toBeGreaterThan(0);
    }
  });

  describe('each canonical appears byte-identically on every listed surface', () => {
    for (const r of rules) {
      for (const rel of r.must_appear_on) {
        it(`${r.id} → ${rel}`, () => {
          const p = path.join(repoRoot, rel);
          expect(fs.existsSync(p), `${rel} listed for ${r.id} does not exist`).toBe(true);
          const content = fs.readFileSync(p, 'utf-8');
          expect(
            content.includes(r.canonical),
            `${r.id} canonical not found byte-identically in ${rel} — a reworded or dropped copy`,
          ).toBe(true);
        });
      }
    }
  });

  it('all eight ride the primary always-on surface (CLAUDE.md + AGENTS.md)', () => {
    for (const r of rules) {
      expect(r.must_appear_on, `${r.id} missing CLAUDE.md`).toContain('CLAUDE.md');
      expect(r.must_appear_on, `${r.id} missing AGENTS.md`).toContain('AGENTS.md');
    }
  });
});
