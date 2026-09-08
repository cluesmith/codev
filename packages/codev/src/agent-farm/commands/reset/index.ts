/**
 * Reset orchestrator — the `afx refresh` state machine (Spec 1273).
 *
 * Composes the verified parts from phases 1–5 into the flow the architect ran by
 * hand on 2026-07-27: request save-state → verify the receipt → wait for the
 * turn to end → `/clear` → re-orient.
 *
 * ## Why this is a state machine over injected ports
 *
 * Reset is destructive in a way almost nothing else in Agent Farm is: `/clear`
 * discards a builder's entire conversation, and there is no undo. Every safety
 * property is therefore an ORDERING property — "the clear never happens before
 * X" — and ordering is exactly what is hardest to prove by reading code.
 *
 * So the orchestrator does two things no ordinary command does:
 *
 *   1. Every externally-visible action goes through a port (`clock`, `fs`,
 *      `sendMessage`, `sendRaw`, `sendEscape`). Nothing here touches Tower, a
 *      PTY or the filesystem directly.
 *   2. Every action is appended to an ordered **step log** before it is
 *      performed.
 *
 * The invariant tests then assert over that log — that `clear` never appears
 * without `assemble` before it, that `escalate-esc` never precedes
 * `receipt-accepted`, that an aborted run contains no `clear` at all. That turns
 * "impossible by construction" from a claim in a comment into something a test
 * can fail on.
 *
 * ## The invariants, and where each is enforced
 *
 * - **R1** (never clear without a saved re-orientation): `runReset` assembles and
 *   writes `.builder-reorient.md` at step 2, before any destructive step exists
 *   in the log. Assembly failure returns before the request is even sent.
 * - **R2** (never clear without a verified receipt): the poll loop only leaves
 *   `awaiting-receipt` on `accepted`; every other exit path returns an aborted
 *   result.
 * - **R3** (complete-or-abort re-orientation): delegated wholesale to
 *   `assembleReorientation`, which throws rather than emitting a partial frame.
 * - **R4** (never clear a builder mid-turn): quiescence is a bounded wait, then
 *   at most ONE ESC escalation, then a second bounded wait. Still not quiet
 *   aborts — there is deliberately no third attempt and no "clear anyway".
 */

import type {
  ResolvedBuilderContext,
} from './context.js';
import {
  assembleReorientation,
  ReorientationAssemblyError,
  type IssuePayload,
  type ReorientationPayload,
  type ResumeNoticePort,
  type SpawnPromptPort,
} from './reorient.js';
import {
  buildSaveRequest,
  describeReceiptFailure,
  generateNonce,
  stateFilePath,
  verifyReceipt,
  type ReceiptFsPort,
  type ReceiptObservation,
} from './receipt.js';
import {
  DEFAULT_MIN_BYTES,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_QUIESCE_POST_ESCALATION_TIMEOUT_MS,
  DEFAULT_QUIESCE_TIMEOUT_MS,
  DEFAULT_QUIET_WINDOW_MS,
  DEFAULT_RECEIPT_TIMEOUT_MS,
  DEFAULT_STABILITY_WINDOW_MS,
  REORIENT_FILE_NAME,
} from './constants.js';

// ============================================================================
// Ports
// ============================================================================

/** Filesystem surface. Superset of the receipt gate's, plus the R1 write. */
export interface ResetFsPort extends ReceiptFsPort {
  write(path: string, content: string): void;
}

