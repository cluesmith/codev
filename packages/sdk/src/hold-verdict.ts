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
 * True for the defect class — `no-profile` (the app is unrecognized) and the can't-verify
 * details — and false for `user-text` (a human at the line) and for `no-live-pty` (no session
 * at all). This is the "will it clear on its own?" question, and the answer decides which
 * remedy an operator should reach for.
 *
 * Issue #1201 added two details, both for kimi's boxed composer:
 *
 *   - `no-region-start` is the exact mirror of `no-region-end` — a composer whose box TOP is
 *     not on screen has no proven upper bound, so it is a torn frame or a drifted profile.
 *     Unverifiable for the same reason, with the same remedy.
 *
 *   - `multi-row-draft` is the contested one, and it is TRUE deliberately. Every other detail
 *     is a cell COUNT; this is the one verdict the classifier reaches when it could not count
 *     (a draft of a newline then `>` has zero countable cells — all whitespace, box chrome, or
 *     an exempted marker) and had to infer from box GEOMETRY instead. "The classifier could not
 *     verify this" is therefore the truthful rendering, and a sustained streak of it is exactly
 *     the drift signal that the measured box-growth premise has failed on a newer kimi.
 *     Accepted cost, stated so nobody rediscovers it as a bug: a human genuinely sitting on a
 *     multi-line kimi draft contributes to a liveness streak. `surfaceLiveness` only alarms on
 *     recent output, which suppresses most of that — and, symmetrically, part of the drift case
 *     too, which is why a `codev doctor` premise probe for box growth is tracked separately.
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
  return (
    reason === 'no-profile' ||
    detail === 'no-region-end' ||
    detail === 'no-region-start' ||
    detail === 'no-composer-marker' ||
    detail === 'multi-row-draft'
  );
}
