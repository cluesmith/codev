/**
 * Self-refresh orchestrator — the tail of the refresh machine, run by the
 * builder on itself (Spec 1470).
 *
 * ## Why this exists separately from `runReset`
 *
 * `afx refresh` cannot be invoked by its own target. It sends a save request and
 * then POLLS for the receipt while waiting for the terminal to fall quiet — but
 * a builder running it would be mid-turn for the whole poll, so it could never
 * answer its own request. The run would burn the 300 s receipt timeout and
 * abort. The receipt and quiescence gates structurally require a driver outside
 * the turn.
 *
 * So this module is the TAIL of that machine, not a second copy of it: verify an
 * already-written save → assemble the re-orientation → schedule the re-entry →
 * clear. The verification and assembly are the SAME modules `runReset` uses
 * ({@link verifyReceipt}, {@link assembleReorientation}), which a structural test
 * pins. What is deliberately different is the save REQUEST text — see
 * {@link buildBoundarySaveRequest}.
 *
 * ## The two-step handshake, and why it is not one call
 *
 * `verifyReceipt` requires the nonce to be INSIDE the state file. In the self
 * path the builder writes that file before invoking the command, so a nonce
 * minted at invocation could never be in a file already on disk — every run
 * would abort `wrong-nonce`. Hence:
 *
 *   begin   → mint nonce, write the challenge file, return the save request
 *   (builder writes .builder-state.md, reproducing the nonce)
 *   execute → verify against THAT nonce, assemble, schedule, clear, consume
 *             the challenge
 *
 * The challenge is deleted on use and overwritten by every `begin`, which is
 * what stops a stale `.builder-state.md` from an EARLIER boundary passing the
 * gate. The driven path gets that freshness for free from being externally
 * driven; the self path has to earn it.
 *
 * ## Ordering, and the one place it differs from `/arch-save`
 *
 * Schedule the re-entry FIRST, clear SECOND. `/arch-save` does the reverse. The
 * two failure directions are not symmetric:
 *
 *   - schedule fails, no clear sent  → builder keeps everything. Recoverable.
 *   - clear sent, schedule fails     → context destroyed, nobody coming back.
 *
 * Only the second is unrecoverable, so the destructive step goes last. Baked
 * Decision 4 requires the automatic path to be MORE conservative than the manual
 * one; this is that, made concrete rather than asserted.
 *
 * ## Everything is a port, and every action is logged before it happens
 *
 * Same discipline as `runReset`, for the same reason: every safety property here
 * is an ORDERING property ("the clear never happens before X"), and ordering is
 * what is hardest to prove by reading. Actions go through injected ports and the
 * invariant tests assert over an ordered step log rather than over mocks, so "no
 * clear without a verified save" becomes something a test can fail on.
 *
 * The IRREVERSIBLE action is logged BEFORE it is attempted (`clear-attempted`),
 * with a second entry (`clear`) only on success. That asymmetry is deliberate:
 * `sendRaw` can succeed on the wire and still throw, and a log written only on
 * success would then claim no clear occurred about a context that no longer
 * exists — with every `expectNoClear` assertion agreeing. Reversible steps are
 * logged after they succeed, where a failure is genuinely a non-event.
 * (`runReset` logs its clear after the fact; that same weakness is noted for the
 * review artifact rather than fixed here, since this phase does not own it.)
 */

import { join } from 'node:path';

import {
  CHALLENGE_FILE_NAME,
  DEFAULT_CHALLENGE_MAX_AGE_MS,
  DEFAULT_MIN_BYTES,
  DEFAULT_REENTRY_DELAY_SECONDS,
  DEFAULT_STABILITY_WINDOW_MS,
  REORIENT_FILE_NAME,
  STATE_FILE_NAME,
} from './constants.js';
import {
  nonceMarker,
  generateNonce,
  verifyReceipt,
  describeReceiptFailure,
  stateFilePath,
  type ReceiptFsPort,
  type ReceiptObservation,
} from './receipt.js';
import {
  assembleReorientation,
  ReorientationAssemblyError,
  type IssuePayload,
  type ReorientationPayload,
  type ResumeNoticePort,
  type SpawnPromptPort,
} from './reorient.js';
import type { ResolvedBuilderContext } from './context.js';