/** Wall clock and sleep, injected so tests run instantly and deterministically. */
export interface ClockPort {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** What the orchestrator can observe about the target terminal. */
export interface TerminalObservation {
  exists: boolean;
  /**
   * Epoch ms of the last PTY output (phase 2).
   *
   * `undefined` means the Tower serving this terminal predates the field — NOT
   * "no output ever". The quiescence gate refuses to proceed on `undefined`
   * rather than treating it as 0, which would read as "silent since 1970" and
   * clear a builder mid-turn. That is the exact R4 violation this field exists
   * to prevent.
   */
  lastDataAt?: number;
  /**
   * Whether input can actually reach the process right now.
   *
   * `undefined` means an older Tower did not report it. Unlike `lastDataAt`,
   * absence here is NOT treated as a refusal, and the asymmetry is deliberate:
   * an unobservable turn state leads to a SILENT, destructive failure (clearing
   * a builder mid-turn), whereas an unobservable write path leads to a LOUD,
   * harmless one (the first send throws). Refuse only what fails quietly.
   */
  writable?: boolean;
}

/**
 * The three ways to reach a terminal, kept as three distinct operations.
 *
 * They are separate methods rather than one `write(data, mode)` because the
 * underlying transports are genuinely different and confusing two of them is
 * silent. Tower's `escape` route calls `writeEscapeToSession`, which writes a
 * hardcoded ESC and **ignores the message body entirely**
 * (`servers/message-write.ts:46`). So a single `writeRaw(data)` bound to
 * `escape: true` would deliver an ESC when asked to type `/clear` — the command
 * would appear to succeed, the terminal would go quiet, and no context would be
 * cleared. Splitting the port makes that mistake unrepresentable.
 */
export interface TerminalPort {
  observe(): Promise<TerminalObservation>;
  /** Deliver a normal, formatted message (the save request, the re-orientation). */
  sendMessage(message: string): Promise<void>;
  /**
   * Type unformatted text into the PTY (Tower's `raw: true`).
   *
   * This is how `/clear` is delivered — as literal typed input, which is what
   * the verified manual recipe used (`afx send <builder> --raw '/clear'`).
   */
  sendRaw(text: string): Promise<void>;
  /** Send a bare ESC keystroke (Tower's `escape: true`; phase 1's path). */
  sendEscape(): Promise<void>;
  /**
   * Recent terminal output plus the buffer's total line count, for best-effort
   * clear confirmation. Null when this Tower cannot serve it.
   *
   * `total` is what makes confirmation trustworthy. A refresh writes into this
   * same terminal — the save request, the re-orientation — so any pattern matched
   * against the whole buffer eventually collides with its OWN text. (It did,
   * twice: first the echoed `/clear`, then the save request's header, which read
   * "CONTEXT RESET INCOMING" before #1489.) Snapshotting `total` before the clear
   * lets the check read only what the harness emitted AFTERWARDS.
   */
  readOutput?(): Promise<{ lines: string[]; total: number } | null>;
}

// ============================================================================
// Step log
// ============================================================================

/**
 * Every externally-visible action, in order.
 *
 * The names are part of the test contract — the invariant assertions match on
 * them — so renaming one is an API change, not a cosmetic edit.
 */
export type ResetStepName =
  | 'resolve'
  | 'assemble'
  | 'write-reorient-file'
  | 'interrupt-first'
  | 'send-save-request'
  | 'receipt-accepted'
  | 'quiescent'
  | 'escalate-esc'
  | 'clear'
  | 'clear-confirmed'
  | 'clear-unconfirmed'
  | 'send-reorientation';

export interface ResetStep {
  name: ResetStepName;
  at: number;
  detail?: string;
}

export type ResetOutcome = 'completed' | 'aborted' | 'dry-run';

export interface ResetResult {
  outcome: ResetOutcome;
  steps: ResetStep[];
  /** Populated on `aborted`. Names the gate that failed, never just "failed". */
  abortReason?: string;
  nonce: string;
  statePath: string;
  reorientPath: string;
  payload?: ReorientationPayload;
  /**
   * The exact save-state request the builder is asked to act on.
   *
   * Exposed rather than kept internal because `--dry-run` must be able to print
   * it. The request is what the whole R2 gate is verifying compliance with, so
   * "what exactly will the builder be told to write" is the single most useful
   * thing a dry run can show — and it cannot be shown if the orchestrator keeps
   * it to itself.
   */
  saveRequest: string;
  /** Size of the accepted state file, for the report. */
  stateBytes?: number;
}

/** Thrown for conditions that must stop the run before anything is touched. */
export class ResetPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetPreflightError';
  }
}

