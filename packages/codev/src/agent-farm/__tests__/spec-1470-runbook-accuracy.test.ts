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

  it('carries --boundary on every self-refresh command it prints', () => {
    // The guard this whole feature learned the hard way: a challenge without a
    // boundary can be replayed at a LATER boundary, clearing a builder against
    // a save describing work that has moved on. Two shipped call sites once
    // omitted it. A runbook a human copy-pastes is a third.
    //
    // Scanned in two passes, because one pass cannot do both jobs without
    // either missing the dangerous case or flagging English.

    const text = runbook();

    // Shell line-continuations joined first: the runbook wraps long commands,
    // putting flags on the next line, so a line-based scan would see a bare
    // `self-refresh` and report a missing flag that is right there. Read the
    // command the way a shell does, not the way an editor displays it.
    const joined = text.replace(/\\\n\s*/g, ' ');

    // PASS 1 — fenced code blocks. This is what a human copies, so it is
    // checked WITHOUT an "only if it has arguments" filter: a bare
    // `afx self-refresh` in a copy-paste block is precisely the dangerous
    // case, and skipping it for having no flags would skip the bug.
    const fenced = [...joined.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1]);
    const fencedCommands = fenced
      .flatMap(block => block.split('\n'))
      .filter(line => /self-refresh/.test(line));

    expect(fencedCommands.length, 'no self-refresh commands in any code block').toBeGreaterThan(0);

    const badFenced = fencedCommands.filter(
      l => !l.includes('--boundary') && !l.includes('--dry-run'),
    );
    expect(badFenced, `code-block commands without --boundary:\n${badFenced.join('\n')}`).toEqual(
      [],
    );

    // PASS 2 — inline commands in the numbered steps.
    //
    // The discriminator is the `<AFX>` placeholder, NOT the presence of
    // arguments. An earlier version filtered on "has arguments" to exclude
    // prose, and a mutation check found the hole immediately: a bare
    // `<AFX> self-refresh` has no arguments, so the check that exists to catch
    // a missing `--boundary` skipped the one command that was missing
    // everything.
    //
    // `<AFX>` is defined by this runbook for exactly one purpose — a command
    // the architect runs — while prose that merely names the tool writes `afx`.
    // So the placeholder identifies commands by construction, and the check
    // needs no argument heuristic at all.
    // Requires the subcommand, so the line that DEFINES the placeholder is not
    // mistaken for a command. A bare `<AFX> self-refresh` still matches, with
    // empty arguments — which is the case this exists to catch.
    const inline = [...joined.matchAll(/<AFX> self-refresh[^`\n]*/g)].map(m => m[0]);

    expect(inline.length, 'no <AFX> commands found in the numbered steps').toBeGreaterThan(1);

    const badInline = inline.filter(
      l => !l.includes('--boundary') && !l.includes('--dry-run'),
    );
    expect(badInline, `inline commands without --boundary:\n${badInline.join('\n')}`).toEqual([]);
  });

  it('reserves the <AFX> placeholder for commands, never for prose', () => {
    // The convention the check above depends on. If prose starts using <AFX>,
    // the discriminator degrades silently into flagging English — so the
    // convention is asserted rather than assumed.
    const proseUses = runbook()
      .split('\n')
      .filter(l => l.includes('<AFX>') && !l.includes('self-refresh'))
      // The line that DEFINES the placeholder necessarily mentions it.
      .filter(l => !l.includes('means'));
    expect(proseUses, `<AFX> used outside a command:\n${proseUses.join('\n')}`).toEqual([]);
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
