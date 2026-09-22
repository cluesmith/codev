/**
 * AIR #1724 — the `/arch-save` next task gains a `[resolved at save: …]` gloss.
 *
 * #1709 persisted the owner's words verbatim, which stops the saving session
 * from rewriting intent but also from resolving what the words *refer to*:
 * after the clear, "merge them all" points at nothing. The saving session now
 * pins referents to durable identifiers on the same banner line, and
 * `/arch-init` treats the items the gloss names as approved for the act the
 * owner's words name — and only those items, and only that act.
 *
 * As with #1709, both halves are documents; these assertions pin the
 * statements the feature is made of. Eight-copy parity is covered by
 * `air-1709-next-task.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const skill = (name: string) =>
  fs.readFileSync(path.join(repoRoot, 'codev-skeleton', '.claude', 'skills', name, 'SKILL.md'), 'utf-8');

const save = () => skill('arch-save');
const init = () => skill('arch-init');

describe('AIR 1724 — /arch-save resolves referents into a gloss', () => {
  it('appends the gloss to the NEXT TASK line, after the verbatim text', () => {
    expect(save()).toContain(
      '# ⏭ NEXT TASK (owner-directed at save, 2026-09-22T13:40Z): merge them all  [resolved at save: PRs #1710, #1712, #1715]',
    );
  });

  it('keeps the owner’s words verbatim alongside the gloss', () => {
    const t = save();
    expect(t).toMatch(/\*\*Verbatim\.\*\*/);
    expect(t).toMatch(/after the verbatim text, as a `\[resolved at save: …\]` gloss/);
  });

  it('resolves every referent to a durable identifier', () => {
    const t = save();
    expect(t).toMatch(/\*\*Every referent\.\*\* Pronouns and deictics/);
    expect(t).toMatch(/PR numbers, issue numbers, builder ids, branch names, file paths/);
  });

  it('resolves, never plans', () => {
    const t = save();
    expect(t).toMatch(/\*\*Resolution only\.\*\* The gloss names \*what\*, never \*how\*/);
    expect(t).toMatch(/no steps, no ordering, no\s+caveats, no "after CI is green"/);
    expect(t).toMatch(/A gloss that contains a plan has overstepped; the\s+resumed session plans/);
  });

  it('writes no gloss when there are no referents', () => {
    const t = save();
    expect(t).toMatch(/\*\*No referents → no gloss\.\*\* `\/arch-save review PR #1712` needs nothing/);
    expect(t).toMatch(/Never add an empty or redundant gloss/);
  });

  it('stops before the clear when a referent cannot be resolved', () => {
    const t = save();
    expect(t).toMatch(/\*\*Cannot resolve → do not clear\.\*\*/);
    expect(t).toMatch(/\*\*stop before step 4\*\* and ask the owner which items are meant/);
    expect(t).toMatch(/destroys the only context that could have answered/);
    // A paused save must not look finished: monitors are already down, and the
    // cycle resumes from the gloss, not from the top.
    expect(t).toMatch(/Tell the owner your monitors are already stopped \(step 2\)/);
    expect(t).toMatch(/resume from here: write the gloss, then continue to step 4/);
    // The resolution lives in step 3, so the stop precedes the clear by position too.
    expect(t.indexOf('**Cannot resolve → do not clear.**')).toBeLessThan(t.indexOf('### 4. Clear'));
    expect(t.indexOf('**Cannot resolve → do not clear.**')).toBeGreaterThan(
      t.indexOf('### 3. Write the pruned state file'),
    );
  });

  it('shows the optional gloss suffix in the state-block template', () => {
    const template = save().slice(save().indexOf('## State block template'));
    expect(template).toMatch(
      /# ⏭ NEXT TASK \(owner-directed at save, <ISO timestamp>\): <the owner's words, verbatim>  \[resolved at save: <referents>\]/,
    );
    expect(template).toMatch(/gloss\s*\n#\s+is optional too: present only when the words had referents to resolve/);
  });
});

describe('AIR 1724 — /arch-init: the gloss carries the word', () => {
  it('reports verbatim + gloss in the orient block', () => {
    const t = init();
    expect(t).toContain('`Next task from the owner at save time: <verbatim>  → resolved: <gloss>`');
    expect(t).toMatch(/omit `→ resolved: …` when the line carries no `\[resolved at save: …\]` gloss/);
  });

  it('approves the named items for the act the owner’s words name', () => {
    const t = init();
    expect(t).toMatch(/\*\*The gloss carries the word — for the items it names, and only them\.\*\*/);
    expect(t).toMatch(/means merge #1710 and #1712 without asking again/);
  });

  it('narrows the #1709 rule rather than removing it', () => {
    const t = init();
    // The #1709 limit still stands, and the gloss rule sits after it.
    expect(t).toMatch(/a saved instruction is an\s+instruction, not a pre-spent approval/);
    expect(t).toMatch(/This narrows the rule above; it does not remove it/);
    expect(t).toMatch(/a line with no\s+gloss pre-approves nothing/);
    expect(t.indexOf('not a pre-spent approval')).toBeLessThan(t.indexOf('**The gloss carries the word'));
  });

  it('never widens the verb', () => {
    expect(init()).toMatch(/\*\*A gloss never widens\s+the verb\*\* — "merge" does not also approve a release/);
  });

  it('still requires the word live for anything not in the gloss', () => {
    const t = init();
    expect(t).toMatch(/\*\*Anything not in the gloss still needs the word live\.\*\*/);
    expect(t).toMatch(/A PR that\s+appeared after the save, an item the gloss did not name, a gate the\s+words did not mention → prepare and ask/);
  });

  it('relays porch gates rather than running them', () => {
    const t = init();
    expect(t).toMatch(/Porch gates are still relayed to the builder, never run by you/);
    expect(t).toMatch(/does not\s+change who runs `porch approve`/);
  });

  it('keeps ordinary verification: green CI, report changed items rather than force', () => {
    const t = init();
    expect(t).toMatch(/an approved merge still waits for\s+green CI/);
    expect(t).toMatch(/already merged, closed, or changed\s+is reported, not forced/);
  });

  it('logs the pickup with verbatim + gloss, omitting the gloss half when there is none', () => {
    const t = init();
    expect(t).toMatch(/`picked up next task: <verbatim>\s+→ resolved: <gloss>`, omitting `→ resolved: …` when there was no gloss/);
  });
});
