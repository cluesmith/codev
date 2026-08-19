/**
 * Spec 1470, Phase 8 — the runbook's facts must match the code.
 *
 * ## Why this test exists
 *
 * The runbook is executed BY A HUMAN, BY HAND, against a live builder whose
 * context the procedure destroys on purpose. Every other document in this
 * project is read; this one is *run*. A wrong path in it does not produce a red
 * test — it produces an architect typing a command that does nothing, at a
 * moment when the next step clears a session.
 *
 * That is not hypothetical: the first draft named the challenge file
 * `.builder-challenge.json`. The real constant is `.builder-refresh-challenge`,
 * so the cleanup step would have silently left a stale challenge in place —
 * exactly the state the boundary binding exists to defend against.
 *
 * So the runbook's factual claims are pinned to the constants they describe. If
 * a filename or flag changes, this fails instead of the architect discovering it
 * mid-run.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHALLENGE_FILE_NAME,
  REORIENT_FILE_NAME,
  STATE_FILE_NAME,
} from '../commands/reset/constants.js';

const repoRoot = path.resolve(__dirname, '../../../../../');
const RUNBOOK = 'codev/projects/1470-automatic-builder-context-refr/1470-live-run-runbook.md';

const runbook = (): string => fs.readFileSync(path.join(repoRoot, RUNBOOK), 'utf-8');

/**
 * Markdown wraps prose, so a claim can be split across a line break. Asserting
 * on raw text makes the test fail on re-wrapping rather than on a changed
 * claim — which is a test that punishes editing the document.
 */
const flowed = (): string => runbook().replace(/\s+/g, ' ');

describe('live-run runbook accuracy', () => {
  it('exists — the phase is blocked without it', () => {
    expect(fs.existsSync(path.join(repoRoot, RUNBOOK))).toBe(true);
  });

  it.each([
    ['state file', () => STATE_FILE_NAME],
    ['re-orientation file', () => REORIENT_FILE_NAME],
    ['challenge file', () => CHALLENGE_FILE_NAME],
  ])('names the real %s', (_label, get) => {
    expect(runbook()).toContain(get());
  });

  it('names no plausible-but-wrong filename', () => {
    // The specific near-misses that were actually written, plus the shapes a
    // reasonable person would guess. A generic check cannot catch these,
    // because each is a well-formed filename that simply does not exist.
    for (const wrong of [
      '.builder-challenge.json',
      '.builder-challenge',
      '.refresh-challenge',
      '.builder-save.md',
      '.builder-context.md',
    ]) {
      expect(runbook().includes(wrong), `runbook names a nonexistent file: ${wrong}`).toBe(false);
    }
  });

  it('carries --boundary on every self-refresh invocation it prints', () => {
    // The guard this whole feature learned the hard way: a challenge without a
    // boundary can be replayed at a LATER boundary, clearing a builder against
    // a save describing work that has moved on. Two shipped call sites once
    // omitted it. A runbook a human copy-pastes is a third.
    // Only actual invocations, not prose that mentions the command. The match
    // stops at a backtick, so "run the two `afx self-refresh` steps" yields an
    // empty argument list and is excluded — whereas a real command line keeps
    // its flags. Treating a prose mention as an invocation would force flags
    // into English sentences.
    const invocations = [...runbook().matchAll(/afx self-refresh([^`\n]*)/g)]
      .map(m => m[0])
      .filter(m => m.replace('afx self-refresh', '').trim().length > 0);

    expect(invocations.length, 'runbook prints no self-refresh commands at all').toBeGreaterThan(2);

    const missing = invocations.filter(l => !l.includes('--boundary') && !l.includes('--dry-run'));
    expect(missing, `self-refresh invocations without --boundary:\n${missing.join('\n')}`).toEqual(
      [],
    );
  });

  it('states that both live tests block the phase', () => {
    expect(runbook()).toContain('BLOCKING');
    // The exact commitment made at the plan gate: a red live criterion is not
    // written up and merged past.
    expect(flowed().toLowerCase()).toContain('does not complete by documenting');
  });

  it('warns that the subject builder must be disposable', () => {
    expect(flowed().toLowerCase()).toContain('disposable');
  });

  it('tells the architect the subject porch will not emit refresh tasks', () => {
    // The correction the architect supplied. Without it the runbook would have
    // an architect waiting at a boundary for a task that can never arrive.
    expect(flowed()).toMatch(/will not emit|does not emit|predates this feature/i);
  });
});
