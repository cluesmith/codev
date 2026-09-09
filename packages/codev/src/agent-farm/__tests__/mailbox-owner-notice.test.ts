/**
 * Issue #1482 — the owner starvation notice's REMEDY text.
 *
 * This notice is operator-facing instructions delivered during what reads as an incident
 * ("Mailbox delivery is STUCK for builder ..."). Operators follow the remedy line literally.
 *
 * It shipped suggesting `afx interrupt` for a `user-text` hold — a hold that by definition
 * means a human is typing at that composer — and the #1583 loop this week was aggravated by an
 * operator doing exactly what the notice said. That is why these assertions exist: the safe
 * branch must name NO command that touches the terminal, hedged or otherwise, and the
 * assertion has to be on the rendered STRING rather than on the branch being taken, because
 * the defect was in the prose, not the control flow.
 */

import { describe, it, expect } from 'vitest';
import { formatOwnerNoticeBody } from '../servers/mailbox-wiring.js';
import type { HeldOwnerNoticeInfo } from '../servers/mailbox-delivery.js';

const notice = (over: Partial<HeldOwnerNoticeInfo> = {}): HeldOwnerNoticeInfo => ({
  workspacePath: '/ws/codev',
  toAgent: 'pir-1482',
  reason: 'busy',
  detail: 'user-text',
  ageMs: 7 * 60_000,
  heldCount: 1,
  streak: 41,
  ...over,
});

describe('Issue #1482 — owner starvation notice: the user-text branch never suggests interrupting', () => {
  it('does NOT contain the string "afx interrupt"', () => {
    expect(formatOwnerNoticeBody(notice())).not.toContain('afx interrupt');
  });

  it('does not name interrupt in ANY form, hedged or bare', () => {
    // Broader than the literal command: a rewording that reintroduces the advice as
    // "you can interrupt them" would pass a bare string check and cause the same harm.
    const body = formatOwnerNoticeBody(notice());
    expect(body.toLowerCase()).not.toContain('interrupt');
  });

  it.each([1, 2, 41])('stays clean at any streak (%i) — the text must not vary into advice', (streak) => {
    expect(formatOwnerNoticeBody(notice({ streak }))).not.toContain('interrupt');
  });

  it.each([1, 5])('stays clean for any held count (%i)', (heldCount) => {
    expect(formatOwnerNoticeBody(notice({ heldCount }))).not.toContain('interrupt');
  });

  it('still offers the read-only inspection surface, so the operator is not left with nothing', () => {
    expect(formatOwnerNoticeBody(notice())).toContain('afx inbox');
  });

  it('says the hold clears itself — the reason no action is warranted', () => {
    const body = formatOwnerNoticeBody(notice());
    expect(body).toContain('OCCUPIED');
    expect(body).toMatch(/clears by itself|resumes by itself|let it clear/i);
  });

  it('still reports the compound verdict and the streak', () => {
    const body = formatOwnerNoticeBody(notice());
    expect(body).toContain('busy:user-text');
    expect(body).toContain('re-confirmed across 41 consecutive gate checks');
  });
});

describe('Issues #1473/#1664 — the OTHER self-clearing holds get safe guidance too', () => {
  // CMAP round 3 (codex). The branch test was `if (info.detail || …)`, so EVERY detail except
  // `user-text` landed in the defect arm — "the render gate CANNOT VERIFY that composer", "the
  // mail will never deliver on its own", "afx interrupt <agent>". That is a false statement and
  // a destructive instruction for both self-clearing details: `recent-input` means a person is
  // typing (so the interrupt wipes their line — already wrong before this issue), and
  // `composer-redraw` means the agent is working (so it kills their turn).
  //
  // The routing now asks `isUnverifiableVerdict`, the same predicate every other surface uses,
  // so a detail added later cannot silently fall into the destructive arm by default.

  it.each(['recent-input', 'composer-redraw'] as const)(
    'never suggests interrupting for detail=%s',
    (detail) => {
      const body = formatOwnerNoticeBody(notice({ detail }));
      expect(body.toLowerCase()).not.toContain('afx interrupt');
    },
  );

  it.each(['recent-input', 'composer-redraw'] as const)(
    'does not claim the mail will never deliver for detail=%s',
    (detail) => {
      const body = formatOwnerNoticeBody(notice({ detail }));
      expect(body).not.toContain('CANNOT VERIFY');
      expect(body).not.toContain('never deliver');
      expect(body).toMatch(/clears by itself|resumes on its own/i);
    },
  );

  it('names the actual cause rather than the draft wording, which would be wrong here', () => {
    expect(formatOwnerNoticeBody(notice({ detail: 'recent-input' }))).toContain('RECEIVING INPUT');
    expect(formatOwnerNoticeBody(notice({ detail: 'composer-redraw' }))).toContain('REPAINTED');
  });

  it('still offers the read-only inspection surface', () => {
    for (const detail of ['recent-input', 'composer-redraw'] as const) {
      expect(formatOwnerNoticeBody(notice({ detail }))).toContain('afx inbox');
    }
  });

  it('still reports the compound verdict', () => {
    expect(formatOwnerNoticeBody(notice({ detail: 'composer-redraw' }))).toContain('busy:composer-redraw');
  });
});

describe('Issue #1482 — owner starvation notice: the DEFECT branches still do suggest it', () => {
  // The counterpart assertion. Removing the suggestion everywhere would be the opposite
  // failure: for these verdicts nothing clears the hold on its own, and there is no human at
  // the line to protect — withholding the remedy would strand the mail indefinitely.

  it.each(['no-region-end', 'no-composer-marker'] as const)(
    'offers afx interrupt for detail=%s, where the classifier cannot verify the composer',
    (detail) => {
      const body = formatOwnerNoticeBody(notice({ detail }));
      expect(body).toContain(`afx interrupt pir-1482`);
      expect(body).toContain('CANNOT VERIFY');
    },
  );

  it('offers it for no-profile, which is also unverifiable', () => {
    expect(formatOwnerNoticeBody(notice({ reason: 'no-profile', detail: null })))
      .toContain('afx interrupt pir-1482');
  });

  it('offers it on the bare fallback (a reason with no detail at all)', () => {
    expect(formatOwnerNoticeBody(notice({ reason: 'busy', detail: null })))
      .toContain('afx interrupt pir-1482');
  });

  it('the fallback is unreachable for user-text — detail is truthy, so it takes the safe branch', () => {
    // Guards the branch ORDER: if the `detail === user-text` check were ever moved below the
    // `if (info.detail || ...)` check, user-text would silently fall into the defect branch and
    // start advising interruption again.
    const body = formatOwnerNoticeBody(notice({ detail: 'user-text' }));
    expect(body).not.toContain('CANNOT VERIFY');
    expect(body).not.toContain('interrupt');
  });
});