// ============================================================================
// Options
// ============================================================================

export interface RunResetOptions {
  context: ResolvedBuilderContext;
  fs: ResetFsPort;
  clock: ClockPort;
  terminal: TerminalPort;
  buildSpawnPrompt: SpawnPromptPort;
  buildResumeNotice?: ResumeNoticePort;
  issue?: IssuePayload;
  /** Architect addendum from `--note` / `--file`. */
  addendum?: string;
  /** Print the plan and touch nothing. */
  dryRun?: boolean;
  /** ESC before the save request, for a builder already wedged mid-turn. */
  interruptFirst?: boolean;
  receiptTimeoutMs?: number;
  pollIntervalMs?: number;
  minBytes?: number;
  stabilityWindowMs?: number;
  quietWindowMs?: number;
  quiesceTimeoutMs?: number;
  quiescePostEscalationTimeoutMs?: number;
  /** Override for the state-file name. Validated to stay inside the worktree. */
  stateFileName?: string;
}

// ============================================================================
// Orchestration
// ============================================================================

export async function runReset(options: RunResetOptions): Promise<ResetResult> {
  const {
    context,
    fs,
    clock,
    terminal,
    buildSpawnPrompt,
    buildResumeNotice,
    issue,
    addendum,
    dryRun = false,
    interruptFirst = false,
    receiptTimeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    minBytes = DEFAULT_MIN_BYTES,
    stabilityWindowMs = DEFAULT_STABILITY_WINDOW_MS,
    quietWindowMs = DEFAULT_QUIET_WINDOW_MS,
    quiesceTimeoutMs = DEFAULT_QUIESCE_TIMEOUT_MS,
    quiescePostEscalationTimeoutMs = DEFAULT_QUIESCE_POST_ESCALATION_TIMEOUT_MS,
    stateFileName,
  } = options;

  const steps: ResetStep[] = [];
  const step = (name: ResetStepName, detail?: string) => {
    steps.push({ name, at: clock.now(), detail });
  };

  const statePath = resolveStatePath(context.worktree, stateFileName);
  const reorientPath = stateFilePath(context.worktree, REORIENT_FILE_NAME);
  const nonce = generateNonce();

  // --------------------------------------------------------------------
  // 0. Timing-parameter sanity.
  //
  // Validated HERE as well as at the CLI boundary, because these values do not
  // merely tune the run — each one can switch OFF a safety gate while the run
  // still reports success. A negative quiet window makes every quiescence check
  // pass instantly (R4 gone); a non-positive minimum accepts any state file
  // however empty (R2's substance floor gone); a NaN timeout produces a NaN
  // deadline, and since every comparison against NaN is false, the wait never
  // expires and the command hangs.
  //
  // The orchestrator is the component that OWNS these invariants, so it does
  // not delegate their preconditions to its callers. A programmatic caller must
  // not be able to disable R2 or R4 by passing a number.
  // --------------------------------------------------------------------
  requirePositive(receiptTimeoutMs, 'receiptTimeoutMs');
  requirePositive(pollIntervalMs, 'pollIntervalMs');
  requirePositive(minBytes, 'minBytes');
  requirePositive(stabilityWindowMs, 'stabilityWindowMs');
  requirePositive(quietWindowMs, 'quietWindowMs');
  requirePositive(quiesceTimeoutMs, 'quiesceTimeoutMs');
  requirePositive(quiescePostEscalationTimeoutMs, 'quiescePostEscalationTimeoutMs');

  // --------------------------------------------------------------------
  // 1. Preflight. Everything that can refuse does so before ANY write.
  // --------------------------------------------------------------------

  // Harness capability is checked first and aborts loudly, naming the harness.
  // No substituted mechanism: if this agent has no in-session context reset,
  // there is no partial version of a reset worth doing (fail fast).
  if (!context.harness.supportsContextReset) {
    throw new ResetPreflightError(
      `Builder '${context.builderId}' runs under the '${context.harnessName}' harness, ` +
        `which has no in-session context reset. Refresh is a no-op there — there is no ` +
        `substitute mechanism. Use the boundary-recycle pattern instead: let the builder ` +
        `finish, then respawn with 'afx spawn <id> --resume'.`,
    );
  }

  const observed = await terminal.observe();
  if (!observed.exists) {
    throw new ResetPreflightError(
      `Builder '${context.builderId}' has no live terminal. Refresh writes to a running ` +
        `session; there is nothing to clear. Check 'afx status'.`,
    );
  }

  // Writability is checked HERE, in preflight, not left to fail on the first
  // send. The plan's contract is validate-before-touch: discovering the problem
  // later would mean `.builder-reorient.md` had already been written to the
  // builder's worktree for a reset that could never proceed.
  //
  // `status: 'running'` is not sufficient evidence — a session whose shellper
  // connection died reports exactly that while dropping every write (#1198),
  // which is the specific case this catches.
  if (observed.writable === false) {
    throw new ResetPreflightError(
      `Builder '${context.builderId}' has a terminal that is not accepting input ` +
        `(its process connection is down — #1198). Refresh would send a save request that ` +
        `is silently dropped. Nothing has been touched. Check Tower logs, or retry once ` +
        `the session reconnects.`,
    );
  }
  step('resolve', `${context.protocol}/${context.mode} in ${context.worktree}`);

  // --------------------------------------------------------------------
  // 2. Assemble + persist the re-orientation. THIS IS R1's ENFORCEMENT POINT.
  //
  // Everything destructive is downstream of here. A throw from assembly (R3)
  // propagates with the builder completely untouched — no message sent, no
  // keystroke written.
  // --------------------------------------------------------------------
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
    if (err instanceof ReorientationAssemblyError) {
      throw new ResetPreflightError(
        `Refusing to refresh: ${err.message} The builder has not been touched.`,
      );
    }
    throw err;
  }
  step('assemble', `${payload.inline.split('\n').length} inline lines`);

  const saveRequest = buildSaveRequest(nonce, statePath);

  // A dry run stops here, having proved the two things worth proving before a
  // real run: that assembly succeeds (R3) and what the builder would receive.
  // Zero writes reach the builder, which is what makes R1 auditable by
  // inspection rather than by trust.
  if (dryRun) {
    return {
      outcome: 'dry-run',
      steps,
      nonce,
      statePath,
      reorientPath,
      payload,
      saveRequest,
    };
  }

  fs.write(reorientPath, payload.longForm);
  step('write-reorient-file', reorientPath);

  // --------------------------------------------------------------------
  // 3. Optional pre-emptive interrupt.
  //
  // Default OFF. A builder that is reachable should be ASKED to save, not
  // interrupted first — an ESC into a working builder costs it the turn it was
  // mid-way through. This is opt-in for the case the architect already knows
  // about: a builder wedged on a foreground wait, where every queued message
  // including the save request would go unread until the turn ends.
  // --------------------------------------------------------------------
  if (interruptFirst) {
    await terminal.sendEscape();
    step('interrupt-first');
  }

  // --------------------------------------------------------------------
  // 4–5. Request the save, then gate on a VERIFIED receipt (R2).
  // --------------------------------------------------------------------
  await terminal.sendMessage(saveRequest);
  step('send-save-request', `nonce ${nonce}`);

  const receipt = await awaitReceipt({
    fs,
    clock,
    statePath,
    nonce,
    minBytes,
    stabilityWindowMs,
    pollIntervalMs,
    timeoutMs: receiptTimeoutMs,
  });

  if (receipt.status !== 'accepted') {
    // Abort with the builder's context fully intact. The state file may exist
    // and be perfectly good — it simply was not PROVEN good, and an unproven
    // save is not a basis for discarding a conversation.
    return {
      outcome: 'aborted',
      steps,
      abortReason: `Save-state receipt not verified. ${describeReceiptFailure(receipt, statePath, minBytes)}`,
      nonce,
      statePath,
      reorientPath,
      payload,
      saveRequest,
    };
  }
  step('receipt-accepted', `${receipt.bytes} bytes`);

  // --------------------------------------------------------------------
  // 6. Quiescence (R4).
  //
  // The receipt proves the file is written; it does NOT prove the turn ended.
  // A builder that wrote the file and kept working would receive `/clear` as
  // literal text mid-turn — the keystroke would land in its input buffer rather
  // than executing. Hence a real silence check.
  // --------------------------------------------------------------------
  let quiet = await awaitQuiescence({
    terminal,
    clock,
    quietWindowMs,
    timeoutMs: quiesceTimeoutMs,
    pollIntervalMs,
  });

  if (!quiet.quiet) {
    if (quiet.reason === 'terminal-gone') {
      return {
        outcome: 'aborted',
        steps,
        abortReason:
          `Builder '${context.builderId}' lost its terminal while waiting for its turn to end. ` +
          `Nothing was cleared. Its saved state is at ${statePath} — that file survives the ` +
          `terminal, so respawn with 'afx spawn <id> --resume' and point the new session at it.`,
        nonce,
        statePath,
        reorientPath,
        payload,
        saveRequest,
        stateBytes: receipt.bytes,
      };
    }

    if (quiet.reason === 'unobservable') {
      return {
        outcome: 'aborted',
        steps,
        abortReason:
          `Cannot observe terminal quiescence: this Tower does not report 'lastDataAt' ` +
          `(Spec 1273 / phase 2). Refusing to clear a builder whose turn state is unknown — ` +
          `treating "unknown" as "idle" is exactly how a mid-turn clear happens. ` +
          `Restart Tower on a current build.`,
        nonce,
        statePath,
        reorientPath,
        payload,
        saveRequest,
        stateBytes: receipt.bytes,
      };
    }

    // EXACTLY ONE escalation, and it is legal only here — after the R2 receipt.
    // Before the receipt an ESC could interrupt the very save being requested;
    // after it, the worst case is ending a turn whose valuable output is already
    // on disk.
    await terminal.sendEscape();
    step('escalate-esc');

    quiet = await awaitQuiescence({
      terminal,
      clock,
      quietWindowMs,
      timeoutMs: quiescePostEscalationTimeoutMs,
      pollIntervalMs,
    });

    if (!quiet.quiet) {
      // No third attempt, no "clear anyway". Aborting leaves a builder with its
      // context and a saved state file — recoverable. Clearing a busy builder
      // does not.
      return {
        outcome: 'aborted',
        steps,
        abortReason:
          `Builder did not go quiet within ${quiescePostEscalationTimeoutMs}ms of the ESC ` +
          `escalation. Refusing to clear a builder that is still mid-turn (R4). Its state ` +
          `file is saved at ${statePath}; retry once it settles, or raise --quiet-window.`,
        nonce,
        statePath,
        reorientPath,
        payload,
        saveRequest,
        stateBytes: receipt.bytes,
      };
    }
  }
  step('quiescent');

  // --------------------------------------------------------------------
  // 7–9. Clear, confirm best-effort, re-orient.
  // --------------------------------------------------------------------
  // Snapshot the buffer size BEFORE clearing, so confirmation can distinguish
  // the harness's response from the echo of our own keystroke.
  const totalBeforeClear = terminal.readOutput
    ? ((await terminal.readOutput())?.total ?? 0)
    : 0;

  await terminal.sendRaw('/clear');
  step('clear');

  const confirmed = await confirmClear(terminal, totalBeforeClear);
  step(confirmed ? 'clear-confirmed' : 'clear-unconfirmed');

  await terminal.sendMessage(payload.inline);
  step('send-reorientation');

  return {
    outcome: 'completed',
    steps,
    nonce,
    statePath,
    reorientPath,
    payload,
    saveRequest,
    stateBytes: receipt.bytes,
  };
}

