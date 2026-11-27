import { describe, it, expect } from 'vitest';
import type { HeldMessage } from '@cluesmith/codev-types';
import {
  formatHeldAge,
  formatHeldDuration,
  groupHeldMail,
  heldSenderOf,
  isHeldForRelease,
  isScheduled,
  peerPauseText,
} from '../src/lib/heldMail.js';

describe('formatHeldDuration', () => {
  it('renders sub-minute deltas in seconds', () => {
    expect(formatHeldDuration(0)).toBe('0s');
    expect(formatHeldDuration(5_000)).toBe('5s');
    expect(formatHeldDuration(59_000)).toBe('59s');
  });

  it('rolls over to minutes at 60s', () => {
    expect(formatHeldDuration(60_000)).toBe('1m');
    expect(formatHeldDuration(59 * 60_000)).toBe('59m');
  });

  it('rolls over to hours at 60m', () => {
    expect(formatHeldDuration(60 * 60_000)).toBe('1h');
    expect(formatHeldDuration(23 * 60 * 60_000)).toBe('23h');
  });

  it('rolls over to days at 24h', () => {
    expect(formatHeldDuration(24 * 60 * 60_000)).toBe('1d');
    expect(formatHeldDuration(3 * 24 * 60 * 60_000)).toBe('3d');
  });

  it('clamps a negative delta to 0s rather than rendering "-1s"', () => {
    // Clock skew between the server's createdAt and the browser's Date.now() is real;
    // a negative age must not leak into the UI.
    expect(formatHeldDuration(-5_000)).toBe('0s');
  });
});

describe('formatHeldAge', () => {
  it('is the delta between now and createdAt', () => {
    expect(formatHeldAge(1_000_000, 1_000_000 + 90_000)).toBe('1m');
  });
});

describe('isScheduled', () => {
  const now = 1_000_000;

  it('is false for a deliver-ASAP row (null notBefore)', () => {
    expect(isScheduled(null, now)).toBe(false);
  });

  it('is false for a row whose due time has passed', () => {
    expect(isScheduled(now - 1, now)).toBe(false);
  });

  it('is false exactly at the due time (matches the SQL boundary not_before <= now)', () => {
    // The count query uses `not_before <= now`, so a row due exactly now IS eligible and
    // IS counted. This predicate must agree, or the Held group would drift from the badge.
    expect(isScheduled(now, now)).toBe(false);
  });

  it('is true for a pre-due row', () => {
    expect(isScheduled(now + 15_000, now)).toBe(true);
  });
});

// ------------------------------------------------------------------ Spec 1967: three kinds

function held(over: Partial<HeldMessage> = {}): HeldMessage {
  return {
    id: 'row',
    workspacePath: '/ws',
    toAgent: 'architect:main',
    fromAgent: 'architect',
    reason: 'busy',
    detail: null,
    escalated: false,
    createdAt: 1_000_000,
    notBefore: null,
    ...over,
  };
}

describe('isHeldForRelease', () => {
  it('is true only for the held-for-release reason', () => {
    expect(isHeldForRelease({ reason: 'held-for-release' })).toBe(true);
    expect(isHeldForRelease({ reason: 'busy' })).toBe(false);
    expect(isHeldForRelease({ reason: null })).toBe(false);
  });
});

describe('groupHeldMail', () => {
  const now = 1_000_000;

  it('puts each row in exactly one group: held for release, else scheduled, else held', () => {
    const rows = [
      held({ id: 'local' }),
      held({ id: 'later', notBefore: now + 15_000 }),
      held({ id: 'remote', reason: 'held-for-release', fromAgent: null, remoteSender: 'afx://devvm/codev:architect:main' }),
      held({ id: 'released', reason: 'busy', fromAgent: null, remoteSender: 'afx://devvm/codev:architect:main' }),
    ];
    const groups = groupHeldMail(rows, now);
    expect(groups.held.map((m) => m.id)).toEqual(['local', 'released']);
    expect(groups.scheduled.map((m) => m.id)).toEqual(['later']);
    expect(groups.forRelease.map((m) => m.id)).toEqual(['remote']);
    expect(groups.held.length + groups.scheduled.length + groups.forRelease.length).toBe(rows.length);
  });

  it('decides held for release before scheduled: such a row waits for a human whatever its due time', () => {
    const groups = groupHeldMail([held({ id: 'r', reason: 'held-for-release', notBefore: now + 60_000 })], now);
    expect(groups.forRelease.map((m) => m.id)).toEqual(['r']);
    expect(groups.scheduled).toEqual([]);
  });

  it('keeps the order rows were listed in, within each group', () => {
    const groups = groupHeldMail([held({ id: 'a' }), held({ id: 'b', reason: 'held-for-release' }), held({ id: 'c' })], now);
    expect(groups.held.map((m) => m.id)).toEqual(['a', 'c']);
  });
});

describe('heldSenderOf', () => {
  it("names mail from another Tower by its sender's full address, as its header does", () => {
    expect(heldSenderOf({ fromAgent: null, remoteSender: 'afx://devvm/codev:architect:main' })).toBe('afx://devvm/codev:architect:main');
  });

  it('names local mail by its agent, and a row with neither as "?" (matching afx inbox)', () => {
    expect(heldSenderOf({ fromAgent: 'architect', remoteSender: null })).toBe('architect');
    expect(heldSenderOf({ fromAgent: null })).toBe('?');
  });
});

describe('peerPauseText', () => {
  it('says why no mail for another Tower leaves now, for each pause', () => {
    expect(peerPauseText('remote-off')).toContain('remote messaging is off');
    expect(peerPauseText('not-connected')).toContain('not connected to Codev Cloud');
    expect(peerPauseText('not-registered')).toContain('registration was removed');
    expect(peerPauseText('no-relay')).toContain('no relay');
  });
});
