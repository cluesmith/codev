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
 *
 * Spec 1470 RETAINED this value for the automatic boundary path, deliberately
 * rather than by inheritance. The calibration mismatch is real — 1000 was tuned
 * on a MID-PHASE save, and a boundary save is smaller by design — but the
 * floor's job is to reject a stub, and a genuine boundary save (receipts with
 * commit hashes, deviations, flaky tests, standing orders) clears it on pointers
 * alone. Lowering it would weaken the R2 substance gate to buy nothing. Phase 8
 * measures real boundary saves to confirm they clear it without padding; if they
 * cluster at the floor, revisit here with that data.
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

/**
 * The challenge file the two-step self-refresh handshake writes (Spec 1470).
 *
 * `afx self-refresh --begin` mints a nonce and records it here; the execute step
 * verifies the builder's save against THAT nonce and then deletes the file.
 *
 * The handshake exists because the nonce cannot be minted by the executing
 * command. `verifyReceipt` requires the nonce to already be INSIDE
 * `.builder-state.md`, but in the self path the builder writes that file before
 * invoking the command — so a nonce created at invocation could never be in a
 * file already on disk, and every run would abort `wrong-nonce`. The driven
 * (`afx refresh`) path avoids this only because an external driver issues the
 * nonce in the save request and *then* polls.
 *
 * `.builder-` prefix for the same reason as the other two: `afx cleanup`
 * classifies those as scaffold rather than dirt, so a worktree carrying one is
 * still considered clean.
 */
export const CHALLENGE_FILE_NAME = '.builder-refresh-challenge';

/**
 * Seconds Tower holds the re-entry before delivering it.
 *
 * NOT a "post-clear" hold, despite what it looks like. The re-entry is scheduled
 * BEFORE the clear is sent (see `self.ts` on why the destructive step goes last),
 * so the window this value has to cover is: the remainder of the current turn,
 * plus the clear executing at turn end. Framing it as time-after-the-clear would
 * make Phase 8 measure the wrong interval and pick a value that is too short.
 *
 * PROVISIONAL. `/arch-save` uses 15s, tuned by an architect watching it happen;
 * Spec 1470 requires this value to come from a live measurement instead, which
 * Phase 8 takes. Until then this is the arch-save number, carried over rather
 * than invented, and it is deliberately a named constant so the measurement has
 * exactly one place to land.
 *
 * Note the delivery is NOT a bare timer: `--delay` persists the body to the
 * durable mailbox at request time, so it survives a Tower restart, and the
 * render gate holds it until the target's prompt is verifiably clean.
 */
export const DEFAULT_REENTRY_DELAY_SECONDS = 15;

/**
 * How long a self-refresh challenge stays valid (Spec 1470).
 *
 * A challenge names one boundary at one moment. When an execute aborts — dirty
 * worktree, Tower unreachable — the challenge stays on disk, and the builder may
 * then commit, keep working, and reach a LATER boundary. Without an age bound,
 * running execute there without a fresh `begin` would validate a
 * `.builder-state.md` describing work that has since moved on.
 *
 * An hour is far longer than the seconds a real begin→execute pair takes, so it
 * never interrupts normal use; it exists to stop a forgotten challenge being
 * replayed much later.
 */
export const DEFAULT_CHALLENGE_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Upper bound on a challenge nonce, in hex characters.
 *
 * Without a ceiling, a hand-written challenge carrying a multi-kilobyte nonce
 * would make the SUBSTANCE gate trivially satisfiable: a state file containing
 * only the marker already exceeds `DEFAULT_MIN_BYTES`, so "wrote enough to be a
 * real save" would be proved by the marker alone.
 */
export const MAX_NONCE_HEX_CHARS = 128;

/**
 * Floors for the tunable safety parameters.
 *
 * Gate 0 originally checked only "finite and positive", which is validity rather
 * than SANITY — and for these three, a small positive value neuters the gate it
 * configures while still reporting success:
 *
 * - `--min-bytes 1` reduces the substance gate to "contains the nonce" (~12 bytes).
 * - `--stability-window 1` makes the sleep a single event-loop tick; two reads
 *   1ms apart do not detect a mid-write file.
 * - `--delay 0.001` is the dangerous one. The re-entry and the `/clear` then race
 *   for the same clean prompt, and if the render gate opens first the re-entry is
 *   delivered and immediately wiped — a cleared builder with nobody coming back,
 *   which is the exact outcome scheduling-before-clearing exists to prevent.
 *
 * Hard floors rather than warnings: a warning on a safety parameter is a warning
 * nobody reads in an unattended run.
 */
export const MIN_ALLOWED_MIN_BYTES = 200;
export const MIN_ALLOWED_STABILITY_WINDOW_MS = 500;
export const MIN_ALLOWED_REENTRY_DELAY_SECONDS = 5;
