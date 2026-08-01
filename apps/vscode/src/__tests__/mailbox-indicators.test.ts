/**
 * Spec 1313 Phase 8: pure unit tests for the VSCode held-mail indicator
 * helpers. No `vscode` mock — these are deliberately vscode-free so the
 * count / tooltip / attention / toast-text math is testable in isolation.
 */
import { describe, it, expect } from 'vitest';
import {
  heldStatusSegment,
  heldTooltipClause,
  heldBadgeCount,
  composeStatusBarText,
  composeActivityBadge,
  escalationToastText,
  escalationMatchesWorkspace,
} from '../mailbox-indicators.js';

function makePayload(overrides: Partial<{
  workspacePath: string;
  toAgent: string;
  mailboxId: string;
  ageMs: number;
  reason: string | null;
}> = {}) {
  return {
    workspacePath: '/ws',
    toAgent: 'spir-1',
    mailboxId: 'mb1',
    ageMs: 65_000,
    reason: 'busy' as string | null,
    ...overrides,
  };
}

describe('heldStatusSegment', () => {
  it('is empty when nothing is held', () => {
    expect(heldStatusSegment(0, false)).toBe('');
    expect(heldStatusSegment(0, true)).toBe('');
  });

  it('is empty for a negative or absent count (defensive)', () => {
    expect(heldStatusSegment(-1, false)).toBe('');
    // Simulates an older Tower that omits the field (undefined at runtime).
    expect(heldStatusSegment(undefined as unknown as number, false)).toBe('');
  });

  it('renders a mail-icon segment when held and not escalated', () => {
    expect(heldStatusSegment(2, false)).toBe(' · $(mail) 2 held');
  });

  it('swaps to the warning icon when escalated (the attention state)', () => {
    expect(heldStatusSegment(2, true)).toBe(' · $(warning) 2 held');
  });
});

describe('heldTooltipClause', () => {
  it('is empty when nothing is held', () => {
    expect(heldTooltipClause(0)).toBe('');
    expect(heldTooltipClause(-3)).toBe('');
  });

  it('is singular for one and plural for many', () => {
    expect(heldTooltipClause(1)).toBe('1 held message');
    expect(heldTooltipClause(4)).toBe('4 held messages');
  });
});

describe('heldBadgeCount', () => {
  it('clamps negatives and absent values to 0', () => {
    expect(heldBadgeCount(-1)).toBe(0);
    expect(heldBadgeCount(0)).toBe(0);
    expect(heldBadgeCount(undefined as unknown as number)).toBe(0);
  });

  it('passes a positive count through unchanged', () => {
    expect(heldBadgeCount(5)).toBe(5);
  });
});

describe('composeStatusBarText', () => {
  it('renders the base builder count with no extras when nothing needs attention', () => {
    expect(composeStatusBarText(2, 0, 0, 0, false)).toBe('$(server) Codev: 2 builders');
  });

  it('appends blocked, waiting, and held segments in order', () => {
    expect(composeStatusBarText(3, 1, 2, 4, false)).toBe(
      '$(server) Codev: 3 builders · $(bell) 1 blocked · $(comment-discussion) 2 waiting · $(mail) 4 held',
    );
  });

  it('uses the warning icon for the held segment when escalated', () => {
    expect(composeStatusBarText(1, 0, 0, 2, true)).toBe('$(server) Codev: 1 builders · $(warning) 2 held');
  });

  it('omits the held segment entirely when nothing is held', () => {
    expect(composeStatusBarText(5, 1, 0, 0, true)).toBe('$(server) Codev: 5 builders · $(bell) 1 blocked');
  });
});

describe('composeActivityBadge', () => {
  it('is undefined when nothing needs the user', () => {
    expect(composeActivityBadge(0, 0, 0)).toBeUndefined();
    // A negative/absent held count is clamped, so it cannot fabricate a badge.
    expect(composeActivityBadge(0, 0, -2)).toBeUndefined();
  });

  it('folds held-only into the badge with a held tooltip', () => {
    expect(composeActivityBadge(0, 0, 3)).toEqual({ value: 3, tooltip: '3 held messages' });
  });

  it('preserves the singular/plural blocked-only phrasing', () => {
    expect(composeActivityBadge(1, 0, 0)).toEqual({ value: 1, tooltip: '1 builder blocked at a human-approval gate' });
    expect(composeActivityBadge(2, 0, 0)).toEqual({ value: 2, tooltip: '2 builders blocked at human-approval gates' });
  });

  it('preserves the idle-only phrasing', () => {
    expect(composeActivityBadge(0, 1, 0)).toEqual({ value: 1, tooltip: '1 builder waiting on input' });
  });

  it('combines blocked + idle with the compact phrasing', () => {
    expect(composeActivityBadge(2, 3, 0)).toEqual({ value: 5, tooltip: '2 blocked, 3 waiting on input' });
  });

  it('folds held into blocked + idle and joins the clauses', () => {
    expect(composeActivityBadge(1, 1, 2)).toEqual({
      value: 4,
      tooltip: '1 blocked, 1 waiting on input · 2 held messages',
    });
    expect(composeActivityBadge(2, 0, 1)).toEqual({
      value: 3,
      tooltip: '2 builders blocked at human-approval gates · 1 held message',
    });
  });
});

describe('escalationToastText', () => {
  it('names the recipient, the held duration in seconds, and the why-held reason', () => {
    const text = escalationToastText(makePayload({ toAgent: 'architect:main', ageMs: 62_000, reason: 'busy' }));
    expect(text).toContain('architect:main');
    expect(text).toContain('62s');
    expect(text).toContain('(busy)');
    expect(text).toContain('afx inbox');
  });

  it('omits the reason parens when the reason is null', () => {
    const text = escalationToastText(makePayload({ reason: null }));
    expect(text).not.toContain('(');
  });

  it('rounds sub-second/odd ages and never goes negative', () => {
    expect(escalationToastText(makePayload({ ageMs: 60_500 }))).toContain('61s');
    expect(escalationToastText(makePayload({ ageMs: -10 }))).toContain('0s');
  });

  it('carries no message body (redaction — payload has none to leak)', () => {
    // The payload type has no body field; assert the text is metadata only by
    // confirming it is fully determined by the metadata we passed.
    const text = escalationToastText(makePayload({ toAgent: 'b', ageMs: 60_000, reason: 'no-profile' }));
    expect(text).toBe('Codev: a message to b has been held 60s (no-profile) — past the escalation age. Review with: afx inbox');
  });
});

describe('escalationMatchesWorkspace', () => {
  it('matches an identical path', () => {
    expect(escalationMatchesWorkspace('/ws/a', '/ws/a')).toBe(true);
  });

  it('normalizes trailing slashes and . / .. segments', () => {
    expect(escalationMatchesWorkspace('/ws/a/', '/ws/a')).toBe(true);
    expect(escalationMatchesWorkspace('/ws/a/../a', '/ws/a')).toBe(true);
  });

  it('rejects a different workspace', () => {
    expect(escalationMatchesWorkspace('/ws/a', '/ws/b')).toBe(false);
  });

  it('matches everything when no active workspace is known yet (startup)', () => {
    expect(escalationMatchesWorkspace('/ws/a', null)).toBe(true);
  });
});
