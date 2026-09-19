/**
 * AIR #1709 — `/arch-save <next task>` → `/arch-init` picks it up.
 *
 * `/arch-save` gains a free-text next task that survives the clear in the state
 * file's banner, and `/arch-init` starts on it as the first action of the
 * resumed session. Both halves are documents, so the shipped SKILL.md text is
 * the testable artifact: these assertions pin the statements the feature is
 * made of, and the four-copy parity that keeps adopters from getting a stale
 * half of the pair.
 *
 * The parity guard is repeated here for `/arch-init` deliberately —
 * `spec-1134-arch-init-skill.test.ts` compares only instance/.claude against
 * skeleton/.claude, so a `.codex` copy left behind passes it silently. The
 * `/arch-save` half of that check duplicates `spec-1307-arch-save-skill.test.ts`
 * and is kept only so the two skills of one feature fail together.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');

const copies = (skill: string) => ({
  'instance/.claude': path.join(repoRoot, '.claude', 'skills', skill, 'SKILL.md'),
  'instance/.codex': path.join(repoRoot, '.codex', 'skills', skill, 'SKILL.md'),
  'skeleton/.claude': path.join(repoRoot, 'codev-skeleton', '.claude', 'skills', skill, 'SKILL.md'),
  'skeleton/.codex': path.join(repoRoot, 'codev-skeleton', '.codex', 'skills', skill, 'SKILL.md'),
});

const ARCH_SAVE = copies('arch-save');
const ARCH_INIT = copies('arch-init');

const save = () => fs.readFileSync(ARCH_SAVE['skeleton/.claude'], 'utf-8');
const init = () => fs.readFileSync(ARCH_INIT['skeleton/.claude'], 'utf-8');

describe('AIR 1709 — both skills stay byte-identical across all four copies', () => {
  it.each([
    ['arch-save', ARCH_SAVE],
    ['arch-init', ARCH_INIT],
  ] as const)('%s', (_skill, files) => {
    const [first, ...rest] = Object.values(files).map(f => fs.readFileSync(f, 'utf-8'));
    for (const other of rest) {
      expect(other).toBe(first);
    }
  });
});

describe('AIR 1709 — /arch-save accepts a next task', () => {
  it('advertises the next task in the argument hint', () => {
    expect(save()).toMatch(/^argument-hint: .*next task/m);
  });

  it('shows all three invocation forms', () => {
    const t = save();
    expect(t).toMatch(/^\/arch-save\s+save, clear, re-init, then wait$/m);
    expect(t).toMatch(/^\/arch-save file and spawn that issue\s+…/m);
    expect(t).toMatch(/^\/arch-save main file and spawn that issue\s+explicit name/m);
  });

  it('runs afx whoami first, whatever the arguments hold', () => {
    // The split cannot tell a leading name from a leading task word until the
    // name is known, so whoami stops being conditional on empty $ARGUMENTS.
    expect(save()).toMatch(/\*\*Always run `afx whoami` first\*\*, whatever `\$ARGUMENTS` holds/);
  });

  it('keeps the name-resolution guards (builder stop, no defaulting to main, validation)', () => {
    const t = save();
    expect(t).toMatch(/`type: builder` → \*\*STOP\.\*\*/);
    expect(t).toMatch(/do not\s+default to `main`/);
    expect(t).toContain('[a-z][a-z0-9-]*');
    expect(t).toMatch(/at most 64 characters/);
  });

  it('carries the three-rule argument split', () => {
    const t = save();
    expect(t).toMatch(/`\$ARGUMENTS` is empty → name from `afx whoami`, and there is no next task/);
    expect(t).toMatch(/\*\*first whitespace-separated token\*\* equals the whoami name/);
    expect(t).toMatch(/the \*\*remainder\*\* is the next-task text/);
    expect(t).toMatch(/Otherwise → the \*\*whole\*\* of `\$ARGUMENTS` is the next-task text/);
  });

  it('states the back-compat property and documents the one ambiguity', () => {
    const t = save();
    expect(t).toMatch(/`\/arch-save` and `\/arch-save main` behave exactly as they always have/);
    expect(t).toMatch(/a next task whose first word happens to be your own architect name/);
  });

  it('keeps the next task when it has to stop and ask for the name', () => {
    // whoami down + multi-token arguments lands on the STOP branch. The text is
    // already in hand; making the owner retype it defeats the feature.
    expect(save()).toMatch(/If you had to ask which architect you are, the next task still stands/);
  });

  it('stops when the leading token names a different, existing architect', () => {
    // The architect's ruling on the CMAP finding: rule 3 would otherwise bury a
    // real name-override inside next-task text and save to whoami's file, and
    // whoami can be wrong (#1094). The cost is one clarification for a task that
    // merely opens with a sibling's name.
    const t = save();
    expect(t).toMatch(/differs from the name whoami reported, and\s*\n?`codev\/state\/<token>\.md` exists/);
    expect(t).toMatch(/\*\*STOP and ask which architect you are\. Write nothing\.\*\*/);
    expect(t).toMatch(/whoami can be wrong \(#1094\)/);
  });

  it('acknowledges that /arch-init resolves a name by different rules', () => {
    // /arch-init takes no next task, so any argument there is unambiguously a
    // name and overrides whoami outright. Here the first token is weighed
    // *against* whoami — the pair is asymmetric, and the doc says so.
    const t = save();
    expect(t).toMatch(/This is not how `\/arch-init` resolves a name/);
    expect(t).toMatch(/the first token is weighed \*against\* whoami, which is\s+why the guard above exists/);
  });
});

