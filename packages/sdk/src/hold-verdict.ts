/**
 * Rendering the mailbox hold verdict — `reason` plus its gate `detail` (Issue #1482).
 *
 * The render gate has always known the difference between a composer that is legitimately
 * OCCUPIED (`user-text` — a human is at the line; the hold is correct and clears when they
 * finish) and a composer it CANNOT VERIFY (`no-region-end` / `no-composer-marker` — a drifted
 * profile, a torn frame, or a mirror rendered at dims the real TUI never adopted; the hold is
 * a defect and never clears on its own). Until #1482 that distinction died in memory, and
 * every operator surface printed a bare `busy` for both — which is exactly why the dimension
 * divergence this issue is named for stayed latent.
 *
 * One formatter, shared by the CLI (`afx inbox`, `afx send`) and the server logs, so those
 * surfaces can never drift into describing the same row two different ways. Deliberately
 * typed on `string | null` rather than the DB unions: the CLI reads these values back out of
 * JSON, where they are plain strings, and a formatter is not the right place to re-assert a
 * constraint the database and `MailboxGateDetail` already carry.
 */

/**
 * `reason:detail` when a gate detail is present, else the bare reason.
 *
 * `busy:user-text`, `busy:no-region-end`, `no-live-pty`. `fallback` (default `'held'`) covers
 * a row with no reason recorded yet.
 */
export function formatVerdict(
  reason: string | null | undefined,
  detail: string | null | undefined,
  fallback = 'held',
): string {
  const base = reason ?? fallback;
  return detail ? `${base}:${detail}` : base;
}

/**
 * Is this verdict one the classifier could not resolve (Issue #1482)?
 *
 * True for the defect class — `no-profile` (the app is unrecognized) and the two
 * can't-verify details — and false for `user-text` (a human at the line) and for
 * `no-live-pty` (no session at all). This is the "will it clear on its own?" question, and
 * the answer decides which remedy an operator should reach for.
 *
 * The delivery module's `isClassifierStuck` DELEGATES to this — it is a thin wrapper typed on
 * the DB/gate unions, kept because it reads naturally beside the escalation policy it serves.
 * This is the single definition of "will this hold clear on its own?", and it must stay that
 * way: an escalation policy and an operator-facing remedy that disagree about the same row is
 * the failure mode the sharing exists to prevent.
 */
export function isUnverifiableVerdict(
  reason: string | null | undefined,
  detail: string | null | undefined,
): boolean {
  return reason === 'no-profile' || detail === 'no-region-end' || detail === 'no-composer-marker';
}
