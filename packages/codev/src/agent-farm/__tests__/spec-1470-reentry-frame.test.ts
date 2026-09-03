/**
 * Spec 1470, Phase 5 — the re-entry frame and skill parity.
 *
 * ## The finding this file exists for
 *
 * During the specify phase I probed the behaviour directly: `afx send <self>
 * "..."` from inside a builder worktree is delivered, and the harness renders it
 * as `### [ARCHITECT INSTRUCTION | … ] ###`. **A builder cannot distinguish its
 * own scheduled message from an order.**
 *
 * That probe is why acceptance criterion 33 exists. And the frame shipped
 * without the discriminator anyway — the criterion was written, the reason was
 * documented, and the implementation used the shared re-orientation verbatim.
 * These tests pin the marker so it cannot be lost again.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  AUTOMATIC_REENTRY_MARKER,
  buildAutomaticReentryFrame,
} from '../commands/reset/self.js';

const REPO_ROOT = resolve(__dirname, '../../../../..');

describe('the automatic re-entry frame', () => {
  const inline = [
    '## CONTEXT REFRESH — re-orientation',
    'You are a Builder',
    '.builder-role.md',
    'Protocol: spir',
    'Mode: strict',
    'Project ID: 1470',
    'Run `porch next`',
  ].join('\n');

  it('leads with the automatic-refresh marker', () => {
    const frame = buildAutomaticReentryFrame(inline);
    expect(frame.startsWith(AUTOMATIC_REENTRY_MARKER)).toBe(true);
  });

  it('says explicitly that it is not an architect instruction', () => {
    // The failure mode is a builder treating its own re-orientation as a new
    // order, or worse, waiting for a follow-up that will never come.
    const frame = buildAutomaticReentryFrame(inline);
    expect(frame).toMatch(/not an architect instruction/i);
    expect(frame).toMatch(/from YOU, not from the architect/i);
    expect(frame).toMatch(/Nobody is\s+waiting on a reply/i);
  });

  it('preserves every element of the underlying re-orientation', () => {
    // The discriminator must PREFIX the frame, not replace it — R3's guarantee
    // is that the frame carries identity, protocol, mode and project.
    const frame = buildAutomaticReentryFrame(inline);
    for (const required of [
      'You are a Builder',
      '.builder-role.md',
      'Protocol: spir',
      'Mode: strict',
      'Project ID: 1470',
      'porch next',
    ]) {
      expect(frame, `frame must retain: ${required}`).toContain(required);
    }
  });

  it('points the builder at porch next rather than at a person', () => {
    const frame = buildAutomaticReentryFrame(inline);
    expect(frame).toMatch(/porch next/);
  });

  it('is idempotent in shape — wrapping does not nest markers', () => {
    // A double-wrap would produce two "not an architect instruction" headers and
    // read as though something had gone wrong.
    const once = buildAutomaticReentryFrame(inline);
    const occurrences = once.split(AUTOMATIC_REENTRY_MARKER).length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('builder-refresh skill parity', () => {
  const LOCATIONS = [
    '.claude/skills/builder-refresh/SKILL.md',
    '.codex/skills/builder-refresh/SKILL.md',
    'codev-skeleton/.claude/skills/builder-refresh/SKILL.md',
    'codev-skeleton/.codex/skills/builder-refresh/SKILL.md',
  ];

  const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf-8');

  it('exists in all four required locations', () => {
    for (const rel of LOCATIONS) {
      expect(() => read(rel), `missing: ${rel}`).not.toThrow();
    }
  });

  it('is byte-identical across all four', () => {
    const [first, ...rest] = LOCATIONS.map(read);
    for (const [i, body] of rest.entries()) {
      expect(body, `${LOCATIONS[i + 1]} differs from ${LOCATIONS[0]}`).toBe(first);
    }
  });

  it('DEFERS to porch for the commands rather than restating them', () => {
    // The single-source decision: --boundary had already been dropped at two of
    // three emission points, so the skill does not become a fourth copy.
    const body = read(LOCATIONS[0]);
    const invocationLines = body
      .split('\n')
      .filter(line => /^\s*(\$ )?afx self-refresh/.test(line));

    expect(
      invocationLines,
      `the skill must not hand-write invocations; it defers to porch's task text:\n${invocationLines.join('\n')}`,
    ).toHaveLength(0);

    expect(body).toMatch(/commands porch gave you|porch's refresh task contains/i);
  });

  it('does NOT claim every refusal leaves the context intact', () => {
    // clear-failed means the clear was attempted and may have landed. An
    // earlier draft flattened that into "a refusal means your context is
    // intact", undoing the distinction the command was built to preserve.
    const body = read(LOCATIONS[0]);
    expect(body).toMatch(/clear-failed/);
    expect(body).toMatch(/may still have landed|may or may not have landed/i);
    expect(body).not.toMatch(/A refusal is the safe outcome, and it means your context is intact/);
  });

  it('tells the builder to stop rather than start new work', () => {
    const body = read(LOCATIONS[0]);
    expect(body).toMatch(/end your turn/i);
    expect(body).toMatch(/Do not start new work/i);
  });
});

describe('skill directory parity is enforced repo-wide', () => {
  it('every .claude skill has a .codex twin, in both trees', () => {
    // Guards the pairing itself, so a future skill cannot land in one provider
    // directory only — the failure that made this phase's suite red.
    for (const base of ['', 'codev-skeleton']) {
      const claude = join(REPO_ROOT, base, '.claude', 'skills');
      const codex = join(REPO_ROOT, base, '.codex', 'skills');
      const list = (p: string): string[] =>
        readdirSync(p, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
          .sort();

      expect(list(claude), `${base || 'root'}: .claude and .codex skills differ`).toEqual(
        list(codex),
      );
    }
  });
});