describe('AIR 1709 — /arch-save persists the next task in the banner', () => {
  it('writes the NEXT TASK line into step 3, after the intentional-clear line', () => {
    const t = save();
    expect(t).toMatch(/directly after the `⭐ THIS \/clear IS INTENTIONAL` line/);
    expect(t).toMatch(/# ⏭ NEXT TASK \(owner-directed at save, .+\): /);
  });

  it('requires the owner’s words verbatim', () => {
    const t = save();
    expect(t).toMatch(/\*\*Verbatim\.\*\*/);
    expect(t).toMatch(/Collapse newlines to spaces; do not paraphrase/);
  });

  it('replaces an existing line with new text, and preserves it when there is none', () => {
    const t = save();
    expect(t).toMatch(/\*\*New text replaces\*\* any existing NEXT TASK line/);
    expect(t).toMatch(/\*\*No new text preserves an existing one\.\*\*/);
    // The why must travel with the rule: a surviving line means the previous
    // cycle never resumed, so dropping it loses an owner instruction.
    expect(t).toMatch(/previous cycle never came back to pick it up/);
  });

  it('shows the line in the state-block template, marked optional', () => {
    const template = save().slice(save().indexOf('## State block template'));
    expect(template).toMatch(/# ⏭ NEXT TASK \(owner-directed at save, <ISO timestamp>\): /);
    expect(template).toMatch(/OPTIONAL; present only when the save carried one/);
  });

  it('still writes the state file before the clear', () => {
    // Unchanged ordering property, re-pinned because step 3 grew.
    const t = save();
    expect(t.indexOf('### 3. Write the pruned state file')).toBeLessThan(t.indexOf('### 4. Clear'));
    expect(t).toMatch(/context that knows what to write is the one about to be destroyed/);
  });
});

describe('AIR 1709 — /arch-init picks the next task up', () => {
  it('reports it in the orient block under a fixed label', () => {
    expect(init()).toContain('Next task from the owner at save time: <text>');
  });

  it('starts on it first, ahead of the general resume agenda', () => {
    const t = init();
    expect(t).toMatch(/\*\*first\s+action of the resumed session\*\*, ahead of the general resume agenda/);
    expect(t).toMatch(/Begin it without waiting for a further prompt/);
  });

  it('orders orient → next task → follow the state file', () => {
    const t = init();
    const orient = t.indexOf('**Confirm identity + orient.**');
    const nextTask = t.indexOf('**Start on the next task, if the banner carries one.**');
    const followState = t.indexOf('**Then follow the state file.**');
    expect(orient).toBeGreaterThanOrEqual(0);
    expect(nextTask).toBeGreaterThan(orient);
    expect(followState).toBeGreaterThan(nextTask);
  });

  it('is not a pre-spent approval for gates, merges, releases or Tower restarts', () => {
    const t = init();
    expect(t).toMatch(/never by itself approves a\s+porch gate, merges a PR, cuts a release, restarts Tower/);
    expect(t).toMatch(/prepare it and ask for the word live/);
    expect(t).toMatch(/a saved instruction is an\s+instruction, not a pre-spent approval/);
  });

  it('deletes the line and logs the pickup so it cannot run twice', () => {
    const t = init();
    expect(t).toMatch(/\*\*Once you have started, delete the `NEXT TASK` line from the banner\*\*/);
    expect(t).toContain('picked up next task: <text>');
    expect(t).toMatch(/A second re-init, or the next `\/arch-save`, must not re-run it/);
  });

  it('tells the save-side section that /arch-save can carry one', () => {
    // The "Saving your state" section describes the cycle too; leaving it
    // silent about the next task contradicts step 4 above it.
    const t = init();
    const section = t.slice(t.indexOf('## Saving your state'));
    expect(section).toMatch(/accepts a \*\*next task\*\* as free text/);
  });
});