// ============================================================================
// Gates
// ============================================================================

interface AwaitReceiptOptions {
  fs: ReceiptFsPort;
  clock: ClockPort;
  statePath: string;
  nonce: string;
  minBytes: number;
  stabilityWindowMs: number;
  pollIntervalMs: number;
  timeoutMs: number;
}

/**
 * Poll the state file until it is accepted or the wait expires.
 *
 * Returns the LAST observation rather than a boolean, so the abort message can
 * name the specific gate that failed — "wrote a 200-byte stub" and "never wrote
 * anything" call for different responses from the architect.
 */
async function awaitReceipt(options: AwaitReceiptOptions): Promise<ReceiptObservation> {
  const { fs, clock, statePath, nonce, minBytes, stabilityWindowMs, pollIntervalMs, timeoutMs } =
    options;

  const deadline = clock.now() + timeoutMs;
  let previous: ReceiptObservation | null = null;
  let previousAt = clock.now();
  let latest: ReceiptObservation = { status: 'missing' };

  for (;;) {
    const now = clock.now();
    latest = verifyReceipt({
      fs,
      statePath,
      nonce,
      minBytes,
      previous,
      msSincePrevious: now - previousAt,
      stabilityWindowMs,
    });

    if (latest.status === 'accepted') return latest;

    // Only advance the stability baseline when the gap has actually been
    // consumed. Resetting `previousAt` on every poll would make the two
    // observations always "too close together" and stability unreachable.
    if (now - previousAt >= stabilityWindowMs) {
      previous = latest;
      previousAt = now;
    }

    if (clock.now() >= deadline) return latest;
    await clock.sleep(pollIntervalMs);
    if (clock.now() >= deadline) {
      // Re-evaluate once after the final sleep so a file that landed during it
      // is not discarded on a technicality.
      const now2 = clock.now();
      latest = verifyReceipt({
        fs,
        statePath,
        nonce,
        minBytes,
        previous,
        msSincePrevious: now2 - previousAt,
        stabilityWindowMs,
      });
      return latest;
    }
  }
}

