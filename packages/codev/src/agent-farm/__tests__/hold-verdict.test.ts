/**
 * Issue #1482 — the hold-verdict formatter and the "will this clear by itself?" predicate.
 *
 * These two pure functions are the diagnostic core of this slice. `formatVerdict` renders the
 * `afx inbox` compound cell, the `afx send` held line, the cron held log and the escalation
 * logs; `isUnverifiableVerdict` decides whether an operator is TOLD their mail is permanently
 * stuck. A regression in either silently un-does the point of the whole issue — the surfaces
 * would go back to saying `busy` for two situations with opposite remedies, and nobody would
 * notice, because everything would still "work".
 *
 * Deliberately exhaustive over the value set rather than sampling it: the set is tiny and
 * closed, and the cost of a missed case is an operator acting on the wrong diagnosis.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatVerdict, isUnverifiableVerdict } from '../utils/hold-verdict.js';

describe('formatVerdict (Issue #1482)', () => {
  it('joins reason and detail as a sub-code when a detail is present', () => {
    expect(formatVerdict('busy', 'user-text')).toBe('busy:user-text');
    expect(formatVerdict('busy', 'no-region-end')).toBe('busy:no-region-end');
    expect(formatVerdict('busy', 'no-composer-marker')).toBe('busy:no-composer-marker');
  });

  it('renders the bare reason when there is no detail', () => {
    // Every non-gate hold. The sub-code must not appear as a dangling colon.
    expect(formatVerdict('no-live-pty', null)).toBe('no-live-pty');
    expect(formatVerdict('no-profile', null)).toBe('no-profile');
    expect(formatVerdict('busy', null)).toBe('busy');
    expect(formatVerdict('busy', undefined)).toBe('busy');
  });

  it('falls back when the reason is missing — default and the CLI override', () => {
    // `afx inbox` renders a reason-less row as `held`; `afx send` calls it `pending`, because
    // at the moment of the response the row's verdict may not have been written yet. Both
    // spellings are load-bearing user-facing text.
    expect(formatVerdict(null, null)).toBe('held');
    expect(formatVerdict(undefined, undefined)).toBe('held');
    expect(formatVerdict(null, null, 'pending')).toBe('pending');
    expect(formatVerdict(undefined, undefined, 'pending')).toBe('pending');
  });

  it('still shows a detail that arrived without a reason', () => {
    // Not expected in practice (the delivery pass writes the pair together), but silently
    // dropping the more specific half would be the wrong way to handle a surprise.
    expect(formatVerdict(null, 'user-text')).toBe('held:user-text');
    expect(formatVerdict(null, 'no-region-end', 'pending')).toBe('pending:no-region-end');
  });

  it('treats an empty-string detail as absent', () => {
    expect(formatVerdict('busy', '')).toBe('busy');
  });
});

describe('isUnverifiableVerdict (Issue #1482)', () => {
  it('is TRUE for the defect class — the gate could not verify the composer', () => {
    // These never clear on their own. An operator must be told.
    expect(isUnverifiableVerdict('no-profile', null)).toBe(true);
    expect(isUnverifiableVerdict('busy', 'no-region-end')).toBe(true);
    expect(isUnverifiableVerdict('busy', 'no-composer-marker')).toBe(true);
  });

  it('is FALSE for a human at the line', () => {
    // The safe, intended hold: it clears when they finish typing. Warning about this one
    // would train operators to ignore the warning that matters.
    expect(isUnverifiableVerdict('busy', 'user-text')).toBe(false);
  });

  it('is FALSE for a hold with no session and for an unset verdict', () => {
    expect(isUnverifiableVerdict('no-live-pty', null)).toBe(false);
    expect(isUnverifiableVerdict('busy', null)).toBe(false);
    expect(isUnverifiableVerdict(null, null)).toBe(false);
    expect(isUnverifiableVerdict(undefined, undefined)).toBe(false);
  });

  it('keys off the detail regardless of the reason it arrives with', () => {
    // The reason is `busy` for every gate hold, so the detail is the whole signal.
    expect(isUnverifiableVerdict('busy', 'no-region-end')).toBe(true);
    expect(isUnverifiableVerdict('busy', 'user-text')).toBe(false);
  });
});
