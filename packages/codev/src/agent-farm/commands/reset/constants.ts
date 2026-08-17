/**
 * Tunable parameters for `afx refresh` (Spec 1273).
 *
 * Every value here is overridable from the CLI. The defaults are grounded in
 * the one verified manual reset (shannon workspace, 2026-07-27), not guessed.
 */

/**
 * Fixed name of the builder's working-state file, at the worktree root.
 *
 * The `.builder-` prefix is load-bearing: `afx cleanup` classifies untracked
 * `.builder-*` files as scaffold rather than dirt, so a worktree carrying one is
 * still considered clean. It is untracked, which is why `porch done`'s
 * staged-file sweep cannot pick it up.
 *
 * The name is deliberately FIXED rather than nonce-suffixed. Freshness is proven
 * by the nonce *inside* the file (R2), so encoding it in the filename would add
 * nothing and would leave a new litter file after every reset.
 */
export const STATE_FILE_NAME = '.builder-state.md';

/** Long-form re-orientation written before the clear (R1). Same prefix rationale. */
export const REORIENT_FILE_NAME = '.builder-reorient.md';

/**
 * Minimum size for a state file to count as substantive.
 *
 * The one verified example ran 203 lines (~8-10KB). A genuine cold-reader save
 * is comfortably over 1KB; a three-line stub is 100-200 bytes. 1000 rejects
 * stubs without false-rejecting a terse but real save.
 */
export const DEFAULT_MIN_BYTES = 1000;

/** Gap between the two observations that must agree for the file to count as stable. */
export const DEFAULT_STABILITY_WINDOW_MS = 2000;

/** How often to stat the state file while waiting for it. */
export const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * How long to wait for the builder to produce the state file.
 *
 * A busy builder may take minutes to reach the request — the manual run was of
 * this order. Expiry aborts WITHOUT clearing (R2).
 */
export const DEFAULT_RECEIPT_TIMEOUT_MS = 300_000;

/**
 * How long the terminal must produce no output before it counts as quiescent.
 *
 * An agent mid-turn emits continuously (spinner frames, streamed tokens), so a
 * true silence of this length reliably indicates the turn ended.
 */
export const DEFAULT_QUIET_WINDOW_MS = 1500;

/** Bounded wait for quiescence before the single ESC escalation (R4). */
export const DEFAULT_QUIESCE_TIMEOUT_MS = 60_000;

/** Bounded wait after the ESC escalation. Shorter — ESC should act immediately. */
export const DEFAULT_QUIESCE_POST_ESCALATION_TIMEOUT_MS = 30_000;
