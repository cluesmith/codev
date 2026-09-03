import { describe, it, expect } from 'vitest';
import { formatHoldVerdict, formatHeldAge, formatHeldDuration, isScheduled } from '../src/lib/heldMail.js';

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

describe('formatHoldVerdict (Issue #1482) — the popover must render a row exactly as `afx inbox` does', () => {
  // This is a PORTED copy of `formatVerdict` from
  // packages/codev/src/agent-farm/utils/hold-verdict.ts, not an import: apps/web must not
  // import from codev-core (#1189). These cases therefore mirror hold-verdict.test.ts
  // deliberately — if the two ever disagree, the CLI and the dashboard describe the same
  // held row differently, which is the drift this pair of functions exists to prevent.

  it('joins reason and detail as a `reason:detail` sub-code', () => {
    expect(formatHoldVerdict('busy', 'user-text')).toBe('busy:user-text');
    expect(formatHoldVerdict('busy', 'no-region-end')).toBe('busy:no-region-end');
    expect(formatHoldVerdict('busy', 'no-composer-marker')).toBe('busy:no-composer-marker');
  });

  it('renders the bare reason when there is no detail', () => {
    expect(formatHoldVerdict('no-live-pty', null)).toBe('no-live-pty');
    expect(formatHoldVerdict('busy', undefined)).toBe('busy');
  });

  it('falls back to `held` for a null reason, and honours an explicit fallback', () => {
    expect(formatHoldVerdict(null, null)).toBe('held');
    expect(formatHoldVerdict(undefined, null)).toBe('held');
    expect(formatHoldVerdict(null, null, 'pending')).toBe('pending');
  });

  it('still shows a detail that arrives without a reason, against the fallback', () => {
    // Defensive: the projection should never produce this, but silently dropping the one
    // diagnostic the operator needs would be the wrong failure.
    expect(formatHoldVerdict(null, 'user-text')).toBe('held:user-text');
  });
});
