/**
 * Spec 1280 — T17: four-tree parity for skills this project touches.
 *
 * Skills exist in FOUR places: `.claude/skills`, `.codex/skills`, and the skeleton's copies
 * of both. Principles P3/P4 relocate how-to content out of CLAUDE.md into skills — and a
 * relocation written to only one tree silently:
 *   - leaves Codex agents without the content,
 *   - leaves adopters without it after `codev update`, and
 *   - is reported as a DELETION by the measurement instrument (M0c), inverting the
 *     project's own honesty artifact.
 *
 * SCOPE — per the architect's plan-gate ruling (2026-08-01): every skill this project
 * TOUCHES must be four-tree consistent. Skills it does not touch are EXEMPT; their
 * pre-existing drift (`afx`, `porch`) and skeleton-absence (`forge`, `skill-creator`,
 * `team`) belong to a separate architect-filed issue and must not fail this test.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');

/**
 * Skills touched by Spec 1280. Adding a skill to this list is a deliberate act: it asserts
 * the project now owns that skill's four-tree consistency.
 */
const TOUCHED_SKILLS = ['runnable-worktrees', 'codev'] as const;

const TREES = [
  '.claude/skills',
  '.codex/skills',
  'codev-skeleton/.claude/skills',
  'codev-skeleton/.codex/skills',
] as const;

const skillPath = (tree: string, skill: string) =>
  path.join(repoRoot, tree, skill, 'SKILL.md');

describe('T17 — touched skills are consistent across all four trees', () => {
  for (const skill of TOUCHED_SKILLS) {
    it(`${skill}: present in every tree`, () => {
      for (const tree of TREES) {
        expect(
          fs.existsSync(skillPath(tree, skill)),
          `${skill} missing from ${tree} — relocated content would be invisible to that audience`,
        ).toBe(true);
      }
    });

    it(`${skill}: byte-identical across every tree`, () => {
      const canonical = fs.readFileSync(skillPath('.claude/skills', skill), 'utf-8');
      for (const tree of TREES.slice(1)) {
        expect(
          fs.readFileSync(skillPath(tree, skill), 'utf-8'),
          `${skill} differs between .claude/skills and ${tree}`,
        ).toBe(canonical);
      }
    });

    it(`${skill}: carries usable frontmatter`, () => {
      const body = fs.readFileSync(skillPath('.claude/skills', skill), 'utf-8');
      expect(body.startsWith('---\n'), `${skill} has no frontmatter block`).toBe(true);
      expect(body).toMatch(new RegExp(`^name:\\s*${skill}$`, 'm'));
      // The description is the trigger surface — an empty one makes the skill undiscoverable,
      // which for relocated content means the content is effectively lost.
      const desc = body.match(/^description:\s*(.+)$/m);
      expect(desc, `${skill} has no description`).not.toBeNull();
      expect(desc![1].trim().length).toBeGreaterThan(40);
    });
  }

  it('untouched skills are exempt — pre-existing drift must not fail this test', () => {
    // Guards the ruling itself: if someone later widens TOUCHED_SKILLS to "all skills", this
    // test starts failing on drift this project deliberately did not take on.
    const claudeSkills = fs
      .readdirSync(path.join(repoRoot, '.claude/skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const untouched = claudeSkills.filter((s) => !TOUCHED_SKILLS.includes(s as never));
    expect(untouched.length, 'expected some skills to be out of scope').toBeGreaterThan(0);
  });
});
