/**
 * Spec 987 — Phase 6: governance-doc sweep invariants.
 *
 * Guards the dual-tree footgun for the MAINTAIN/skill/root-doc surfaces:
 *  - CLAUDE.md and AGENTS.md stay byte-identical (the long-standing invariant the
 *    hot block must not break), and
 *  - the skill + MAINTAIN protocol (both trees) reference the hot tier, so a future
 *    edit that reverts one tree or drops the hot-tier guidance fails loudly.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

describe('Spec 987 — CLAUDE.md ≡ AGENTS.md', () => {
  it('keeps the two root docs byte-identical', () => {
    expect(read('CLAUDE.md')).toBe(read('AGENTS.md'));
  });

  it('carries the generated hot-context managed block', () => {
    const claude = read('CLAUDE.md');
    expect(claude).toContain('<!-- BEGIN CODEV HOT CONTEXT');
    expect(claude).toContain('<!-- END CODEV HOT CONTEXT -->');
  });
});

describe('Spec 987 — MAINTAIN + skill reference the hot tier (both trees)', () => {
  const HOT_TIER_SURFACES = [
    '.claude/skills/update-arch-docs/SKILL.md',
    'codev-skeleton/.claude/skills/update-arch-docs/SKILL.md',
    'codev/protocols/maintain/protocol.md',
    'codev-skeleton/protocols/maintain/protocol.md',
    'codev/protocols/maintain/prompts/maintain.md',
    'codev-skeleton/protocols/maintain/prompts/maintain.md',
  ];

  it.each(HOT_TIER_SURFACES)('%s references arch-critical.md and lessons-critical.md', (rel) => {
    const c = read(rel);
    expect(c, `${rel} should mention arch-critical.md`).toMatch(/arch-critical\.md/);
    expect(c, `${rel} should mention lessons-critical.md`).toMatch(/lessons-critical\.md/);
  });

  it('keeps the skill identical across the two trees', () => {
    expect(read('.claude/skills/update-arch-docs/SKILL.md')).toBe(
      read('codev-skeleton/.claude/skills/update-arch-docs/SKILL.md')
    );
  });
});