// ============================================================================
// Ports
// ============================================================================

/** Filesystem surface. Superset of the receipt gate's, plus writes and delete. */
export interface SelfRefreshFsPort extends ReceiptFsPort {
  write(path: string, content: string): void;
  remove(path: string): void;
}

/** Wall clock and sleep, injected so tests run instantly and deterministically. */
export interface SelfRefreshClockPort {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * What the builder can do to its OWN terminal.
 *
 * Two distinct operations, never one `send(data, mode)`. Tower's raw route types
 * literal input into the PTY; the delayed route persists a formatted message to
 * the mailbox for later delivery. Confusing them is silent: `/clear` sent as a
 * normal message would be delivered as text rather than executed.
 */
export interface SelfTerminalPort {
  /** Schedule a message to self for delivery after `delaySeconds`. */
  scheduleReentry(message: string, delaySeconds: number): Promise<void>;
  /** Type literal text into our own PTY. This is how `/clear` is delivered. */
  sendRaw(text: string): Promise<void>;
}

/** Git surface — only what the dirty-worktree gate needs. */
export interface SelfGitPort {
  /** True when tracked files have uncommitted modifications (staged or not). */
  hasUncommittedTrackedChanges(): boolean;
}

// ============================================================================
// Step log
// ============================================================================

/**
 * The ordered record of what happened.
 *
 * `clear` is the only irreversible entry. Every invariant test is a statement
 * about this array — most importantly that `clear` never appears without
 * `reorient-written` and `reentry-scheduled` before it.
 */
export type SelfRefreshStepName =
  | 'challenge-read'
  | 'worktree-checked'
  | 'receipt-accepted'
  | 'assemble'
  | 'reorient-written'
  | 'reentry-scheduled'
  | 'challenge-marked'
  /**
   * Logged BEFORE the clear is sent, and never removed.
   *
   * The distinction from `clear` is the whole point. `terminal.sendRaw` can
   * succeed on the wire and still throw client-side — a dropped socket after
   * delivery, say — and in that case the builder IS cleared while the call
   * reports failure. Logging only on success would produce a run that says "no
   * clear happened" about a context that no longer exists, and every
   * `expectNoClear` assertion would agree with it.
   *
   * So the log records the INTENT before the irreversible act. `clear-attempted`
   * without `clear` means "we do not know" — which is the truth, and is
   * reportable. Anything asserting that no clear occurred must check for both.
   */
  | 'clear-attempted'
  /** Logged only after `sendRaw` returned successfully. */
  | 'clear'
  | 'challenge-consumed';

export interface SelfRefreshStep {
  name: SelfRefreshStepName;
  at: number;
  detail?: string;
}

// ============================================================================
// Results
// ============================================================================

export type SelfRefreshFailure =
  | 'no-challenge'
  | 'dirty-worktree'
  | 'receipt-rejected'
  | 'assembly-failed'
  | 'reentry-failed'
  /**
   * The challenge could not be marked consumed, so the clear was not attempted.
   *
   * Distinct from `reentry-failed` because the recovery differs: by this point a
   * re-entry is already queued, so a retry queues a SECOND one. The message has
   * to say so.
   */
  | 'challenge-burn-failed'
  | 'clear-failed';

export interface BeginResult {
  nonce: string;
  statePath: string;
  challengePath: string;
  /** The message telling the builder what to write. */
  saveRequest: string;
}

export interface SelfRefreshResult {
  /**
   * `dry-run` is deliberately distinct from `aborted`.
   *
   * A rehearsal that verified and assembled cleanly is a SUCCESS, and folding it
   * into `aborted` would make the report announce "ABORTED" on a healthy run and
   * force every caller's exit-code logic to special-case `failure === undefined`
   * — a contract nobody would guess from the type.
   */
  outcome: 'completed' | 'aborted' | 'dry-run';
  steps: SelfRefreshStep[];
  /** Present when aborted — which gate refused, for the report. */
  failure?: SelfRefreshFailure;
  /** Human-readable reason, naming the specific gate. */
  reason?: string;
  statePath: string;
  reorientPath?: string;
  payload?: ReorientationPayload;
  stateBytes?: number;
}

/** The persisted challenge. */
export interface Challenge {
  nonce: string;
  issuedAt: number;
  /** Boundary id from porch, e.g. `enter:review`. Shapes the save request. */
  boundary?: string;
  /**
   * Set immediately BEFORE the clear is attempted; refused by the gate on any
   * later run. Makes a challenge single-use even when the post-clear delete
   * fails, which is the difference between "tidied up" and "cannot be replayed".
   */
  consumedAt?: number;
}

// ============================================================================
// The save request — deliberately NOT buildSaveRequest
// ============================================================================

/**
 * The boundary-aware save request.
 *
 * This is the one place the self path deliberately diverges from the driven one.
 * `buildSaveRequest` (receipt.ts) asks for a "complete working state" and says
 * "do not summarise for brevity" — right for a MID-PHASE reset, where a builder
 * may be holding a half-finished action nothing on disk records.
 *
 * A boundary save is a different problem. Spec 1470 fixes the boundaries at
 * moments when the durable state is already externalised — the spec, the plan,
 * `status.yaml`, the thread narrative and git — so what a cold reader actually
 * needs is the residue those artifacts do NOT carry. Asking for "everything"
 * here produces a long file that mostly restates the plan, and Baked Decision 2
 * explicitly says to keep the builder save minimal.
 *
 * Hence: pointers over prose. Receipts with commit hashes, not narration of what
 * the commits contain.
 *
 * At the REVIEW boundary there is one further exclusion, and it is the whole
 * reason that boundary is a quality feature rather than only a context one: a
 * builder entering review in a fresh context should read its own diff cold. If
 * the save carries "I implemented X and it is correct because Y", the refresh
 * hands back the very perspective it was supposed to remove.
 */
export function buildBoundarySaveRequest(
  nonce: string,
  statePath: string,
  boundary?: string,
): string {
  const isReview = boundary === 'enter:review';

  const lines = [
    'CONTEXT REFRESH — save your working state now.',
    '',
    boundary ? `Boundary: \`${boundary}\`` : 'Boundary: (unspecified)',
    '',
    `Write your working state to \`${statePath}\` (untracked; do not stage or commit it).`,
    '',
    'The file MUST begin with this exact line, reproduced character for character:',
    '',
    nonceMarker(nonce),
    '',
    'Write for a COLD READER — a competent agent that wakes up with your worktree,',
    'your branch, and no memory of this conversation.',
    '',
    'This is a PROTOCOL BOUNDARY, so most of your state is already on disk. The spec,',
    'the plan, `status.yaml`, your thread narrative and git history all survive the',
    'refresh and will be re-read. Do not restate them.',
    '',
    'Carry only what those artifacts do NOT contain:',
    '',
    '1. **Receipts** — what is done and *verified*, with paths and commit hashes.',
    '   Distinguish "written" from "verified"; a cold reader cannot tell.',
    '2. **Deviations** — where the implementation diverges from the plan, and why.',
    '3. **Flaky or skipped tests** you hit, and what you did about them.',
    '4. **Deferred work** — anything knowingly left, and the reason.',
    '5. **Standing orders** from the architect you are still bound by, including',
    '   anything you were told NOT to do.',
    '6. **Next concrete action** — the single thing to do first after the refresh.',
  ];

  if (isReview) {
    lines.push(
      '',
      'THIS IS THE REVIEW BOUNDARY. You are about to read your own diff with fresh',
      'eyes, which is the point of refreshing here. So do NOT carry:',
      '',
      '- any assessment of whether your implementation is correct or good;',
      '- any defence or justification of choices you made;',
      '- any narrative of how the code came to be.',
      '',
      'Facts and pointers only. Let the diff speak for itself — if you tell the next',
      'reader what to think of the code, you have handed back the exact perspective',
      'this refresh exists to remove.',
    );
  }

  lines.push(
    '',
    `The save must be at least ${DEFAULT_MIN_BYTES} bytes to be accepted — not as a`,
    'word count to pad out, but because a file below it is indistinguishable from a',
    'stub. If you genuinely have less than that to say, you are probably omitting',
    'receipts or standing orders. This boundary is refreshed AT MOST ONCE and is',
    'never retried, so a save rejected here means the refresh simply does not happen.',
    '',
    'Pointers, not prose. When the file is written, run the execute step.',
  );

  return lines.join('\n');
}

// ============================================================================
// Paths
// ============================================================================

/**
 * `path.join`, not string concatenation — the same reasoning `stateFilePath`
 * documents. These paths are shown to the builder verbatim and stat'd by the
 * gate, so a hand-built separator would name one path in the instruction and
 * check a different one on Windows. `join` also collapses a trailing slash.
 */
export function challengeFilePath(worktreePath: string): string {
  return join(worktreePath, CHALLENGE_FILE_NAME);
}

export function reorientFilePath(worktreePath: string): string {
  return join(worktreePath, REORIENT_FILE_NAME);
}

// ============================================================================
// Step 1 — begin
// ============================================================================

export interface BeginOptions {
  fs: SelfRefreshFsPort;
  clock: SelfRefreshClockPort;
  worktree: string;
  boundary?: string;
  /** Injected for tests; defaults to the real generator. */
  makeNonce?: () => string;
}

/**
 * Mint a challenge and tell the builder what to write.
 *
 * Overwrites any existing challenge deliberately: a fresh `begin` must invalidate
 * a previous boundary's nonce, or a stale `.builder-state.md` left on disk would
 * satisfy the gate without the builder writing anything.
 *
 * Writes NOTHING destructive and touches no terminal. Nothing here can lose work.
 */
export function beginSelfRefresh(options: BeginOptions): BeginResult {
  const { fs, clock, worktree, boundary, makeNonce = generateNonce } = options;

  const nonce = makeNonce();
  const challengePath = challengeFilePath(worktree);
  const statePath = stateFilePath(worktree, STATE_FILE_NAME);

  const challenge: Challenge = { nonce, issuedAt: clock.now(), boundary };
  fs.write(challengePath, JSON.stringify(challenge, null, 2));

  return {
    nonce,
    statePath,
    challengePath,
    saveRequest: buildBoundarySaveRequest(nonce, statePath, boundary),
  };
}

// ============================================================================
// Step 2 — execute
// ============================================================================

/**
 * Parse and FULLY validate a persisted challenge.
 *
 * `JSON.parse` returns `any`, and casting it to {@link Challenge} buys a
 * compile-time guarantee about a runtime value that came off disk. That gap is
 * exploitable, and not theoretically:
 *
 *   `{"nonce": []}` survives a truthiness check, because `![]` is `false`. It is
 *   then handed to `verifyReceipt`, whose `content.includes(nonce)` coerces the
 *   array to `''` — and `String.includes('')` is true for EVERY string. The
 *   freshness gate does not merely weaken, it inverts: any file over the size
 *   floor passes as a fresh save.
 *
 *   A non-numeric or `NaN` `issuedAt` defeats the age bound the same way, since
 *   every comparison with `NaN` is false. A FUTURE `issuedAt` yields a negative
 *   age, which is likewise never "too old".
 *
 * So the shape is checked here, at the trust boundary, rather than assumed. The
 * driven path needs no equivalent because it mints its nonce in-process and
 * never reads one back from disk; only the self path takes a challenge from a
 * file, which is exactly where validation belongs.
 */
export function parseChallenge(
  raw: string,
  now: number,
): { ok: true; challenge: Challenge } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'is not a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.nonce !== 'string' || obj.nonce.length === 0) {
    return {
      ok: false,
      reason: `carries a non-string or empty nonce (${JSON.stringify(obj.nonce)}). A nonce that ` +
        `is not a string can coerce to '' and match every file, defeating the freshness gate`,
    };
  }

  if (typeof obj.issuedAt !== 'number' || !Number.isFinite(obj.issuedAt)) {
    return {
      ok: false,
      reason: `carries a non-finite issuedAt (${JSON.stringify(obj.issuedAt)}); the age bound ` +
        `cannot be evaluated against it`,
    };
  }

  // A future timestamp yields a negative age, which no maximum can reject.
  // Allow a small skew so an ordinary clock adjustment is not fatal.
  const SKEW_MS = 60_000;
  if (obj.issuedAt > now + SKEW_MS) {
    return {
      ok: false,
      reason: `was issued in the future (issuedAt ${obj.issuedAt}, now ${now}); a future ` +
        `timestamp cannot expire`,
    };
  }

  if (obj.boundary !== undefined && typeof obj.boundary !== 'string') {
    return { ok: false, reason: 'carries a non-string boundary' };
  }

  if (obj.consumedAt !== undefined && typeof obj.consumedAt !== 'number') {
    return { ok: false, reason: 'carries a non-numeric consumedAt' };
  }

  return {
    ok: true,
    challenge: {
      nonce: obj.nonce,
      issuedAt: obj.issuedAt,
      boundary: obj.boundary as string | undefined,
      consumedAt: obj.consumedAt as number | undefined,
    },
  };
}