interface AwaitQuiescenceOptions {
  terminal: TerminalPort;
  clock: ClockPort;
  quietWindowMs: number;
  timeoutMs: number;
  pollIntervalMs: number;
}

type QuiescenceReason = 'timeout' | 'unobservable' | 'terminal-gone';

/**
 * Wait until the terminal has produced no output for `quietWindowMs`.
 *
 * `lastDataAt === undefined` is reported as `unobservable`, NOT as quiet. An
 * older Tower omits the field, and defaulting it to 0 would compute an age of
 * ~56 years and clear a busy builder instantly.
 */
async function awaitQuiescence(
  options: AwaitQuiescenceOptions,
): Promise<{ quiet: boolean; reason?: QuiescenceReason }> {
  const { terminal, clock, quietWindowMs, timeoutMs, pollIntervalMs } = options;
  const deadline = clock.now() + timeoutMs;

  for (;;) {
    const observation = await terminal.observe();
    // Checked BEFORE lastDataAt. A terminal that vanished mid-run also reports
    // no lastDataAt, and conflating the two sends the architect to check their
    // Tower version when the real event is that the builder's terminal died.
    // The two need different responses, so they get different reasons.
    if (!observation.exists) {
      return { quiet: false, reason: 'terminal-gone' };
    }
    if (observation.lastDataAt === undefined) {
      return { quiet: false, reason: 'unobservable' };
    }

    if (clock.now() - observation.lastDataAt >= quietWindowMs) {
      return { quiet: true };
    }

    if (clock.now() >= deadline) return { quiet: false, reason: 'timeout' };
    await clock.sleep(pollIntervalMs);
    if (clock.now() >= deadline) {
      const final = await terminal.observe();
      if (!final.exists) return { quiet: false, reason: 'terminal-gone' };
      if (final.lastDataAt === undefined) return { quiet: false, reason: 'unobservable' };
      if (clock.now() - final.lastDataAt >= quietWindowMs) return { quiet: true };
      return { quiet: false, reason: 'timeout' };
    }
  }
}

