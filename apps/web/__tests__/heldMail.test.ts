import { describe, it, expect } from 'vitest';
import { formatHeldAge, formatHeldDuration, isScheduled } from '../src/lib/heldMail.js';

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