export interface RunSelfRefreshOptions {
  fs: SelfRefreshFsPort;
  clock: SelfRefreshClockPort;
  terminal: SelfTerminalPort;
  git: SelfGitPort;
  context: ResolvedBuilderContext;
  buildSpawnPrompt: SpawnPromptPort;
  buildResumeNotice?: ResumeNoticePort;
  issue?: IssuePayload;
  addendum?: string;
  minBytes?: number;
  stabilityWindowMs?: number;
  reentryDelaySeconds?: number;
  /**
   * Reject a challenge older than this. Defaults to
   * {@link DEFAULT_CHALLENGE_MAX_AGE_MS}.
   */
  challengeMaxAgeMs?: number;
  /**
   * Boundary this run is FOR, when the caller knows it.
   *
   * A challenge names the boundary it was issued at. If an execute aborts
   * (dirty worktree, Tower down) the challenge survives on disk, and the builder
   * may then commit, work on, and reach a LATER boundary. Running execute there
   * without a fresh `begin` would let the lingering challenge validate a
   * `.builder-state.md` describing superseded work — precisely the staleness the
   * handshake exists to stop.
   */
  expectedBoundary?: string;
  /** Report what would happen; send nothing, clear nothing, consume nothing. */
  dryRun?: boolean;
  /** Escape hatch for a worktree that is legitimately dirty. Off by default. */
  allowDirty?: boolean;
}