/**
 * Best-effort check that `/clear` took effect.
 *
 * Deliberately advisory. There is no reliable cross-version signal that Claude
 * Code cleared its context, and an unconfirmed clear is reported as unconfirmed
 * rather than as failure — the re-orientation that follows is correct either
 * way. The worst case of a silent no-op is a builder that kept its context and
 * also received a re-orientation, which loses nothing.
 */
async function confirmClear(terminal: TerminalPort, totalBeforeClear: number): Promise<boolean> {
  if (!terminal.readOutput) return false;
  try {
    const output = await terminal.readOutput();
    if (!output) return false;

    // Consider ONLY lines produced after the clear was sent. Everything the
    // refresh itself wrote is at or before `totalBeforeClear`, so this excludes
    // its own text by construction rather than by hoping the pattern avoids it.
    const newLineCount = output.total - totalBeforeClear;
    if (newLineCount <= 0) return false;
    const fresh = output.lines.slice(-newLineCount).join('\n');

    return /context (?:cleared|reset)|conversation (?:cleared|reset)|cleared conversation/i.test(
      fresh,
    );
  } catch {
    // Confirmation must never be able to fail the run — it is a report field.
    return false;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Reject a timing/threshold parameter that would weaken a gate.
 *
 * `Number.isFinite` rather than a bare `> 0` comparison: `NaN > 0` is false but
 * so is `NaN <= 0`, so a NaN slips through any single comparison written the
 * obvious way. Infinity is rejected too — an infinite deadline is a hang.
 */
function requirePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ResetPreflightError(
      `Invalid ${name}: ${value}. Must be a positive, finite number. ` +
        `This parameter gates a safety check (R2/R4) — a bad value would disable it silently.`,
    );
  }
}

