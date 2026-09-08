/**
 * Every `GateVerdict['detail']` is classified by `isUnverifiableVerdict` (Issue #1620).
 *
 * WHY THIS FILE EXISTS. Issue #1201 originally shipped its own copy of the escalation rule — a
 * `Record<GateVerdict['detail'], boolean>` in `mailbox-delivery.ts` — for one good reason: a
 * `Record` keyed on the union is a COMPILE error when the union grows, so a new detail cannot
 * slip in unclassified. But #1482 had meanwhile made `isUnverifiableVerdict` the single
 * definition of "will this hold clear on its own?", shared by the escalation policy, `afx
 * inbox`, `afx send`, the dashboard and the VS Code toast — and two copies of that rule are one
 * edit away from an escalation policy and an operator-facing remedy disagreeing about the same
 * row.
 *
 * So the copy was deleted and the property it bought is split in two. The compile-time half is a
 * type-level tripwire in `mailbox-delivery.ts` — in SOURCE, because this package's tsconfig
 * excludes the `__tests__` glob and vitest transpiles without typechecking, so the `satisfies`
 * below is checked by NOTHING and enforces NOTHING on its own. It is kept purely as documentation
 * of intent next to the values it annotates; do not mistake it for the guard. The runtime half —
 * the actual answers — is this file.
 *
 * (An earlier draft of this header claimed the `satisfies` "fails to compile if the union and the
 * list disagree". It does not, for exactly the reason above. Left recorded rather than quietly
 * corrected, because a comment that overstates a guard is worse than no comment: it stops the
 * next person from looking for a real one.)
 */
import { describe, it, expect } from 'vitest';
import { isUnverifiableVerdict } from '@cluesmith/codev-sdk/hold-verdict';
import type { GateVerdict } from '../servers/render-gate.js';
import type { MailboxGateDetail } from '../db/types.js';

/**
 * Every detail the classifier can return, and whether a hold carrying it can clear on its own.
 *
 * The `satisfies` is documentation, not enforcement (see the file header — tests are excluded
 * from `tsc` here). The enforcement lives in `mailbox-delivery.ts`; what this table provides is
 * the ANSWERS, asserted at runtime below.
 */
const EXPECTED = {
  // Unverifiable — a drifted profile or a torn frame. Never clears on its own; escalates.
  'no-composer-marker': true,
  'no-region-end': true,
  'no-region-start': true,
  // Held on SHAPE because the cells were uncountable — the classifier did not verify anything
  // here, it inferred from box geometry. See the reasoning on `isUnverifiableVerdict`.
  'multi-row-draft': true,
  // A human is at the line. Clears when they send or clear the draft.
  'user-text': false,
  // Clean; never a hold at all.
  empty: false,
} satisfies Record<GateVerdict['detail'], boolean>;

describe('isUnverifiableVerdict covers every gate detail (Issue #1620)', () => {
  it.each(Object.entries(EXPECTED))('classifies %s', (detail, unverifiable) => {
    expect(isUnverifiableVerdict('busy', detail)).toBe(unverifiable);
  });

  it('treats no-profile as unverifiable regardless of detail', () => {
    // The app was never recognized, so there is no composer to have a verdict about.
    expect(isUnverifiableVerdict('no-profile', null)).toBe(true);
    expect(isUnverifiableVerdict('no-profile', 'user-text')).toBe(true);
  });

  it('does not escalate no-live-pty — there is no session, not a broken one', () => {
    expect(isUnverifiableVerdict('no-live-pty', null)).toBe(false);
  });

  it('is total on values it has never seen', () => {
    // It reads these out of JSON, so a row written by a newer Tower can carry anything. An
    // unknown value must read as "not a known defect" rather than throw on an operator surface.
    expect(isUnverifiableVerdict('busy', 'some-future-detail')).toBe(false);
    expect(isUnverifiableVerdict(null, null)).toBe(false);
    expect(isUnverifiableVerdict(undefined, undefined)).toBe(false);
  });

  it('every DB-persistable detail is one the predicate knows about', () => {
    // `MailboxGateDetail` is what the mailbox column stores and `GateVerdict['detail']` is what
    // the classifier produces. They are declared separately, in different modules, and a detail
    // that exists in one but not the other is the exact divergence #1482 was filed for: the
    // classifier would emit a value the column's type forbids and the operator surfaces would
    // describe it wrongly. Assert the persistable set is covered by the table above.
    const persistable: MailboxGateDetail[] = [
      'user-text',
      'no-region-end',
      'no-region-start',
      'no-composer-marker',
      'multi-row-draft',
    ];
    for (const detail of persistable) {
      expect(Object.keys(EXPECTED)).toContain(detail);
    }
  });
});