export async function runSelfRefresh(
  options: RunSelfRefreshOptions,
): Promise<SelfRefreshResult> {
  const {
    fs,
    clock,
    terminal,
    git,
    context,
    buildSpawnPrompt,
    buildResumeNotice,
    issue,
    addendum,
    minBytes = DEFAULT_MIN_BYTES,
    stabilityWindowMs = DEFAULT_STABILITY_WINDOW_MS,
    reentryDelaySeconds = DEFAULT_REENTRY_DELAY_SECONDS,
    challengeMaxAgeMs = DEFAULT_CHALLENGE_MAX_AGE_MS,
    expectedBoundary,
    dryRun = false,
    allowDirty = false,
  } = options;

  const steps: SelfRefreshStep[] = [];
  const step = (name: SelfRefreshStepName, detail?: string): void => {
    steps.push({ name, at: clock.now(), detail });
  };

  const worktree = context.worktree;
  const statePath = stateFilePath(worktree, STATE_FILE_NAME);
  const challengePath = challengeFilePath(worktree);
  const reorientPath = reorientFilePath(worktree);

  const abort = (
    failure: SelfRefreshFailure,
    reason: string,
  ): SelfRefreshResult => ({ outcome: 'aborted', steps, failure, reason, statePath });

  // ------------------------------------------------------------------
  // Gate 1 — the challenge must exist and be readable.
  // ------------------------------------------------------------------
  // Without it there is no nonce to verify against, so freshness is
  // unprovable. Refusing here is what makes "run execute twice" safe: the
  // first run consumes the challenge, the second finds nothing.
  const rawChallenge = fs.read(challengePath);
  if (rawChallenge === null) {
    return abort(
      'no-challenge',
      `No refresh challenge at ${challengePath}. Run the begin step first ` +
        `(a challenge is consumed by each execute, so this also means "already refreshed").`,
    );
  }

  const parsedChallenge = parseChallenge(rawChallenge, clock.now());
  if (!parsedChallenge.ok) {
    return abort(
      'no-challenge',
      `Refresh challenge at ${challengePath} ${parsedChallenge.reason}. ` +
        `Run the begin step again.`,
    );
  }
  const challenge = parsedChallenge.challenge;
  if (challenge.consumedAt !== undefined) {
    // Burned by an earlier execute whose delete did not land. Refusing here is
    // what makes the pre-clear mark sufficient on its own.
    return abort(
      'no-challenge',
      `Refresh challenge at ${challengePath} was already consumed. A challenge is ` +
        `single-use; run the begin step again if you mean to refresh once more.`,
    );
  }
  // A challenge is for ONE boundary at ONE moment. Both checks close the same
  // hole from different sides: a run that aborted leaves its challenge on disk,
  // and without these it would still satisfy the gate at a later boundary,
  // against a state file describing work that has since moved on.
  if (expectedBoundary !== undefined && challenge.boundary !== expectedBoundary) {
    return abort(
      'no-challenge',
      `Refresh challenge was issued for boundary '${challenge.boundary ?? '(none)'}' but this ` +
        `run is for '${expectedBoundary}'. Run the begin step again — a challenge does not ` +
        `carry across boundaries.`,
    );
  }

  const age = clock.now() - challenge.issuedAt;
  if (age > challengeMaxAgeMs) {
    return abort(
      'no-challenge',
      `Refresh challenge is ${Math.round(age / 1000)}s old (limit ` +
        `${Math.round(challengeMaxAgeMs / 1000)}s). A save verified against a stale challenge ` +
        `may describe work that has since moved on. Run the begin step again.`,
    );
  }

  step('challenge-read', challenge.boundary ?? 'no-boundary');

  // ------------------------------------------------------------------
  // Gate 2 — the worktree must have no uncommitted tracked changes.
  // ------------------------------------------------------------------
  // A refresh fires at a protocol boundary, where porch has just committed.
  // Uncommitted tracked work means we are NOT at that boundary — something is
  // half-done, and the plan/spec/git triple that a refreshed builder re-reads
  // would not describe it. Untracked `.builder-*` scaffold does not count; it
  // is expected to be there.
  if (!allowDirty && git.hasUncommittedTrackedChanges()) {
    return abort(
      'dirty-worktree',
      'Worktree has uncommitted tracked changes. A refresh assumes a committed ' +
        'boundary, and a fresh context re-orients from artifacts and git — work ' +
        'that exists only in the working tree would be invisible to it. Commit ' +
        'first, or pass --allow-dirty if this is deliberate.',
    );
  }
  step('worktree-checked');

  // ------------------------------------------------------------------
  // Gate 3 — the save must pass the SAME receipt gate the driven path uses.
  // ------------------------------------------------------------------
  // Two observations, not one: `verifyReceipt` returns `still-growing` whenever
  // `previous` is null, because stability requires agreement across a real time
  // gap. One read cannot distinguish a finished file from one mid-write.
  const first = verifyReceipt({
    fs,
    statePath,
    nonce: challenge.nonce,
    minBytes,
    previous: null,
    msSincePrevious: 0,
    stabilityWindowMs,
  });

  // Fail fast on the reasons a second look cannot change. Sleeping 2 s to
  // re-confirm a missing file helps nobody.
  if (first.status === 'missing' || first.status === 'wrong-nonce' || first.status === 'too-small') {
    return abort('receipt-rejected', describeReceiptFailure(first, statePath, minBytes));
  }

  // A non-positive window would make `msSincePrevious >= stabilityWindowMs`
  // trivially true, collapsing two observations into one and letting a file
  // still being written pass as stable. Refuse rather than silently disable a
  // gate. (Phase 4 also validates this at the CLI boundary, following the
  // precedent `afx refresh` set for its own safety flags.)
  if (!Number.isFinite(stabilityWindowMs) || stabilityWindowMs <= 0) {
    return abort(
      'receipt-rejected',
      `stabilityWindowMs must be a positive number (got ${stabilityWindowMs}); a ` +
        `non-positive window disables the stability gate entirely.`,
    );
  }

  const beforeSleep = clock.now();
  await clock.sleep(stabilityWindowMs);
  // MEASURE the gap rather than asserting it. Passing `stabilityWindowMs` on
  // faith would keep the gate passing even if the sleep did not actually
  // advance the clock — the stability check would then be comparing two reads
  // taken back to back while claiming they were seconds apart.
  const elapsed = clock.now() - beforeSleep;

  const second = verifyReceipt({
    fs,
    statePath,
    nonce: challenge.nonce,
    minBytes,
    previous: first,
    msSincePrevious: elapsed,
    stabilityWindowMs,
  });

  if (second.status !== 'accepted') {
    return abort('receipt-rejected', describeReceiptFailure(second, statePath, minBytes));
  }
  step('receipt-accepted', `${second.bytes} bytes`);

  // ------------------------------------------------------------------
  // Gate 4 — assemble the re-orientation (R3: complete or throw).
  // ------------------------------------------------------------------
  let payload: ReorientationPayload;
  try {
    payload = assembleReorientation({
      context,
      statePath,
      addendum,
      buildSpawnPrompt,
      buildResumeNotice,
      issue,
    });
  } catch (err) {
    const reason =
      err instanceof ReorientationAssemblyError
        ? err.message
        : `Re-orientation assembly failed: ${err instanceof Error ? err.message : String(err)}`;
    return abort('assembly-failed', reason);
  }
  step('assemble');

  if (dryRun) {
    // Everything above is a read or a pure computation, so stopping here is a
    // complete rehearsal: the caller learns whether this refresh WOULD proceed
    // without any of it having happened. The challenge is left intact so the
    // real run can still use it.
    return {
      outcome: 'dry-run',
      steps,
      reason: 'dry run — verified and assembled, nothing sent',
      statePath,
      reorientPath,
      payload,
      stateBytes: second.bytes,
    };
  }

  // ------------------------------------------------------------------
  // R1 — the re-orientation is ON DISK before anything destructive.
  // ------------------------------------------------------------------
  try {
    fs.write(reorientPath, payload.longForm);
  } catch (err) {
    return abort(
      'assembly-failed',
      `Could not write ${reorientPath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Refusing to clear without the re-orientation on disk (R1).`,
    );
  }
  step('reorient-written');

  // ------------------------------------------------------------------
  // Schedule the re-entry BEFORE the clear. This is the ordering that
  // differs from `/arch-save`, and the reason is asymmetric damage: a failed
  // schedule with no clear is recoverable, a clear with no re-entry is not.
  // ------------------------------------------------------------------
  try {
    await terminal.scheduleReentry(payload.inline, reentryDelaySeconds);
  } catch (err) {
    return abort(
      'reentry-failed',
      `Could not schedule the post-clear re-entry: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `NOT clearing — your context is intact. The re-orientation is saved at ` +
        `${reorientPath} if you want to retry.`,
    );
  }
  step('reentry-scheduled', `+${reentryDelaySeconds}s`);

  // ------------------------------------------------------------------
  // Burn the challenge BEFORE clearing, not after.
  // ------------------------------------------------------------------
  // Deleting it afterwards is not enough: if the delete fails, the challenge and
  // the already-verified state file both remain, so a second `execute` would
  // sail through every gate and clear the builder AGAIN — scheduling a second
  // re-entry into a context that just lost the first one.
  //
  // Marking is a write rather than a delete, and it happens while aborting is
  // still free. If it fails we stop here with nothing destroyed. The delete
  // after the clear is then pure tidiness: the mark alone already makes the
  // challenge unusable.
  try {
    fs.write(
      challengePath,
      JSON.stringify({ ...challenge, consumedAt: clock.now() } satisfies Challenge, null, 2),
    );
  } catch (err) {
    return abort(
      'challenge-burn-failed',
      `Could not mark the refresh challenge consumed: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `NOT clearing — an unburnable challenge could be replayed into a second clear. ` +
        `Your context is intact, but a re-entry message is ALREADY QUEUED from the ` +
        `previous step and will arrive shortly; it can be ignored. Note that retrying ` +
        `queues a second one.`,
    );
  }
  step('challenge-marked');

  // ------------------------------------------------------------------
  // The irreversible step. Everything above had to succeed to get here.
  // ------------------------------------------------------------------
  // Logged BEFORE it is attempted: see `clear-attempted`.
  step('clear-attempted');
  try {
    await terminal.sendRaw('/clear');
  } catch (err) {
    // Deliberately NOT "your context is intact". `sendRaw` can fail after the
    // write reached the terminal, so from here we genuinely cannot tell whether
    // the clear landed. Saying it did not would be a guess presented as a fact,
    // and the reader would act on it. The re-entry is queued either way, so both
    // outcomes recover.
    return abort(
      'clear-failed',
      `Re-entry was scheduled but sending the clear reported an error: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `The clear MAY still have landed — this path cannot tell. Either way the ` +
        `re-orientation is at ${reorientPath} and a re-entry message is already queued.`,
    );
  }
  step('clear');

  // Tidy up. Genuinely optional now: the challenge was marked consumed before
  // the clear, so even if this delete fails the file cannot be replayed — a
  // marked challenge is refused at the gate above. Never turn a completed
  // refresh into a failure over housekeeping.
  try {
    fs.remove(challengePath);
    step('challenge-consumed');
  } catch {
    // Left on disk, already neutralised. The next `begin` overwrites it.
  }

  return {
    outcome: 'completed',
    steps,
    statePath,
    reorientPath,
    payload,
    stateBytes: second.bytes,
  };
}

// ============================================================================
// Reporting
// ============================================================================

/** Render a result for a human. */
export function formatSelfRefreshReport(result: SelfRefreshResult): string {
  const lines: string[] = [];
  const order = result.steps.map(s => s.name).join(' → ');

  if (result.outcome === 'dry-run') {
    lines.push('Dry run — this refresh WOULD proceed.');
    lines.push(`  state file:     ${result.statePath} (${result.stateBytes} bytes)`);
    lines.push(`  steps:          ${order}`);
    lines.push('');
    lines.push('Nothing was sent, written or consumed.');
    return lines.join('\n');
  }

  if (result.outcome === 'completed') {
    lines.push('Context refresh complete.');
    lines.push(`  state file:     ${result.statePath} (${result.stateBytes} bytes)`);
    lines.push(`  re-orientation: ${result.reorientPath}`);
    lines.push(`  steps:          ${order}`);
    lines.push('');
    lines.push('Your next instruction will arrive shortly. It will tell you to run `porch next`.');
    return lines.join('\n');
  }

  lines.push(`Context refresh ABORTED${result.failure ? ` (${result.failure})` : ''}.`);
  lines.push(`  reason: ${result.reason}`);
  lines.push(`  steps:  ${order || '(none)'}`);
  if (result.steps.some(s => s.name === 'clear-attempted')) {
    lines.push('');
    lines.push('A clear WAS attempted and may have landed. Do not assume your context survived.');
  } else {
    lines.push('');
    lines.push('No clear was attempted. Your context is intact.');
  }
  return lines.join('\n');
}

/**
 * Did this run reach the irreversible step?
 *
 * True for a CONFIRMED clear and for an ATTEMPTED one, because an attempt whose
 * send threw may still have landed. Anything asking "is this builder's context
 * safe?" must treat both as unsafe; a helper that answered only about confirmed
 * clears would be the optimistic reading of an ambiguous event.
 */
export function didClear(result: SelfRefreshResult): boolean {
  return result.steps.some(s => s.name === 'clear' || s.name === 'clear-attempted');
}

/** Strictly confirmed: `sendRaw` returned successfully. */
export function didClearConfirmed(result: SelfRefreshResult): boolean {
  return result.steps.some(s => s.name === 'clear');
}

export type { ReceiptObservation };