/**
 * Resolve the state-file path, refusing anything that escapes the worktree.
 *
 * The path is handed to the builder as a write instruction, so an override of
 * `../../../etc/whatever` would have the builder write outside its own worktree.
 * Containment is checked on the resolved path, not the raw string, so `..`
 * segments cannot slip through.
 */
function resolveStatePath(worktree: string, stateFileName?: string): string {
  const candidate = stateFilePath(worktree, stateFileName);
  if (!stateFileName) return candidate;

  const normalizedWorktree = worktree.endsWith('/') ? worktree : `${worktree}/`;
  if (!candidate.startsWith(normalizedWorktree)) {
    throw new ResetPreflightError(
      `State-file override '${stateFileName}' resolves to ${candidate}, outside the builder's ` +
        `worktree (${worktree}). Refusing: the path is sent to the builder as a write instruction.`,
    );
  }
  return candidate;
}

/**
 * Render the step log as the run report.
 *
 * Each line carries its EVIDENCE, not just a tick. "Receipt accepted" alone is
 * the kind of reassurance that hides a stale file; "accepted — 8,432 bytes
 * carrying nonce a1b2c3" is checkable.
 */
export function formatResetReport(result: ResetResult): string {
  const lines: string[] = [];
  for (const s of result.steps) {
    lines.push(s.detail ? `  ✓ ${s.name} — ${s.detail}` : `  ✓ ${s.name}`);
  }
  if (result.outcome === 'aborted') {
    lines.push('');
    lines.push(`  ✗ ABORTED: ${result.abortReason}`);
    lines.push('  The builder\'s context was NOT cleared.');
  }
  return lines.join('\n');
}
