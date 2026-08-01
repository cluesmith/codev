/**
 * `/arch-save` skill drift + content guard (Spec 1307, phase 2).
 *
 * Mirrors `spec-1134-arch-init-skill.test.ts`. Two distinct guards, and the
 * distinction is the reason this file exists:
 *
 *  - `skill-parity.test.ts` compares Claude against Codex *within* a tree. It
 *    does NOT compare our instance (`.claude/`) against the shipped skeleton
 *    (`codev-skeleton/.claude/`), so the classic "edited codev/ and forgot
 *    codev-skeleton/" drift passes it silently. That is exactly the failure the
 *    repo's own arch-critical rules warn about, and it ships a stale skill to
 *    every adopter while looking green here.
 *  - The content assertions pin the statements the plan required the doc to
 *    make. A skill is a document, so "it exists and is identical everywhere" is
 *    only half of correct — identical copies of a doc missing its load-bearing
 *    warning are still wrong.
 *
 * Phase 2's acceptance criterion was "all four copies identical". It was
 * verified by hand with md5 and NOT guarded by a test until review pointed that
 * out — a one-time check is not a guard.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');

const COPIES = {
  'instance/.claude': path.join(repoRoot, '.claude', 'skills', 'arch-save', 'SKILL.md'),
  'instance/.codex': path.join(repoRoot, '.codex', 'skills', 'arch-save', 'SKILL.md'),
  'skeleton/.claude': path.join(repoRoot, 'codev-skeleton', '.claude', 'skills', 'arch-save', 'SKILL.md'),
  'skeleton/.codex': path.join(repoRoot, 'codev-skeleton', '.codex', 'skills', 'arch-save', 'SKILL.md'),
} as const;

describe('Spec 1307 — /arch-save ships in all four trees', () => {
  it.each(Object.entries(COPIES))('exists: %s', (_label, file) => {
    expect(fs.existsSync(file)).toBe(true);
  });

  it('is byte-identical across all four copies (drift guard)', () => {
    const [first, ...rest] = Object.values(COPIES).map(f => fs.readFileSync(f, 'utf-8'));
    for (const other of rest) {
      expect(other).toBe(first);
    }
  });

  it('guards instance-vs-skeleton drift specifically', () => {
    // Called out separately because skill-parity.test.ts cannot catch it: an
    // edit applied to both providers in the instance but to neither in the
    // skeleton passes provider parity in both contexts and still ships stale.
    expect(fs.readFileSync(COPIES['instance/.claude'], 'utf-8')).toBe(
      fs.readFileSync(COPIES['skeleton/.claude'], 'utf-8'),
    );
  });
});

describe('Spec 1307 — required content', () => {
  const text = () => fs.readFileSync(COPIES['skeleton/.claude'], 'utf-8');

  it('addresses architect:<name>, never bare architect', () => {
    expect(text()).toContain('architect:<name>');
    // The reason must travel with the rule — a sibling architect clearing
    // main's terminal is the worst outcome this skill can produce.
    expect(text()).toMatch(/never bare `architect`/);
  });

  it('uses --raw and explains why not the escape channel', () => {
    expect(text()).toContain("--raw '/clear'");
    expect(text()).toMatch(/escape route writes a bare ESC and discards the/);
  });

  it('states why the state write must precede the clear', () => {
    expect(text()).toMatch(/context that knows what to write is the one about to be destroyed/);
  });

  it('requires pruning, not just appending', () => {
    expect(text()).toMatch(/save that only appends has not done its job/);
    expect(text()).toMatch(/Prune by pointer, never by deletion/);
  });

  it('carries the owner-direction rule with an override carve-out', () => {
    expect(text()).toMatch(/Do not invoke this\s+autonomously mid-task/);
    expect(text()).toMatch(/If the owner tells\s+you to run it, run it/);
  });

  it('documents the manual re-send recovery', () => {
    expect(text()).toContain("--raw '/arch-init <name>'");
    expect(text()).toMatch(/Nothing is lost/);
  });

  it('does NOT claim Tower waits for the clear to land', () => {
    // Tower waits out a delay; it does not observe the result. An earlier draft
    // said "delivers it after the clear has landed", which promises an
    // observation the system never makes — the exact kind of overclaim that
    // sends a reader looking for a guarantee that is not there.
    expect(text()).not.toMatch(/after the clear has landed/);
    expect(text()).toMatch(/Tower does not know whether the clear landed/);
  });

  it('tells the architect not to end its turn if scheduling the re-init fails', () => {
    // The gap review found: step 4 queues the /clear but it only takes effect
    // when the turn ends, so a step-5 failure is still recoverable — unless the
    // architect ends its turn anyway, which converts it into a cleared session
    // with no re-init scheduled and nobody informed.
    expect(text()).toMatch(/If this send fails, do not end your turn/);
  });

  it('tells the reader what a non-executing /clear looks like', () => {
    expect(text()).toMatch(/literal text on the front of the next message/);
  });

  it('requires a MONITORS line even when nothing is armed', () => {
    expect(text()).toContain('MONITORS:');
    expect(text()).toMatch(/none armed/);
  });

  it('orders the post-clear monitor steps reconcile-then-rearm', () => {
    const body = text();
    expect(body.indexOf('Reconcile monitors')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('Then re-arm')).toBeGreaterThan(body.indexOf('Reconcile monitors'));
  });
});

describe('Spec 1307 — /arch-init no longer documents a competing procedure', () => {
  const archInit = () =>
    fs.readFileSync(
      path.join(repoRoot, 'codev-skeleton', '.claude', 'skills', 'arch-init', 'SKILL.md'),
      'utf-8',
    );

  it('points at /arch-save as the packaged path', () => {
    expect(archInit()).toContain('/arch-save');
  });

  it('keeps the manual path documented as the Tower-unavailable fallback', () => {
    expect(archInit()).toMatch(/fallback when\s+Tower is unavailable/);
  });

  it('shows /arch-save in the refresh loop diagram', () => {
    // The diagram is what a reader skims; leaving it manual-only contradicts
    // the prose two paragraphs below it.
    const loop = archInit().slice(archInit().indexOf('/arch-init (recover)'));
    expect(loop.slice(0, 400)).toContain('/arch-save');
  });
});
