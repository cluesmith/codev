/**
 * Mailbox delivery orchestration (Spec 1313, Phase 4).
 *
 * The single gate-checked delivery path: **persist → serialize → gate → deliver |
 * hold**. Both the send request (`handleSend`, after it enqueues) and the periodic
 * backstop drainer route every GATED delivery through {@link deliverAgentMail}, so for
 * gate-checked delivery a message body reaches a PTY in exactly one place — and only
 * onto a prompt the render-gate has proven empty. This is what eliminates corruption by
 * construction for that path: a message can never fuse with a draft, because it is never
 * delivered while one exists; and there is no force path.
 *
 * TWO deliberate exceptions write a body OUTSIDE this path, both explicit human
 * gate-bypasses documented at their `tower-routes.ts` call sites: immediate `--interrupt`
 * (Ctrl+C then the message) and `--escape` (a bare ESC). They are the operator's "I am at
 * this terminal now" actions — every autonomous/scheduled/held send, by contrast, delivers
 * through this gate.
 *
 * They are no longer on a DISJOINT lock, though (Issue #1365). This path's write edge takes
 * the same per-terminal submission lock (`session-submit.ts`) those bypasses take, as a leaf
 * inside the per-agent serializer below — so a `^C`/ESC can no longer land inside a
 * delivery's own text→Enter window, clear or truncate the composer, and leave the row marked
 * `delivered` for a message the agent never saw whole. Lock order is always per-agent →
 * per-terminal; see `session-submit.ts` for the full boundary, including what the lock does
 * NOT cover.
 *
 * This module replaces the in-memory `SendBuffer` (retired in this phase): held
 * messages now live in the durable `mailbox` table, so nothing is lost to a Tower
 * crash/restart, and shutdown no longer force-flushes onto the line.
 *
 * Everything the delivery logic touches at the edges — resolving the live session
 * for an agent, resolving its classifier profile (incl. the wrapped-launch
 * fallback), running the gate, writing, broadcasting — is injected via
 * {@link DeliveryPorts}, so the orchestration is unit-testable without a live Tower.
 */

import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  findHeldForAgent,
  getById,
  listHeld,
  markDelivered,
  setHeldVerdict,
  pruneTerminal,
  findEscalatable,
  markEscalated,
  markEscalatedDelivered,
  findStarvingAgents,
} from '../db/mailbox.js';
import type { DbMailbox, MailboxGateDetail, MailboxReason } from '../db/types.js';
import type { GateProfile, GateVerdict } from './render-gate.js';
import type { PacedSubmitResult } from './message-write.js';
import { KeyedSerializer } from './write-queue.js';
import { formatVerdict, isUnverifiableVerdict } from '@cluesmith/codev-sdk/hold-verdict';

/**
 * The structural view of a live PTY session the delivery path needs. `PtySession`
 * satisfies this (ringBuffer + info getter + the Spec 1313 identity getters +
 * write); tests pass a fake. Kept minimal and structural so the module never
 * imports the terminal layer.
 */
export interface DeliverySession {
  /**
   * The live terminal/session id — the key of the per-terminal submission lock the write
   * edge takes (Issue #1365). `PtySession` already carries it; a test double MUST supply a
   * real, distinct one, and {@link submitMessagePaced} throws if it is missing rather than
   * letting every lock collapse onto a single `undefined` key.
   */
  readonly id: string;
  /**
   * The session's MONOTONE cumulative output-byte counter (Spec 1313 render-gate round 2) —
   * the gate's change token. It advances on ANY new output and NEVER decreases, so two samples
   * that match prove the classified screen is byte-for-byte unchanged. This replaces the old
   * `currentSeq:partialBytes` pair, which was non-monotone once #1205 capped the ring's partial:
   * a `trimPartial` makes `partialBytes` FALL, so two distinct screens could produce the same
   * token and alias a stale memoized verdict. The delivery path samples it around the async
   * classify to re-validate the screen hasn't moved (a keystroke landing mid-classify) before
   * writing onto it, and the drainer memoizes the gate verdict on it so a STATIC screen is
   * classified once, not re-checked every backstop tick (see {@link ringToken} and
   * {@link MailboxDrainer}). `PtySession` exposes it (sourced from `RingBuffer.bytesWritten`).
   */
  readonly bytesWritten: number;
  /**
   * Epoch ms of the session's most recent OUTPUT byte (Issue #1573 settle-before-write).
   * `PtySession` tracks it at the same chokepoint that feeds the ring and the gate mirror.
   * The delivery path requires a quiet interval here before it writes: the render gate
   * proves a screen IS a clean prompt, but says nothing about whether it is still being
   * PAINTED — a composer that repainted 1 ms ago classifies identically to one idle a
   * minute, and writing into a settling composer is what ate the leading bytes in #1521.
   */
  readonly lastDataAt: number;
  /**
   * The session's MONOTONE cumulative INPUT-change counter (Issue #1473) — the input-side twin
   * of {@link bytesWritten}, and the half of the gate's change token that a keystroke moves.
   *
   * `bytesWritten` counts OUTPUT, so until this existed a human keystroke landing in the
   * gate→write window moved nothing the gate compared: both samples agreed, the verdict stayed
   * CLEAN, and the message fused into the draft the human had started. Folding this into
   * {@link ringToken} closes that, and — the case that earns it on its own — stops a memoized
   * CLEAN verdict from being reused across a keystroke, which a token of output alone cannot
   * see because PTY input does not advance the ring.
   *
   * REQUIRED, not optional, and test doubles must supply a real number: an optional field would
   * let production compile a port that silently reads "no input ever" while presenting as a
   * working gate.
   */
  readonly inputSeq: number;
  /**
   * Epoch ms of the session's most recent HUMAN input (Issue #1473) — the input-side twin of
   * {@link lastDataAt}, and the only signal that can see input which landed BEFORE the gate
   * sampled anything and has not been echoed yet. No counter comparison can catch that case:
   * both samples agree, correctly, and the classifier reads a genuinely empty composer because
   * the character is still in flight to the TUI. `0` on a session that has never had input,
   * which reads as settled.
   */
  readonly lastInputAt: number;
  readonly info: { cols: number; rows: number };
  readonly command: string;
  readonly launchArgs: string[];
  readonly cwd: string;
  /**
   * Whether input can reach the process right now (Spec 1313 iter-1 review). A
   * shellper-backed session whose socket died still reports status 'running' until
   * teardown, and writes to it are silently dropped (#1198) — `PtySession.writable`
   * checks the live connection, not just status. The delivery path re-checks this at
   * the write instant so a torn-down PTY holds the row (spec: "an errored PTY write
   * leaves the row held") instead of being marked delivered off the paced-write timer.
   */
  readonly writable: boolean;
  write(data: string): boolean;
}

/**
 * Why a gated write abandoned inside the per-terminal lock (Issue #1365), decided by
 * {@link deliverAgentMail}'s precheck at the write instant rather than before the lock.
 */
export type WriteAbort =
  /**
   * Re-hold the row for this reason and retry on a later clean pass.
   *
   * `detail` carries the gate detail when the in-lock refusal has one to give (Issue #1473's
   * `recent-input`); absent/null keeps the detail-nulling behaviour every other refusal wants.
   * `retryAfterMs` is set only when the refusal was PURELY an input settle — see
   * {@link DeliveryOutcome.retryAfterMs}.
   */
  | { kind: 'hold'; reason: MailboxReason; detail?: MailboxGateDetail | null; retryAfterMs?: number }
  /** The row was dismissed/superseded under us — a terminal state, so it must NOT be re-held. */
  | { kind: 'row-resolved' };

/** Outcome of the gated write edge. See {@link PacedSubmitResult}. */
export type WriteResult = PacedSubmitResult<WriteAbort>;

/** Broadcast frame for a delivered message (the dashboard/inbox message event). */
export interface DeliveredBroadcast {
  type: 'message';
  from: { project?: string; agent?: string };
  to: { project: string; agent: string };
  content: string;
  metadata: { source: 'mailbox' };
  timestamp: number;
}

/** Injected edges — everything the orchestration calls into the live system through. */
export interface DeliveryPorts {
  /** The currently-live session for an agent, or null when no PTY is live (→ held `no-live-pty`). */
  getSessionForAgent(workspacePath: string, toAgent: string): DeliverySession | null;
  /** The classifier profile for a session (incl. wrapped-launch resolution), or null (→ held `no-profile`). */
  resolveProfile(session: DeliverySession): GateProfile | null;
  /**
   * The render-gate: classify the session's CURRENT screen against a profile (Spec 1313
   * render-gate round 2). The live binding reads the session's persistent {@link SessionScreen}
   * mirror and runs the classifier on its bounded viewport — no whole-ring re-render, so the
   * capped ring can no longer hand the gate a torn frame. A session with no mirror yet (no
   * output) classifies not-clean (`no-composer-marker`), exactly as an empty replay always did.
   */
  classify(session: DeliverySession, profile: GateProfile): Promise<GateVerdict>;
  /**
   * Write a formatted message (text + Enter, unless `noEnter`) to the session as ONE
   * submission on the session's per-terminal lock, and report what actually happened.
   * Resolves only once the paced write — trailing Enter included — has completed.
   *
   * The delivery `await`s it for two reasons: (1) completion chaining — the per-agent
   * serializer holds the line until the submit is entirely on the wire, so the next
   * delivery never starts mid-write; (2) the result gates markDelivered — anything but
   * `written` must never be reported as delivered (Spec 1313 integration review — the
   * silent-loss finding; Issue #1365 extended the same rule to in-lock refusals).
   *
   * `precheck` is invoked by the binding INSIDE the lock, immediately before the first
   * byte, and returning non-null aborts with nothing written. It exists because taking
   * the lock alone would only move the race: a delivery that classified a clean screen
   * and then waited behind another submission would write onto the screen that
   * submission just changed. All of the reason authority stays here in the delivery
   * module — the binding only relays the verdict.
   */
  writeMessage(
    session: DeliverySession,
    formattedMessage: string,
    noEnter: boolean,
    precheck: () => WriteAbort | null,
  ): WriteResult | Promise<WriteResult>;
  /** Emit the delivered-message broadcast frame. */
  broadcast(frame: DeliveredBroadcast): void;
  /**
   * Fire the SSE `overview-changed` event so the held-count indicator refetches (Spec
   * 1313, Phase 7). Called whenever the held SET changes via this module — a delivery
   * here removes a held row; the other transitions (hold/supersede/dismiss) fire it
   * from their own call sites. Cheap and idempotent (it only triggers a refetch), so an
   * extra fire is harmless. A no-op in unit fakes.
   */
  onHeldStateChange(): void;
  /**
   * Fire the SSE `mailbox-escalation` event when a held row crosses the escalation age
   * (Spec 1313, Phase 7). VISIBILITY ONLY — the caller never delivers as a result. A
   * no-op in unit fakes.
   */
  onEscalation(info: EscalationInfo): void;
  /**
   * Raise the liveness-telemetry diagnostic when an agent's mail has been held
   * `no-profile` for a sustained streak (Spec 1313, Phase 7 — spec line 91). The pure
   * module just reports the streak crossing; the live binding applies the spec's "with
   * recent output" condition (only a session actively producing output is a genuinely
   * broken/unknown classifier worth alarming) and does the loud log + broadcast. A
   * no-op in unit fakes.
   */
  onLiveness(info: LivenessInfo): void;
  /**
   * Raise a starvation notice to a starving NON-architect agent's OWNER (Spec 1313 round 3,
   * change 3). Fired once per episode when the agent's oldest eligible held row has been stuck
   * past the owner-notice threshold. The live binding resolves the recipient architect
   * (spawning → workspace `main` → first-registered, mirroring `afx send architect`), skips
   * agents that are themselves architects (a notice would land in the same starved mailbox —
   * `afx status` covers that), and enqueues ONE coalesced (supersede-keyed), gate-delivered
   * mailbox row — never a force path. OPTIONAL: unit fakes that don't exercise the notice omit
   * it, so the drainer calls it via `?.`.
   *
   * RETURNS `true` iff a notice was actually enqueued; `false` on a no-op (recipient is itself
   * an architect, or no architect is registered yet). The drainer only records the agent as
   * notified on `true` — a no-op must NOT arm the once-per-episode guard, or the alarm would be
   * suppressed for the whole episode even after an architect later registers (it retries each
   * tick until one enqueues).
   */
  escalateHeldToOwner?(info: HeldOwnerNoticeInfo): boolean;
  /**
   * Clear (dismiss) any pending owner notice for an agent whose eligible held set has drained
   * (Spec 1313 round 3) — the starvation is over, so the alarm is moot. A no-op on an
   * already-delivered notice. OPTIONAL, like {@link escalateHeldToOwner}.
   */
  clearHeldOwnerNotice?(workspacePath: string, toAgent: string): void;
  /**
   * Begin watching for evidence that a message actually LANDS on the receiving terminal
   * (Issue #1573). Called with the normalized needle from {@link echoNeedle} immediately
   * BEFORE the write; the returned {@link EchoWatch} is consulted AFTER `markDelivered`
   * (Issue #1584 — the delivery is committed first, so verification cannot leave the row in a
   * re-writable state), and its answer becomes the `verified` report, not a retry decision.
   *
   * This is the only end-to-end evidence the delivery path has. Everything upstream of it
   * proves the bytes were QUEUED, never that the terminal absorbed them: `session.write`
   * returns true whenever the socket object is connected, so a receiving composer that ate
   * the leading bytes (#1564) still produced a clean `written`, and the row was marked
   * delivered for a message the agent never saw whole.
   *
   * Split into watch-then-verify rather than a single after-the-fact check because mere
   * PRESENCE of the header proves nothing (CMAP round 1 — codex): a prior attempt's echo
   * sits in the same scrollback, so a redelivery whose bytes were swallowed would match the
   * copy the FIRST attempt left behind and be certified. The watch samples what the screen
   * already showed, so verification can require evidence the write itself produced.
   *
   * DELIBERATELY NARROW: presence of the header line, nothing else. No screen diffing, no
   * repair, no per-harness branches. A negative therefore means "could not confirm", not
   * "definitely lost".
   *
   * What the caller does with a negative CHANGED in Issue #1584: it no longer holds the row for
   * redelivery. The bytes are already out, so a redelivery is a re-injection — and because the
   * residuals below recur for the same message every time, holding produced an unbounded loop
   * (#1583). The row is committed as delivered, flagged `escalated`, and reported to the sender
   * as `verified: false`. This watch is evidence for a REPORT, never a retry decision.
   */
  watchEcho(session: DeliverySession, needle: string): Promise<EchoWatch>;
  /**
   * Raise a human-visible notice for a delivery whose write completed but whose echo never
   * confirmed (Issue #1584). The row is marked `delivered` + `escalated`, and a DELIVERED row
   * is invisible to every held-scoped surface — `afx inbox`, the held-count indicator,
   * `heldSummaryForWorkspace` — so without this the only trace of an unconfirmed delivery is a
   * log line. That is fine for an interactive `afx send` (the sender gets `verified: false`)
   * and not fine for a cron or backstop delivery, which has no sender waiting.
   *
   * Deliberately NOT `onEscalation`: that event means "held past the escalation age" and its
   * binding says so in its title, which would be a false statement about a delivered row.
   *
   * Metadata only (no message body), per the spec's redaction rule. OPTIONAL, so unit fakes
   * that do not exercise it may omit it.
   */
  onUnverifiedDelivery?(info: UnverifiedDeliveryInfo): void;
  /**
   * Tower log line. `level` defaults to `INFO`; the delivery path passes `WARN` for the one
   * case an operator must be able to find after the fact — a delivery whose echo never
   * confirmed (Issue #1584), which is recorded as delivered rather than re-written.
   */
  log(message: string, level?: 'INFO' | 'WARN'): void;
  now(): number;
}

/**
 * Metadata for a starving agent whose owner should be alarmed (Spec 1313 round 3, change 3).
 * Carries NO message body (metadata only, per the redaction rule) — the live binding formats a
 * human notice naming the agent, its held count, how long it has been stuck, and the remedy.
 */
export interface HeldOwnerNoticeInfo {
  /** The starving agent's workspace (the notice is enqueued within it). */
  workspacePath: string;
  /** The starving NON-architect agent (a builder id). */
  toAgent: string;
  /** Its current why-held reason (busy/no-profile/no-live-pty), if the gate set one. */
  reason: MailboxReason | null;
  /**
   * The gate detail behind a `busy` reason (Issue #1482), if one is recorded. This is what
   * decides WHICH notice the owner gets: `user-text` means a human is legitimately at the
   * composer (it will clear when they finish), while `no-region-end`/`no-composer-marker`
   * means the classifier cannot verify the composer at all and the mail will never deliver
   * on its own. Different situations, different remedies, so different wording.
   */
  detail: MailboxGateDetail | null;
  /** How long the oldest eligible held row has been stuck, in ms. */
  ageMs: number;
  /** How many eligible held rows are backed up for the agent. */
  heldCount: number;
  /**
   * How many CONSECUTIVE not-clean gate checks this agent's mail has seen (Issue #1482) — the
   * drainer's existing per-agent streak, not new state. It turns "held ~7m" into "held ~7m,
   * re-confirmed across 41 checks", which is the difference between a plausible pause and a
   * composer that is genuinely, continuously occupied. 0 when no streak is being tracked
   * (e.g. a notice pass on a Tower that just restarted).
   */
  streak: number;
}

/**
 * A sustained `no-profile` hold streak for an agent — carried to the liveness-telemetry
 * binding (Spec 1313, Phase 7). Metadata only (no body): the diagnostic names the agent
 * and how many consecutive checks failed to classify, so a broken/unknown classifier is
 * discoverable rather than silent.
 */
export interface LivenessInfo {
  workspacePath: string;
  toAgent: string;
  /** Consecutive not-clean (`no-profile`) checks at the moment the streak crossed the threshold. */
  streak: number;
}

/**
 * Metadata for a delivery that completed its write but could not be confirmed on the receiving
 * terminal (Issue #1584). Ids and addresses only — no message body, per the spec's redaction
 * rule — since this rides the SSE bus to the dashboard's notification surface.
 */
export interface UnverifiedDeliveryInfo {
  workspacePath: string;
  toAgent: string;
  mailboxId: string;
  /** The terminal the bytes were written to, for correlating against its transcript. */
  terminalId: string;
  /**
   * Why it could not be confirmed (Issue #1473) — the notification text branches on it, since
   * "its header never appeared on that screen" is a false statement about a delivery whose
   * header DID appear and whose tail was eaten by a human keystroke.
   */
  cause: UnverifiedCause;
}

/**
 * Metadata for a held row that has crossed the escalation age. Carries NO message body
 * (ids + metadata only, per the spec's redaction rule) — this rides the SSE bus to the
 * dashboard/VSCode indicator, which is count/attention only.
 */
export interface EscalationInfo {
  workspacePath: string;
  toAgent: string;
  mailboxId: string;
  /** How long the row had been held when it escalated, in ms. */
  ageMs: number;
  reason: MailboxReason | null;
  /**
   * The gate detail behind a `busy` reason (Issue #1482), read off the row. Null for a
   * non-gate hold. Carried onto the SSE payload so a dashboard/VSCode toast can say WHY the
   * row is stuck, not merely that it is.
   */
  detail: MailboxGateDetail | null;
}

/**
 * A hold's diagnostic detail as this module reports it: the render gate's own verdict details,
 * plus `'recent-input'` (Issue #1473), which no classifier produces — it is decided by the
 * delivery path from the session's input signals, not from anything on the screen.
 *
 * Both halves stay inert in {@link isUnverifiableVerdict} by construction: that predicate is an
 * allow-list of the two can't-verify details, so a value it does not name can never escalate.
 * `'recent-input'` must stay outside it — it is the same self-clearing "a human is at the line"
 * class as `user-text`, and escalating it would false-alarm on every ordinary typist.
 */
export type DeliveryDetail = GateVerdict['detail'] | 'recent-input';

/** Outcome of one delivery pass over an agent's held mail. */
export interface DeliveryOutcome {
  /** Row ids delivered this pass — 0 or 1 (one message per clean gate; its Enter makes the line busy). */
  delivered: string[];
  /** When nothing was delivered, why the agent's mail stays held; null if delivered or the mailbox was empty. */
  reason: MailboxReason | null;
  /**
   * Issue #1584: whether the delivered message's header was actually SEEN on the receiving
   * terminal. Present only when a delivery happened AND the message had a needle worth
   * matching ({@link echoNeedle}) — `true` when the echo confirmed, `false` when it did not.
   * Absent means verification was skipped (a body with no distinctive first line) or nothing
   * was delivered, and reads exactly as it did before this field existed.
   *
   * A `false` is "could not confirm", never "definitely lost". The row is delivered and
   * flagged `escalated` either way, because a completed write must never be re-written — the
   * #1573 hold-and-redeliver it replaces is what re-injected one message dozens of times
   * (#1583). This field is how the sender is told, instead.
   */
  verified?: boolean;
  /**
   * The gate's internal detail when a `busy` hold came from the render-gate (Spec 1313
   * render-gate hardening) — telemetry only. Distinguishes a legitimately-occupied line
   * (`user-text`, a human present) from a classifier that CANNOT verify the composer
   * (`no-region-end`/`no-composer-marker` = a drifted profile or an unrenderable frame),
   * which {@link MailboxDrainer.recordStreak} escalates to liveness telemetry. Absent
   * for non-gate holds (`no-live-pty`/`no-profile`) and deliveries.
   */
  detail?: DeliveryDetail;
  /**
   * Why a completed delivery could not be confirmed (Issue #1473). Present only alongside a
   * delivery that was flagged — absent means confirmed, or not verifiable in the first place.
   *
   *   - `'input-raced'` — human input landed on the terminal DURING the paced write, so the
   *     body may have been truncated (`^U`/`^W`/`^C`) or submitted early (their Enter);
   *   - `'no-echo'` — the write completed but the message's header never appeared on screen.
   *
   * `'input-raced'` WINS when both are true: it names the more actionable remedy, and a missing
   * echo is often just the downstream symptom of the race.
   *
   * Deliberately NOT overloaded onto {@link verified}, which would make one field mean two
   * different things — and the input-raced case frequently has `verified: true` (the header did
   * land; it was the tail that was lost), which is exactly why the sender was being told plain
   * "Message delivered" for it.
   */
  unverifiedCause?: UnverifiedCause;
  /**
   * Present only when this pass held SOLELY because the terminal had recent input (Issue #1473)
   * — the ms after which {@link inputSettled} would pass. The drainer arms one coalesced,
   * generation-guarded re-drain for it, so the row delivers roughly one settle after the typing
   * stops rather than on the next 1.5 s backstop tick.
   *
   * It is not a speculative optimisation: the `'submit'` fast trigger fires SYNCHRONOUSLY from
   * `stopComposing`, and the drain it schedules runs in a microtask — so at that pass
   * `lastInputAt` is always `now`, and the submit trigger is now provably always held. Without
   * the re-drain, pressing Enter to clear the line would reliably cost a full backstop period.
   * It also shortens the escalation-blind hold below from "forever" to "one settle".
   */
  retryAfterMs?: number;
}

/**
 * Why a committed delivery is flagged unconfirmed (Issue #1473) — carried to every operator
 * surface, the SENDER included. Before this, `tower-routes` surfaced only `verified` and the
 * CLI warned only on `verified === false`, so the truncation case this exists for — where the
 * header landed and `verified` is `true` — reported an unqualified success to the one human who
 * was standing there.
 */
export type UnverifiedCause = 'no-echo' | 'input-raced';

/**
 * A gate outcome the render gate CANNOT bound to a decision — an unrecognized app
 * (`no-profile`) or a recognized app whose composer region can't be found
 * (`no-region-end`/`no-composer-marker` = a drifted TUI layout or an unrenderable #1047
 * ring). A sustained streak of these means the mail will NEVER deliver on its own, so it
 * is the class {@link MailboxDrainer.recordStreak} escalates to liveness telemetry; a
 * `busy`/`user-text` streak is deliberately excluded (a human legitimately at the line).
 * Shared by `recordStreak` and the cooldown branch of {@link MailboxDrainer.tick} so a
 * skipped tick and a real pass agree on what counts as classifier-stuck (CMAP round 3).
 *
 * This is the POLICY-side name for the same question `isUnverifiableVerdict` answers for the
 * presentation surfaces, so it delegates rather than restating the rule (maintainer review,
 * PR #1604). Two copies of "which verdicts never clear on their own" is one edit away from an
 * escalation policy and an operator-facing remedy disagreeing about the same row. The wrapper
 * is kept rather than collapsed to a single function because the two callers want different
 * types: this one is typed on the DB/gate unions and reads naturally beside the escalation
 * policy it serves, while the shared predicate takes the plain strings the CLI, the dashboard
 * and the VS Code toast actually hold.
 */
function isClassifierStuck(
  reason: MailboxReason | null,
  detail: DeliveryDetail | undefined
): boolean {
  return isUnverifiableVerdict(reason, detail);
}

/**
 * How long the receiving session's screen must have been QUIET before a gated delivery may
 * write onto it (Issue #1573).
 *
 * The render gate answers "is this a clean prompt?" and nothing else — it has no stability
 * requirement, so a composer captured 1 ms into its post-turn repaint passes exactly like one
 * idle for a minute. Writing into that window is how #1521's leading bytes were eaten
 * (`[USER via VS Code]` arriving as `ER via VS Code`). The quiescence drain trigger happened to
 * be safe because it only fires after an output-idle debounce; the request path (`handleSend`'s
 * immediate delivery attempt) and the `'submit'` fast trigger had no such gap. This gives all
 * three the same floor.
 *
 * A hold here is cheap and self-correcting: the backstop drainer retries on its existing
 * schedule, so the cost of being early is at most one tick of latency.
 */
export const SETTLE_BEFORE_WRITE_MS = 250;

/**
 * A pre-write sample of the receiving terminal, plus the confirmation that the write added
 * something to it (Issue #1573). Returned by {@link DeliveryPorts.watchEcho}.
 */
export interface EchoWatch {
  /**
   * Did the message's header appear on the terminal as a result of the write this watch was
   * opened for? Bounded — it waits a short interval and then answers false, which the caller
   * treats as "could not confirm" and REPORTS (Issue #1584): the row is delivered and flagged,
   * never re-written. Callable more than once; each call opens a fresh window against the same
   * pre-write sample, and the delivery path uses a second one to give a slow renderer more time
   * without putting a byte on the line.
   */
  verify(): Promise<boolean>;
}

/**
 * Has the session's screen been quiet long enough to write onto (Issue #1573)?
 *
 * Phrased as a positive `>=` rather than a negated `<` so that a session carrying no usable
 * timestamp — the comparison yields NaN, and every NaN comparison is false — reads as NOT
 * settled and holds. An unknown screen age is exactly the case that must not be written into.
 */
function settled(ports: DeliveryPorts, session: DeliverySession): boolean {
  return ports.now() - session.lastDataAt >= SETTLE_BEFORE_WRITE_MS;
}

/**
 * How long the receiving session must have been free of HUMAN INPUT before a gated delivery
 * may write onto it (Issue #1473) — the input-side counterpart of {@link SETTLE_BEFORE_WRITE_MS}.
 *
 * The change token catches input that arrives after the gate sampled it. It cannot catch input
 * that arrived just BEFORE the sample and has not been echoed yet: nothing has moved, both
 * samples agree — correctly — and the classifier reads a genuinely empty composer while the
 * character is still travelling to the TUI. Only elapsed time can see that.
 *
 * One notch above the output settle because the round trip it covers is strictly the longer
 * one: an echo has to reach the TUI, be processed, be painted, and come back as output, whereas
 * the output settle only waits for painting to stop.
 *
 * **This BOUNDS the echo-lag window; it does not close it.** Input older than this interval
 * whose echo is still delayed, and input in flight from the browser at sample time, both
 * survive by construction. A larger constant buys coverage at the price of latency on every
 * delivery, which is why the next tightening (if measurement wants one) is a BOUNDED
 * `lastInputAt > lastDataAt` hold rather than a bigger number here.
 */
export const INPUT_SETTLE_BEFORE_WRITE_MS = 300;

/**
 * Has the session been free of human input long enough to write onto (Issue #1473)?
 *
 * Positive `>=` for the same reason {@link settled} is: a session carrying no usable timestamp
 * yields NaN, every NaN comparison is false, and an unknown input age must read as NOT settled.
 */
function inputSettled(ports: DeliveryPorts, session: DeliverySession): boolean {
  return ports.now() - session.lastInputAt >= INPUT_SETTLE_BEFORE_WRITE_MS;
}

/**
 * How long until {@link inputSettled} would pass, in ms — what the drainer arms its one-shot
 * re-drain for (Issue #1473). Clamped at 0 so a clock skew can never schedule into the past.
 */
function msUntilInputSettled(ports: DeliveryPorts, session: DeliverySession): number {
  const remaining = INPUT_SETTLE_BEFORE_WRITE_MS - (ports.now() - session.lastInputAt);
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

/**
 * Minimum length of a normalized {@link echoNeedle} for it to be worth matching. Below this a
 * needle is not distinctive enough to prove anything — a two-character raw message would match
 * incidental screen text and turn verification into a rubber stamp. Short raw sends therefore
 * skip verification (today's behavior) rather than being confirmed by an accident.
 */
const MIN_ECHO_NEEDLE_LENGTH = 12;

/**
 * Reduce text to its alphanumeric skeleton for echo matching (Issue #1573).
 *
 * Matching the header line literally does not survive contact with real harnesses. Measured
 * 2026-09-01 against live PTYs: claude echoes `### [ARCHITECT INSTRUCTION | <ts>] ###`
 * verbatim into its composer, then — once the message is SUBMITTED — re-renders it as
 * `[ARCHITECT INSTRUCTION | <ts>]`, the `###` fences consumed as a markdown H3. codex keeps the
 * fences. Dropping every non-alphanumeric byte makes both forms the same string, and
 * incidentally absorbs the other three ways a TUI mangles a line it is only *displaying*: a
 * `> `/`❯ ` quote prefix, indentation, and wrapping at the viewport width (line breaks vanish
 * with everything else, so a header split across two rows still matches).
 *
 * It is a presence probe, not a fidelity check — it deliberately cannot tell you the body
 * arrived intact, only that the head of the message reached the screen.
 */
export function normalizeForEcho(text: string): string {
  return text.replace(/[^A-Za-z0-9]/g, '');
}

/**
 * The needle {@link DeliveryPorts.watchEcho} opens on: the formatted message's FIRST line,
 * normalized. Returns `''` when it is too short to be distinctive (see
 * {@link MIN_ECHO_NEEDLE_LENGTH}), which the caller reads as "skip verification".
 *
 * The first line and only the first line. A formatted send puts its `### [ARCHITECT
 * INSTRUCTION | <iso timestamp>] ###` header there — long, and unique per message thanks to the
 * timestamp. The TAIL would be the easier thing to find on a scrolled screen and is exactly the
 * wrong choice: #1564's message arrived as its FINAL ~30 characters, so a footer needle would
 * have certified the very corruption this check exists to catch.
 */
export function echoNeedle(formattedMessage: string): string {
  const needle = normalizeForEcho(formattedMessage.split('\n', 1)[0]);
  return needle.length >= MIN_ECHO_NEEDLE_LENGTH ? needle : '';
}

/**
 * Composite key identifying an agent within a workspace, used to dedupe the
 * backstop's per-agent work and to key the liveness-telemetry streak map (which
 * Phase 7 consumes). Joined on a NUL — a byte that can appear in neither a
 * filesystem path nor an agent id — so the key is collision-proof (a space
 * separator would be ambiguous for paths/ids that contain spaces). Kept explicit
 * (visible `\0`) and shared so callers never hand-roll the separator.
 */
export function agentKey(workspacePath: string, toAgent: string): string {
  return `${workspacePath}\0${toAgent}`;
}

/**
 * A cheap, MONOTONE token of the session's rendered state plus the classify inputs
 * (dimensions + resolved app). `bytesWritten` advances on ANY new output and never falls
 * (Spec 1313 render-gate round 2 — the fix for the non-monotone `currentSeq:partialBytes`
 * pair, which aliased once #1205's partial trim made `partialBytes` decrease), and the
 * geometry catches a resize that reflows the screen without new output. So two samples that
 * match mean the classified screen is byte-for-byte unchanged. Two consumers rely on that:
 *   1. gate→write TOCTOU re-validation — sampled before the async classify and re-checked
 *      after, so a keystroke landing during the classify holds instead of writing onto the
 *      new draft;
 *   2. the drainer's verdict memo ({@link CachedVerdict}) — a cached verdict is reused only
 *      while this token is unchanged, so a static screen is classified once instead of
 *      re-checked every 1.5 s backstop tick.
 *
 * `inputSeq` is the INPUT half (Issue #1473), and neither consumer worked without it:
 *
 *   - **The memo (this one earns the counter on its own).** A `CachedVerdict` survives across
 *     backstop ticks, so the gap between the cached classify and its reuse is bounded by no
 *     settle at all. Without an input term a CLEAN verdict is reusable ACROSS a keystroke —
 *     PTY input never advances the ring, so the output token is genuinely unchanged. That is
 *     the caveat this module used to admit in a comment and now closes.
 *   - **Unbounded awaits inside the gate→write gap.** `tokenBefore` is sampled before
 *     `ports.classify` AND before `ports.watchEcho`, the latter flushing the mirror parser and
 *     scanning up to 1000 lines. Neither is bounded by the input-settle interval on a loaded
 *     box, so "the settle covers it" is not true.
 *
 * (The delivery's OWN paced write is excluded by construction — it writes with the `'delivery'`
 * origin, which moves no input signal — so folding this in cannot make a delivery block itself.)
 *
 * Monotonicity, precisely: the TOKEN is not globally monotone (geometry and app can change back
 * and forth), but both COUNTERS in it are, and that plus {@link CachedVerdict}'s session-identity
 * guard is what makes non-aliasing hold.
 */
function ringToken(session: DeliverySession, profile: GateProfile): string {
  return `${session.bytesWritten}:${session.inputSeq}:${session.info.cols}x${session.info.rows}:${profile.app}`;
}

/**
 * A gate verdict cached against BOTH the live session instance and the {@link ringToken}
 * that produced it (Spec 1313 render-gate verdict memo). Reuse requires the SAME session
 * object AND an unchanged token, so a cached verdict can never be served for a screen that
 * has moved. The `session` guard closes the RESPAWN route: a replacement `PtySession` for the
 * same `agentKey` starts a fresh `bytesWritten` at 0 and could transiently reproduce a low
 * token value — but it is a DIFFERENT object, so `cached.session === session` misses. (The old
 * `RingBuffer.clear()`-during-teardown aliasing route — which left `currentSeq` untouched while
 * wiping content — is now closed by the token itself: `bytesWritten` is monotone and `clear()`
 * does NOT reset it, so a cleared ring's token can only advance, never collide with a prior
 * value; the `!session.writable` filter still keeps a torn-down session out of the memo anyway.)
 * CMAP round 1/2: Gemini/Codex/Claude. Holding the session pins it for at most one tick (the
 * drainer prunes to the held-agent set each tick).
 * Keyed/bounded by {@link MailboxDrainer}; see {@link deliverAgentMail}.
 */
interface CachedVerdict {
  session: DeliverySession;
  token: string;
  verdict: GateVerdict;
}

/** Reconstruct the delivered-message broadcast frame from a persisted row. */
export function broadcastForRow(row: DbMailbox, now: number): DeliveredBroadcast {
  return {
    type: 'message',
    from: {
      project: row.from_workspace ? path.basename(row.from_workspace) : undefined,
      agent: row.from_agent ?? undefined,
    },
    to: { project: path.basename(row.workspace_path), agent: row.to_agent },
    content: row.body,
    metadata: { source: 'mailbox' },
    timestamp: now,
  };
}

/**
 * Run one delivery pass for a single agent against the live gate.
 *
 * Delivers the **oldest** held message when — and only when — the composer is a
 * render-verified empty prompt; the rest wait for the next clean gate (the just-
 * delivered message's Enter submits and makes the line busy, so at most one lands
 * per pass — never a blob). When it cannot deliver, it refreshes every held row's
 * `reason` to the current gate verdict so `afx inbox` and the send response stay
 * accurate. Idempotent and race-safe: `markDelivered` only transitions a still-held
 * row, so a backstop tick racing a request-path delivery can never double-send.
 */
export async function deliverAgentMail(
  ports: DeliveryPorts,
  db: Database.Database,
  workspacePath: string,
  toAgent: string,
  memo?: Map<string, CachedVerdict>
): Promise<DeliveryOutcome> {
  // Spec 1313 round 3: ELIGIBLE held rows only — a pre-due delayed send (`not_before > now`)
  // is excluded, so it neither delivers early nor blocks a later normal message. An agent
  // whose only mail is pre-due looks "empty" here (reason null → not stuck), and the row
  // becomes eligible on the first pass at/after its due time (backstop granularity is fine —
  // the delay is a lower bound).
  const held = findHeldForAgent(db, workspacePath, toAgent, ports.now());
  if (held.length === 0) return { delivered: [], reason: null };

  // Every NON-gate hold, plus the post-classify re-holds (token moved / not settled). `detail`
  // defaults to null (Issue #1482): a detail describes a gate verdict, and holding for
  // `no-live-pty` — or re-holding a screen that moved under us — is not one. Leaving the
  // previous detail in place would let `afx inbox` keep asserting "a human is at the composer"
  // about a session whose PTY has since died.
  //
  // The one caller that passes a detail is the input hold (Issue #1473). It needs one because
  // `hold('busy')` with a null detail is invisible to #1482's whole diagnostic axis AND to
  // `isClassifierStuck`, which excludes plain `busy` — so an input hold that RECURRED (an app
  // polling geometry every repaint, say, whose reply this module failed to recognise) would
  // hold indefinitely with nothing to escalate it and nothing on any surface saying why. With
  // the detail, `afx inbox` and the send response read `busy:recent-input` through the existing
  // shared formatter, no formatter change required.
  const hold = (reason: MailboxReason, detail: MailboxGateDetail | null = null): DeliveryOutcome => {
    for (const row of held) {
      if (row.reason !== reason || row.detail !== detail) setHeldVerdict(db, row.id, reason, detail, ports.now());
    }
    return { delivered: [], reason, ...(detail ? { detail } : {}) };
  };

  const session = ports.getSessionForAgent(workspacePath, toAgent);
  if (!session) return hold('no-live-pty');

  const profile = ports.resolveProfile(session);
  if (!profile) return hold('no-profile');

  /** {@link hold} for the input-settle case, carrying the drainer's one-shot re-drain delay. */
  const holdOnInput = (): DeliveryOutcome => ({
    ...hold('busy', 'recent-input'),
    retryAfterMs: msUntilInputSettled(ports, session),
  });

  // Sample the ring's change-token BEFORE the (possibly memoized) classify, so we can
  // re-validate afterward that the screen didn't move under us (below).
  const tokenBefore = ringToken(session, profile);
  // …and the input counter alone, so a token that moved can be ATTRIBUTED (Issue #1473). The
  // token folds output and input together, and a re-hold that blamed a repaint on the human at
  // the keyboard would put a false `recent-input` on every surface that reads the row.
  const inputSeqBefore = session.inputSeq;

  // Verdict memo (Spec 1313 render-gate follow-up). The 1.5 s backstop re-checks every held
  // agent's screen each tick; for a STATIC screen that classify is pure waste. Reuse the
  // cached verdict while BOTH the live session instance AND the token are unchanged — the token
  // advances on ANY new output, so a match means the screen is byte-for-byte what we already
  // classified, and the session guard closes the PTY-respawn aliasing route (a replacement
  // session is a DIFFERENT object); the monotone token closes the old `RingBuffer.clear()` route
  // (see {@link CachedVerdict}). A memo hit does NO await, so the post-classify re-validation
  // below (`ringToken(...) !== tokenBefore`) passes trivially: no keystroke can land in a
  // classify window that never opened. The memo is owned + bounded by the drainer's backstop
  // {@link MailboxDrainer.tick} (pruned to the held-agent set each tick); every OTHER caller —
  // the request/cron paths and the fast scheduleDrain trigger — passes none and classifies
  // fresh, so an event-driven re-check is never served a cached verdict.
  const cacheKey = agentKey(workspacePath, toAgent);
  const cached = memo?.get(cacheKey);
  let verdict: GateVerdict;
  if (cached && cached.session === session && cached.token === tokenBefore) {
    verdict = cached.verdict;
  } else {
    verdict = await ports.classify(session, profile);
    memo?.set(cacheKey, { session, token: tokenBefore, verdict });
  }

  if (!verdict.clean) {
    // Carry the gate detail so a sustained classifier-stuck streak (a drifted profile
    // or an unrenderable frame) escalates to liveness telemetry instead of holding silently.
    const reason = verdict.reason ?? 'busy';
    // `empty` is the CLEAN detail and cannot reach here (a clean verdict does not take this
    // branch); narrowing it away keeps the persisted set to the three not-clean values the
    // column's type admits.
    const detail = verdict.detail === 'empty' ? null : verdict.detail;
    for (const row of held) {
      if (row.reason !== reason || row.detail !== detail) {
        setHeldVerdict(db, row.id, reason, detail, ports.now());
      }
    }
    return { delivered: [], reason, detail: verdict.detail };
  }

  // Re-validate the SCREEN before writing (Spec 1313 render-gate diff review). The classify
  // above may have awaited (the mirror flushes its parser, and xterm yields between parse
  // slices); if the screen advanced since we sampled `tokenBefore`, a draft may have started
  // under us and the clean verdict is now stale. Writing then would fuse the message into that
  // draft — the exact false-clean the gate prevents. Hold instead; it delivers on the next
  // clean tick. (On a memo hit no await occurred, so the token is unchanged and this passes
  // trivially.)
  // (The token now carries `inputSeq` too, so this same comparison is what catches a HUMAN
  // KEYSTROKE landing during the classify — Issue #1473. Before that term it caught only the
  // app's own repaints, and a keystroke moved nothing it compared. The detail names whichever
  // half actually moved; blaming a repaint on the human would be a false statement on every
  // surface that reads the row.)
  if (ringToken(session, profile) !== tokenBefore) {
    return session.inputSeq !== inputSeqBefore ? hold('busy', 'recent-input') : hold('busy');
  }

  // Settle-before-write (Issue #1573). A clean verdict says the composer is EMPTY, not that it
  // has finished being drawn. Require a quiet interval since the session's last output byte
  // before putting anything on the line; see {@link SETTLE_BEFORE_WRITE_MS}. Re-checked inside
  // the per-terminal lock below, because that is where the last byte before ours can land.
  if (!settled(ports, session)) return hold('busy');

  // Input-settle (Issue #1473). The token above sees input that arrived AFTER we sampled it;
  // this sees input that arrived just BEFORE and has not been echoed yet — nothing moved, both
  // samples agree, and the classifier read a genuinely empty composer while the character was
  // still in flight. Only elapsed time can catch that. Re-checked in the lock below for the
  // same reason the output settle is.
  if (!inputSettled(ports, session)) return holdOnInput();

  // Clean, verified-empty prompt → deliver the oldest held message. Await the
  // write's paced completion so a serialized follow-up delivery never begins
  // until this message's text + Enter is fully on the wire.
  const row = held[0];

  // Re-validate at the delivery instant (Spec 1313 iter-1 review, Codex). The held
  // list and the gate verdict were read before this point, and dismiss/supersede are
  // independent DB writes NOT routed through the per-agent delivery serializer — so a
  // resolve that landed in the gate→write window must not still put bytes on the wire.
  // better-sqlite3 is synchronous, so this re-read reflects any dismiss/supersede
  // committed up to now; the irreducible residual (a resolve during the paced write
  // itself) is the accepted gate→write race in the spec's Risks table.
  const current = getById(db, row.id);
  if (!current || current.status !== 'held') {
    ports.onHeldStateChange(); // the held set changed under us → refresh the indicator
    return { delivered: [], reason: null };
  }

  // Fast-path an already-dead session (#1198: a dead shellper socket still reports
  // status 'running', and its writes are dropped). This t=0 precheck avoids a pointless
  // paced write when the PTY is unwritable before we even start; it is NOT the whole
  // guard — a socket that dies DURING the paced text→…→Enter sequence is invisible here
  // and surfaces instead as a dropped-write `false` from writeMessage (handled below).
  // Either way the row is held ("an errored PTY write leaves the row held"), never marked
  // delivered off the paced-write timer.
  if (!session.writable) return hold('no-live-pty');

  // Re-validate EVERYTHING at the write instant, inside the per-terminal lock (Issue #1365).
  // The three checks above (screen unchanged, session writable, row still held) were made
  // before the lock; between them and the first byte another writer may hold the terminal,
  // and this delivery may have waited. Without this, routing the write through the lock would
  // merely relocate the race it exists to close: a delivery could write onto a screen that an
  // `--interrupt`/`--escape` had just cleared. Cheap enough to repeat — a synchronous ring
  // read and one indexed better-sqlite3 lookup.
  //
  // Issue #1473 narrowed the residual this block used to describe. `ringToken` now carries
  // `inputSeq` as well as `bytesWritten`, so input from a writer that does NOT take this lock —
  // the raw `/api/terminals/:id/write` passthrough, a human's keystrokes over the WebSocket, the
  // delayed `^C` — moves the token even while it sits un-echoed on the line, and the
  // `inputSettled` check below covers input that landed before we sampled. What SURVIVES, and
  // must not be claimed closed:
  //
  //   • input older than the input-settle interval whose echo is still delayed, and input in
  //     flight from the browser at sample time — the settle bounds this window, it does not
  //     close it;
  //   • an `afx attach` client entirely: it speaks to the shellper socket directly and never
  //     touches `PtySession`, so neither its input nor its terminal's replies are observed here;
  //   • a reply shape `stripTerminalReplies` does not recognise, which counts as input — a
  //     spurious hold, now visible as `busy:recent-input` rather than silent;
  //   • a race DURING the paced write, which is reported (`racedByInput`) rather than prevented,
  //     because by then the bytes are already out.
  const precheck = (): WriteAbort | null => {
    if (!session.writable) return { kind: 'hold', reason: 'no-live-pty' };
    if (ringToken(session, profile) !== tokenBefore) {
      // Attribute it: `recent-input` only when the INPUT half is what moved (see the sampling
      // of `inputSeqBefore`); a repaint re-holds with the plain, detail-less `busy`.
      const detail = session.inputSeq !== inputSeqBefore ? ('recent-input' as const) : null;
      return { kind: 'hold', reason: 'busy', detail };
    }
    if (!settled(ports, session)) return { kind: 'hold', reason: 'busy' };
    if (!inputSettled(ports, session)) {
      return {
        kind: 'hold',
        reason: 'busy',
        detail: 'recent-input',
        retryAfterMs: msUntilInputSettled(ports, session),
      };
    }
    const stillHeld = getById(db, row.id);
    if (!stillHeld || stillHeld.status !== 'held') return { kind: 'row-resolved' };
    return null;
  };

  // Open the echo watch BEFORE the write (Issue #1573). It samples what the terminal already
  // shows, so the check after the write can require evidence THIS write produced rather than
  // accepting a copy an earlier attempt left in scrollback. Null when the message has no
  // header distinctive enough to look for (see {@link echoNeedle}).
  const needle = echoNeedle(current.formatted_message);
  const echo = needle ? await ports.watchEcho(session, needle) : null;

  // Default to a hold so an unobserved result is the SAFE failure mode (hold, never a false
  // delivery); the try either assigns the real result or throws past this point.
  let result: WriteResult = { status: 'aborted', abort: { kind: 'hold', reason: 'busy' } };
  try {
    result = await ports.writeMessage(session, current.formatted_message, current.no_enter === 1, precheck);
  } finally {
    // Invalidate the memo on EVERY write outcome — a clean `true`, a dropped-write `false`, OR a
    // rejection — and BEFORE the markDelivered/held decisions below (CMAP round 3 moved it above the
    // guard; round 4 — Codex — made it rejection-safe via this finally). The write is what makes the
    // cached CLEAN verdict stale (it put the submitted line + a fresh prompt on the wire, or some of
    // its bytes), regardless of whether the row then transitions, holds, or the write completes
    // cleanly. Ways a leftover CLEAN would leak, all closed here: (a) a dismiss/supersede lands during
    // the paced write → markDelivered returns false and we early-return below, bytes already out;
    // (b) a dropped write reports `false` (Spec 1313 integration review — silent-loss fix) after
    // putting SOME bytes on the wire, e.g. the text landed but the Enter dropped → we hold below;
    // (c) writeMessage REJECTS after partial bytes — its port contract (`boolean | Promise<boolean>`)
    // permits a binding to throw, and a bare throw would skip a delete placed after the await. In
    // every case a leftover CLEAN would let a follow-up held message memo-hit the SAME token and
    // write onto the not-yet-echoed line, so the memo must die here. (A DELIVERY's own bytes still
    // advance no signal by design — it writes with the `'delivery'` origin — so this delete, not
    // the token, is what covers our own write.) Issue #1473 closed the sibling case, a HUMAN
    // keystroke: `ringToken` now carries the session's input counter, so a memoized CLEAN verdict
    // can no longer be reused across one. What survives is the echo-lag window the input-settle
    // interval BOUNDS rather than closes — input older than the settle whose echo is still
    // delayed, and input in flight from the client at sample time.
    memo?.delete(cacheKey);
  }

  // Anything short of a complete submit holds the row — a delivery is marked delivered only when
  // every byte, Enter included, reached the terminal.
  //
  //   • `dropped` — a PTY write was dropped (#1198): zero-or-partial bytes reached the terminal,
  //     the exact silent loss this spec exists to prevent (Spec 1313 integration review — Codex).
  //     The t=0 `writable` precheck cannot catch a socket that dies mid-pace (the text/lines/Enter
  //     fire across setTimeout gaps). Any bytes already on the wire only make the line dirty; the
  //     render gate then holds on that draft until the session recovers or is torn down.
  //   • `contended` — another submission (an `--interrupt`/`--escape`, or a delivery to an agent
  //     sharing this terminal) held the lock, so nothing was written. `busy` is the honest reason:
  //     the line is occupied. Declining rather than queueing is deliberate — see
  //     {@link trySubmitToSession}: the drainer walks agents sequentially, so a blocking wait here
  //     would stall every OTHER agent's delivery behind this one terminal.
  //   • `aborted` — the in-lock precheck refused, with nothing written. A `hold` abort re-holds for
  //     the stated reason; `row-resolved` means the row was dismissed/superseded while we waited,
  //     which is a TERMINAL state and must not be re-held (same handling as the pre-lock check
  //     above, which this one backstops for the duration of the lock wait).
  //   • `preempted` — the bytes went out, but an operator submission whose wait ceiling expired
  //     wrote unserialized while they did, so the composer may have been cleared or truncated
  //     under them. Hold rather than mark delivered. This trades a possible DUPLICATE (if the
  //     message did land intact, the gate re-delivers it later) for never reporting a delivery
  //     that did not happen — the same call the `dropped` branch already makes, and the failure
  //     this whole issue exists to remove. It is the one hole the ceiling opens, and it is
  //     detected by counting lock bypasses, not by re-reading the screen.
  if (result.status === 'dropped') return hold('no-live-pty');
  if (result.status === 'preempted') {
    ports.log(
      `[mailbox] write to ${toAgent} @ ${path.basename(workspacePath)} was raced by an unserialized ` +
        `operator write — holding ${row.id.slice(0, 8)}… for redelivery rather than reporting it delivered`,
    );
    return hold('busy');
  }
  if (result.status === 'contended') return hold('busy');
  if (result.status === 'aborted') {
    if (result.abort.kind === 'row-resolved') {
      ports.onHeldStateChange(); // the held set changed under us → refresh the indicator
      return { delivered: [], reason: null };
    }
    // Carry the in-lock refusal's detail and re-drain delay through (Issue #1473): an input
    // hold decided inside the lock is the same hold as one decided before it, and must reach
    // the operator surfaces and the drainer's retry timer identically.
    const outcome = hold(result.abort.reason, result.abort.detail ?? null);
    return result.abort.retryAfterMs === undefined
      ? outcome
      : { ...outcome, retryAfterMs: result.abort.retryAfterMs };
  }

  // THE POINT OF NO RETURN (Issue #1584). Past this line the write COMPLETED — every byte,
  // Enter included, was accepted by the session — so the row is at-least-once delivered and
  // must NEVER be written again. Nothing below may `hold(...)`: a hold puts the row back in
  // the drainer's held set, and the next clean-prompt pass re-writes the WHOLE message with
  // no attempt cap anywhere in this module. That is exactly what #1583 saw in the field —
  // one `afx send --file` re-injected dozens of times, byte-identical, silently (a `busy`
  // hold is excluded from {@link isClassifierStuck}, so no streak ever escalates it).
  //
  // Only PRE-write prechecks may hold, and every hold above this point is one: the branches
  // between the write and here wrote NOTHING (`contended`, `aborted`) or produced a write that
  // cannot be trusted to have landed (`dropped` — bytes lost mid-pace to a dead socket;
  // `preempted` — an unserialized operator submission may have cleared or truncated the
  // composer under them). Only `written` reaches this line, and only `written` is the
  // at-least-once guarantee that forbids a re-write.
  //
  // COMMIT THE DELIVERY FIRST, before any further await or fallible call (CMAP round 1 — Codex).
  // The point of no return is only real if it is DURABLE: while the row still reads `held` in
  // the database it is re-writable by the next drainer tick, so leaving it held across ~1.2 s of
  // verification would reopen the loop for any interruption of that window — a Tower crash or
  // restart, or a `verify()` that rejects instead of answering. `markDelivered` is synchronous
  // (better-sqlite3), so ordering it here leaves no window at all.
  //
  // markDelivered is guarded (held→delivered only). If it did NOT transition, the row was
  // dismissed/superseded during the paced write — accept that terminal state and do not
  // broadcast a delivery for it.
  if (!markDelivered(db, row.id, ports.now())) {
    ports.onHeldStateChange();
    return { delivered: [], reason: null };
  }
  ports.broadcast(broadcastForRow(current, ports.now()));
  ports.onHeldStateChange(); // a held row left the set → refresh the indicator count
  ports.log(`[mailbox] delivered ${row.id} → ${toAgent} @ ${path.basename(workspacePath)}`);

  // Echo verification (Issue #1573) still runs — it is the only end-to-end evidence the bytes
  // reached the terminal — but it is now pure REPORTING, downstream of a delivery that is
  // already committed. `false` means "could not confirm", never "definitely lost".
  let verified: boolean | undefined;
  if (echo) {
    // One bounded RE-verify window before giving up. `verify()` polls to its own deadline and
    // then answers false; a second call opens a fresh window against the SAME pre-write sample,
    // so it still requires evidence THIS write produced. It accommodates a slow renderer
    // without writing a single byte, and the total stays inside the sender's patience (~1.5 s)
    // because the request path awaits this.
    //
    // A REJECTION is unconfirmed, not an error to propagate: the bytes are out and the row is
    // committed, so throwing here would only deny the sender the `verified` answer and log a
    // spurious delivery failure.
    try {
      verified = (await echo.verify()) || (await echo.verify());
    } catch (err) {
      verified = false;
      ports.log(`[mailbox] echo verification errored for ${row.id.slice(0, 8)}…: ${String(err)}`, 'WARN');
    }
  }

  // The escalation decision sits OUTSIDE `if (echo)` (Issue #1473). A during-write input race
  // is a reason to flag a delivery whether or not it had a needle worth matching — and in its
  // most common shape (a human's Enter submitting our half-written body) the header DID land,
  // so `verified` is `true` and the old `if (!verified)` inside the echo block never fired.
  // Computed once, so a delivery that is both raced AND unechoed escalates exactly once.
  const racedByInput = result.racedByInput === true;
  const unverified = racedByInput || verified === false;
  if (unverified) {
    // `'input-raced'` takes precedence: it names the more actionable remedy, and a missing echo
    // is frequently just the downstream symptom of the race.
    const cause: UnverifiedCause = racedByInput ? 'input-raced' : 'no-echo';
    // The row is already `delivered`, so this is the delivered-only counterpart of the
    // drainer's held-only `markEscalated`.
    markEscalatedDelivered(db, row.id, ports.now());
    // BRANCH the text rather than appending to it. The no-echo wording asserts the header never
    // appeared, which is false for the raced case; and its `needle N chars` clause would run
    // with no needle at all here and print "needle 0 chars".
    const what = racedByInput
      ? `the write completed, but the terminal received input while it was in flight, so the ` +
        `body may have been truncated or submitted early`
      : `the write completed but its header never appeared on the terminal (needle ` +
        `${needle ? needle.length : 0} chars)`;
    ports.log(
      `[mailbox] delivered-unverified ${row.id.slice(0, 8)}… → ${toAgent} @ ` +
        `${path.basename(workspacePath)} (terminal ${session.id}, ${cause}): ${what}. Recorded as ` +
        `delivered and flagged — NOT re-written (Issue #1584).`,
      'WARN',
    );
    // Raise it where a human will see it. The sender's response covers an interactive
    // `afx send`, but a cron or backstop delivery has no sender waiting on a response, and a
    // DELIVERED row is invisible to every held-scoped surface (`afx inbox`, the held-count
    // indicator) — without this its only trace is a log line (CMAP round 1 — Codex).
    ports.onUnverifiedDelivery?.({
      workspacePath,
      toAgent,
      mailboxId: row.id,
      terminalId: session.id,
      cause,
    });
    return {
      delivered: [row.id],
      reason: null,
      unverifiedCause: cause,
      ...(verified === undefined ? {} : { verified }),
    };
  }
  return { delivered: [row.id], reason: null, ...(verified === undefined ? {} : { verified }) };
}

/**
 * Shared per-agent delivery serializer (Spec 1313, Phase 4). Every live caller —
 * the `afx send` request path and the backstop drainer — funnels delivery for a
 * given agent through this one instance, so a `pick → gate → write → mark`
 * critical section can never overlap another for the same agent. That is what
 * makes the spike `w1a` blob (two concurrent sends fusing into one submit)
 * impossible: the second delivery cannot even read the gate until the first has
 * fully written its text + Enter (see {@link KeyedSerializer}).
 */
const deliverySerializer = new KeyedSerializer();

/**
 * {@link deliverAgentMail}, serialized per agent through the shared
 * {@link KeyedSerializer}. This is the entry point every live caller must use;
 * the bare `deliverAgentMail` is exported only so unit tests can drive a single
 * pass deterministically.
 */
export function deliverAgentMailSerialized(
  ports: DeliveryPorts,
  db: Database.Database,
  workspacePath: string,
  toAgent: string,
  memo?: Map<string, CachedVerdict>
): Promise<DeliveryOutcome> {
  return deliverySerializer.run(agentKey(workspacePath, toAgent), () =>
    deliverAgentMail(ports, db, workspacePath, toAgent, memo)
  );
}

const DEFAULT_BACKSTOP_INTERVAL_MS = 1500;
// Spec 1313 (baked decision 7): terminal rows are pruned after a bounded window,
// default 30 days, configurable via `.codev/config.json` (mailbox.retentionDays) —
// `startMailboxDrainer` reads it and passes it in. This constant is the fallback
// when the drainer is constructed without an explicit value (e.g. unit tests).
const DEFAULT_PRUNE_RETENTION_DAYS = 30;
// Spec 1313 (Phase 7): a held row older than this crosses the escalation age — the
// drainer flags it `escalated` and emits the visibility broadcast (NEVER delivers).
// Default 60s (matches today's max-age); `startMailboxDrainer` overrides from config.
const DEFAULT_ESCALATION_MS = 60_000;
// Spec 1313 (Phase 7): after this many consecutive not-clean gate verdicts for an agent
// whose reason is `no-profile`, the drainer logs a loud liveness warning — a sustained
// no-profile streak means the session's app is unrecognized (broken/unknown classifier),
// so its mail will never deliver. The threshold filters transient boot/relaunch screens,
// which resolve well before it.
const LIVENESS_STREAK_THRESHOLD = 10;
// Spec 1313 round 3 (change 3): the owner-notice threshold is a small MULTIPLE of the
// escalation age — a row must be deliverable-but-stuck for this much longer than the basic
// `escalated` flag before its owner architect is alarmed, so a briefly-busy line does not
// spam owners. Derived from escalationMs (default 60s → 180s), so it scales with the
// configured `mailbox.escalationSeconds` without a separate config knob.
const DEFAULT_OWNER_NOTICE_MULTIPLE = 3;
// Issue #1473: slack added to a pass's `retryAfterMs` when arming the one-shot input re-drain,
// so the retry lands just PAST the settle boundary rather than exactly on it (where a timer
// firing a millisecond early would re-hold and cost another full cycle).
const INPUT_RETRY_MARGIN_MS = 25;
// Issue #1473: consecutive input-holds for one agent after which the drainer logs a diagnostic.
// A human types in BURSTS, so an unbroken run of sub-settle input holds this long (~90s at the
// 300ms re-drain cadence) is a machine, not a person — most likely a reply shape the filter does
// not recognise, arriving on every repaint. Deliberately a log line and not an escalation: the
// hold class it describes is the same "a human is at the line" class as `user-text`, and wiring
// it to the escalation path would false-alarm on every ordinary typist. This is the trace that
// makes the otherwise-silent case findable after the fact.
const CONSECUTIVE_INPUT_HOLD_WARN_THRESHOLD = 60;

/**
 * The poll backstop that replaces `SendBuffer`'s flush timer. On each tick it walks
 * every agent with held mail and runs {@link deliverAgentMail}, so a message held
 * on a busy line delivers on the first tick after the line clears (Phase 5 adds the
 * fast submit/quiescence triggers on top). It also prunes terminal rows on boot and
 * per tick, and tracks a per-agent consecutive-not-clean streak for liveness
 * telemetry (Phase 7 surfaces it as a loud log/broadcast). Shutdown just stops the
 * timer — nothing is force-flushed, because every held row is already persisted.
 */
export class MailboxDrainer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private ports: DeliveryPorts | undefined;
  private db: Database.Database | undefined;
  private readonly intervalMs: number;
  private readonly retentionDays: number;
  private readonly escalationMs: number;
  private readonly ownerNoticeMs: number;
  private readonly notCleanStreak = new Map<string, number>();
  // Spec 1313 round 3 (change 3): agents for which an owner starvation notice has already been
  // raised this Tower lifetime — so the notice fires ONCE per episode, not once per tick. An
  // entry is cleared when the agent's eligible held set drains (its starvation is over), which
  // also fires `clearHeldOwnerNotice`. In-memory (like the streak map); after a restart a still-
  // starving agent re-notifies once, and `supersede` keeps that to a single pending row.
  private readonly notifiedAgents = new Set<string>();
  // Spec 1313 Phase 5: agents with a fast-trigger drain already queued. A burst of
  // submit/quiescence signals for one agent coalesces onto the same pending promise
  // (one gate check, not one per trigger); the slot is released when the pass begins.
  private readonly scheduledDrains = new Map<string, Promise<void>>();
  // Spec 1313 render-gate verdict memo: a cached gate verdict per agent, keyed on the session
  // instance + monotone change-token, so a STATIC held screen skips its re-classify every tick.
  // Owned here so it stays bounded — {@link tick} prunes it to the current held-agent set. (The
  // CMAP-round-1 big-ring backstop backoff that used to sit alongside this is retired in round 2:
  // with the persistent bounded mirror, a classify is O(viewport) regardless of history, so there
  // is no expensive whole-ring render left to throttle — every tick just re-classifies cheaply.)
  private readonly verdictMemo = new Map<string, CachedVerdict>();
  // Issue #1473: the one-shot input re-drain. At most one pending timer per agent (a later
  // hold coalesces onto the timer already armed), generation-guarded exactly like
  // `scheduleDrain`, and cleared in `stop()` alongside the backstop timer.
  private readonly inputRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Issue #1473: consecutive input-holds per agent — the diagnostic behind
  // {@link CONSECUTIVE_INPUT_HOLD_WARN_THRESHOLD}. Reset by any outcome that is not an input
  // hold, delivery included.
  private readonly consecutiveInputHolds = new Map<string, number>();
  // Lifecycle generation (CMAP round 2 — Codex/Claude): the drainer instance is REUSED across
  // stop()/start() (mailbox-wiring `ensureDrainer`), and the tests do start/stop/start. Bumped on
  // stop() so an in-flight tick/scheduleDrain that resumes after a restart bails before mutating
  // this generation's state.
  private generation = 0;

  constructor(opts: { intervalMs?: number; pruneRetentionDays?: number; escalationMs?: number; ownerNoticeMs?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_BACKSTOP_INTERVAL_MS;
    this.retentionDays = opts.pruneRetentionDays ?? DEFAULT_PRUNE_RETENTION_DAYS;
    this.escalationMs = opts.escalationMs ?? DEFAULT_ESCALATION_MS;
    this.ownerNoticeMs = opts.ownerNoticeMs ?? this.escalationMs * DEFAULT_OWNER_NOTICE_MULTIPLE;
  }

  start(ports: DeliveryPorts, db: Database.Database): void {
    if (this.timer) clearInterval(this.timer);
    this.ports = ports;
    this.db = db;
    pruneTerminal(db, this.retentionDays, ports.now()); // boot prune
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.ports = undefined;
    this.db = undefined;
    // Drop all per-agent transient state (CMAP round 1/2 — Codex/Claude): the drainer instance is
    // REUSED across stop()/start(), so a restart must not carry a stale verdict/streak/backoff, nor
    // let a post-restart trigger coalesce onto a dead scheduled-drain promise. NB clearing
    // `scheduledDrains` does NOT cancel an already-running drain — its promise captured the old
    // ports/db and runs to completion; it only stops a new trigger from coalescing onto it. Two
    // guards make that resumption safe (CMAP round 3): (1) the `generation` bump below — checked by
    // both `tick` and `scheduleDrain` right after each await — stops an in-flight pass from re-seeding
    // THIS generation's freshly-cleared streak/scheduled-drain slot. (The verdict memo can still be
    // seeded from INSIDE a resumed `deliverAgentMail`, before that check, but that is benign: the memo
    // is bound to its session instance + change token and re-pruned to the held-agent set at the top of
    // every tick, so a cross-generation entry is self-correcting, not a leak.) And (2) both passes now
    // run their work under a try/catch, so a throw on the old (closed) DB is logged, not an
    // unhandledRejection that would exit(1). (Pre-round-3, `tick` had no catch, so a closed-DB throw
    // there was NOT harmless.)
    this.verdictMemo.clear();
    this.notCleanStreak.clear();
    this.scheduledDrains.clear();
    this.notifiedAgents.clear();
    // Issue #1473: the input re-drain timers are real pending timers, not just map entries, so
    // they must be CLEARED here and not merely dropped — the generation guard inside each one
    // would make a survivor harmless, but leaving it pending keeps the event loop alive.
    for (const timer of this.inputRetryTimers.values()) clearTimeout(timer);
    this.inputRetryTimers.clear();
    this.consecutiveInputHolds.clear();
    this.generation++;
  }

  /** Per-agent consecutive not-clean count (liveness telemetry; Phase 7 reads this). */
  get streaks(): ReadonlyMap<string, number> {
    return this.notCleanStreak;
  }

  /** Agents with a pending input re-drain timer (Issue #1473; test/observability). */
  get pendingInputRetries(): ReadonlyArray<string> {
    return [...this.inputRetryTimers.keys()];
  }

  /** Per-agent consecutive input-hold count (Issue #1473; test/observability). */
  get inputHoldStreaks(): ReadonlyMap<string, number> {
    return this.consecutiveInputHolds;
  }

  /**
   * Arm the one-shot input re-drain and track the consecutive-input-hold diagnostic
   * (Issue #1473). Called from both pass sites, exactly where {@link recordStreak} is, so the
   * backstop tick and the fast trigger behave identically.
   *
   * The retry exists because the `'submit'` fast trigger is now provably ALWAYS held: it fires
   * synchronously from `stopComposing`, and the drain it schedules runs in a microtask, so at
   * that pass the input timestamp is `now` by construction. Without a retry, the single most
   * common "the line just cleared, deliver now" path would silently degrade to the 1.5 s
   * backstop — as would any navigation key that provokes no output of its own.
   *
   * COALESCED: while a timer is pending for an agent, later input holds do not stack another.
   * GENERATION-GUARDED like {@link scheduleDrain}, so a timer that survives a stop()/start()
   * bails instead of driving the new generation's state.
   */
  private armInputRetry(
    key: string,
    workspacePath: string,
    toAgent: string,
    outcome: DeliveryOutcome,
    gen: number,
  ): void {
    if (outcome.retryAfterMs === undefined) {
      this.consecutiveInputHolds.delete(key);
      return;
    }
    const consecutive = (this.consecutiveInputHolds.get(key) ?? 0) + 1;
    this.consecutiveInputHolds.set(key, consecutive);
    // Report once at the crossing, not every pass past it.
    if (consecutive === CONSECUTIVE_INPUT_HOLD_WARN_THRESHOLD) {
      this.ports?.log(
        `[mailbox] ${toAgent} @ ${path.basename(workspacePath)} has held on recent terminal input ` +
          `for ${consecutive} consecutive checks. A human types in bursts, so an unbroken run this ` +
          `long usually means something is emitting input-shaped bytes continuously — most likely a ` +
          `terminal reply the gate's filter does not recognise (Issue #1473). Mail for this agent is ` +
          `NOT being delivered while this persists.`,
        'WARN',
      );
    }
    if (this.inputRetryTimers.has(key)) return; // a retry is already pending for this agent
    const timer = setTimeout(() => {
      this.inputRetryTimers.delete(key);
      if (this.generation !== gen) return; // stop() ran while we waited → old ports/db
      void this.scheduleDrain(workspacePath, toAgent);
    }, outcome.retryAfterMs + INPUT_RETRY_MARGIN_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.inputRetryTimers.set(key, timer);
  }

  /**
   * Agent keys that currently hold a cached gate verdict (render-gate memo).
   * Observability/test only: {@link tick} prunes this to the current held-agent set, so
   * it never grows past the number of agents holding mail.
   */
  get memoizedAgents(): ReadonlyArray<string> {
    return [...this.verdictMemo.keys()];
  }

  /** One backstop pass. Guarded against re-entry so a slow gate can't overlap ticks. */
  async tick(): Promise<void> {
    const ports = this.ports;
    const db = this.db;
    if (!ports || !db || this.ticking) return;
    this.ticking = true;
    const gen = this.generation; // bail if stop() runs mid-tick (the drainer instance is reused)
    try {
      const agents = new Map<string, { workspacePath: string; toAgent: string }>();
      for (const row of listHeld(db)) {
        agents.set(agentKey(row.workspace_path, row.to_agent), {
          workspacePath: row.workspace_path,
          toAgent: row.to_agent,
        });
      }
      // Prune the verdict memo to the current held-agent set before the pass: an agent whose
      // mail all delivered/dismissed is no longer walked here, so its cached verdict would
      // otherwise leak for the life of the process. Bounds the memo to |held agents|.
      for (const key of this.verdictMemo.keys()) {
        if (!agents.has(key)) this.verdictMemo.delete(key);
      }
      for (const [key, { workspacePath, toAgent }] of agents) {
        if (this.generation !== gen) return; // stop() ran mid-tick → bail before more work
        // Isolate each agent's pass (CMAP round 3 — Claude): a throw from classify/writeMessage/DB
        // for ONE agent must not abort the others, and — critically — must never escape this
        // setInterval-invoked tick, where the tower-server `unhandledRejection` handler would
        // exit(1) and take Tower + every terminal down. scheduleDrain already wraps its drain the
        // same way; this mirrors it so the round-2 stop() comment's "throws harmlessly" is true
        // for the backstop tick too, not just the scheduled drain.
        try {
          // Every tick re-classifies cheaply now (Spec 1313 round 2): the persistent mirror makes a
          // classify O(viewport), independent of history, so there is no expensive whole-ring render
          // to throttle — the CMAP-round-1 big-ring cooldown is retired. The verdict memo still skips
          // the re-classify for a STATIC screen (unchanged token); a moving screen just re-checks.
          const outcome = await deliverAgentMailSerialized(ports, db, workspacePath, toAgent, this.verdictMemo);
          if (this.generation !== gen) return; // stop() landed during the await → do NOT mutate the
                                               // NEW generation's freshly-cleared streak map
          this.recordStreak(key, outcome);
          this.armInputRetry(key, workspacePath, toAgent, outcome, gen);
        } catch (err) {
          ports.log(`[mailbox] backstop delivery failed for ${toAgent}: ${String(err)}`);
        }
      }
      if (this.generation !== gen) return; // stop() ran during the loop → skip escalation/prune
      this.escalateOverdue(ports, db);
      this.noticeOverdue(ports, db);
      pruneTerminal(db, this.retentionDays, ports.now());
    } catch (err) {
      // Backstop for escalateOverdue/pruneTerminal (DB ops) or anything the per-agent guard missed:
      // a tick runs under setInterval, so an unhandled throw becomes an unhandledRejection → exit(1)
      // (tower-server). Log and let the next tick retry (CMAP round 3 — Claude).
      ports?.log(`[mailbox] backstop tick failed: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Escalation pass (Spec 1313, Phase 7). Flags every held row that has crossed the
   * escalation age (`escalationMs`, default 60s) as `escalated` and emits the
   * `onEscalation` visibility broadcast + a loud log. **VISIBILITY ONLY — it never
   * delivers.** `findEscalatable` returns only not-yet-escalated held rows and
   * `markEscalated` is idempotent, so each row escalates (and broadcasts) exactly
   * once; the row still delivers only on a later clean gate pass, and the attention
   * state clears when it resolves (the row leaves the held set).
   */
  private escalateOverdue(ports: DeliveryPorts, db: Database.Database): void {
    const now = ports.now();
    let escalatedAny = false;
    for (const row of findEscalatable(db, this.escalationMs, now)) {
      if (!markEscalated(db, row.id, now)) continue;
      escalatedAny = true;
      // Age from the escalation START (max(created_at, not_before)) so a delayed row's clock
      // runs from its DUE time, not its enqueue time (Spec 1313 round 3). For a normal row
      // not_before is null → this is created_at, unchanged from before.
      const ageMs = now - Math.max(row.created_at, row.not_before ?? row.created_at);
      ports.onEscalation({
        workspacePath: row.workspace_path,
        toAgent: row.to_agent,
        mailboxId: row.id,
        ageMs,
        reason: row.reason,
        detail: row.detail,
      });
      ports.log(
        `[mailbox] ESCALATED ${row.id.slice(0, 8)}… → ${row.to_agent} @ ${path.basename(row.workspace_path)} ` +
          `(held ${Math.round(ageMs / 1000)}s, reason ${formatVerdict(row.reason, row.detail)}) — visibility only, not delivered`
      );
    }
    // A row's escalated flag flipped → the overview-derived `mailboxEscalated` attention
    // bit changed. Fire the held-state-change event too (in addition to the per-row
    // `mailbox-escalation` above) so a client that refetches /api/overview on
    // `overview-changed` picks up the new attention state and never shows a stale flag.
    if (escalatedAny) ports.onHeldStateChange();
  }

  /** Agents with a pending owner starvation notice this lifetime (test/observability). */
  get notifiedOwnerAgents(): ReadonlyArray<string> {
    return [...this.notifiedAgents];
  }

  /**
   * Owner starvation-notice pass (Spec 1313 round 3, change 3). When an agent's OLDEST eligible
   * held row has been deliverable-but-stuck past the owner-notice threshold, alarm the agent's
   * OWNER exactly once per episode via {@link DeliveryPorts.escalateHeldToOwner} — the live
   * binding resolves the recipient architect (spawning → workspace `main` → first-registered),
   * skips agents that are themselves architects, and enqueues ONE coalesced, gate-delivered
   * notice. When a previously-notified agent's eligible held set drains, the pending notice is
   * cleared via {@link DeliveryPorts.clearHeldOwnerNotice}. VISIBILITY ONLY — never delivers.
   *
   * The two spec guards hold by construction: {@link findStarvingAgents} excludes PRE-DUE
   * delayed rows (a scheduled send is not stuck) and NOTICE rows themselves (a notice can never
   * trigger a notice). The once-per-episode guard is {@link notifiedAgents}, armed ONLY after a
   * notice is actually enqueued (an `escalateHeldToOwner` that no-ops — no architect yet, or the
   * recipient is itself an architect — leaves the guard unset and retries next tick);
   * `escalateHeldToOwner` additionally coalesces via a supersede key, so even a post-restart
   * re-notify stays a single pending row.
   */
  private noticeOverdue(ports: DeliveryPorts, db: Database.Database): void {
    // No notice wiring (a unit fake without these ports) → nothing to do.
    if (!ports.escalateHeldToOwner && !ports.clearHeldOwnerNotice) return;
    const now = ports.now();
    const cutoff = now - this.ownerNoticeMs;
    const withEligibleHeld = new Set<string>();
    for (const agent of findStarvingAgents(db, now)) {
      const key = agentKey(agent.workspacePath, agent.toAgent);
      withEligibleHeld.add(key);
      if (agent.stuckSince <= cutoff && !this.notifiedAgents.has(key)) {
        // Arm the once-per-episode guard ONLY when a notice was actually enqueued. The binding
        // no-ops (returns false) when the recipient is itself an architect or no architect is
        // registered yet; marking the agent notified on that no-op would suppress the alarm for
        // the rest of the episode even after an architect appears. A falsy/absent return leaves
        // the key unset so the next tick retries.
        const enqueued = ports.escalateHeldToOwner?.({
          workspacePath: agent.workspacePath,
          toAgent: agent.toAgent,
          reason: agent.reason,
          // Issue #1482: the gate detail decides which notice the owner gets, and the streak
          // says how many consecutive checks confirmed it. Both are already tracked — the
          // detail on the row (aggregated by findStarvingAgents), the streak in the drainer's
          // own map — so this costs no new state, just carrying what we have to where the
          // human reads it.
          detail: agent.detail,
          ageMs: now - agent.stuckSince,
          heldCount: agent.count,
          streak: this.notCleanStreak.get(key) ?? 0,
        });
        if (enqueued) this.notifiedAgents.add(key);
      }
    }
    // A previously-notified agent with no eligible non-notice held row left has drained
    // (delivered/dismissed, or only pre-due scheduled rows remain) → clear the moot notice.
    for (const key of [...this.notifiedAgents]) {
      if (withEligibleHeld.has(key)) continue;
      this.notifiedAgents.delete(key);
      const [ws, agent] = key.split('\0');
      ports.clearHeldOwnerNotice?.(ws, agent);
    }
  }

  /**
   * Update the per-agent liveness streak from a delivery outcome (Phase 7 surfaces
   * it): a delivered or empty pass clears the streak; a held pass grows it. Shared by
   * the backstop {@link tick} and the fast {@link scheduleDrain} trigger so both feed
   * the same telemetry.
   */
  private recordStreak(key: string, outcome: DeliveryOutcome): void {
    if (outcome.delivered.length > 0 || outcome.reason === null) {
      this.notCleanStreak.delete(key);
      return;
    }
    const next = (this.notCleanStreak.get(key) ?? 0) + 1;
    this.notCleanStreak.set(key, next);
    // Liveness telemetry (Spec 1313, Phase 7 — spec line 91; extended in the render-gate
    // hardening): a sustained streak that the gate CANNOT verify means the mail will
    // NEVER deliver on its own — surface it instead of holding silently. Two such classes:
    //   • `no-profile` — the app is unrecognized (a net-new or drifted classifier);
    //   • a classifier-stuck gate detail — a recognized app whose composer can't be bounded
    //     (`no-region-end`/`no-composer-marker` = a drifted TUI layout or an unrenderable
    //     frame — e.g. a pathological #1047 ring whose whole-render yields no bounded
    //     composer; this is the liveness net that replaced the removed over-ceiling hold).
    // Scoped to those on purpose: a `busy`/`user-text` streak is a human legitimately at the
    // line (Constraint 1 — must not false-alarm), and `no-live-pty` is no session at all.
    // Reported once at the crossing (not per tick); the threshold filters transient boot/
    // relaunch screens. The pure module only reports the crossing — the live binding
    // ({@link DeliveryPorts.onLiveness}) applies the spec's "with recent output" gate and
    // does the loud log + broadcast, so an idle unknown session does not false-alarm.
    if (isClassifierStuck(outcome.reason, outcome.detail) && next === LIVENESS_STREAK_THRESHOLD) {
      const [ws, agent] = key.split('\0');
      this.ports?.onLiveness({ workspacePath: ws, toAgent: agent, streak: next });
    }
  }

  /**
   * Fast, event-driven delivery trigger (Spec 1313, Phase 5). A submit (Enter) or
   * output-quiescence signal for a session schedules a single coalesced delivery pass
   * for that agent, so a held message delivers within a microtask of the line
   * clearing instead of waiting up to one backstop interval.
   *
   * Triggers are schedulers, never authority (spec Constraint): this runs the SAME
   * gated {@link deliverAgentMailSerialized} the backstop does, so a spurious trigger
   * on a still-busy screen simply re-holds, and a missed trigger only defers delivery
   * to the next backstop tick — a trigger can never corrupt anything.
   *
   * Coalescing: while a pass is already queued for an agent, further triggers return
   * the same in-flight promise (the gate runs once, not once per trigger). The slot is
   * released just before the pass runs, so a trigger arriving *during* a pass queues
   * exactly one follow-up; the per-agent {@link KeyedSerializer} keeps passes from
   * overlapping. No-op (resolved) until the drainer is started, and never rejects — a
   * gate/write error is logged and left for the backstop, mirroring the tick.
   */
  scheduleDrain(workspacePath: string, toAgent: string): Promise<void> {
    const ports = this.ports;
    const db = this.db;
    if (!ports || !db) return Promise.resolve();
    const gen = this.generation; // bail if stop() runs before this queued drain executes
    const key = agentKey(workspacePath, toAgent);
    const existing = this.scheduledDrains.get(key);
    if (existing) return existing;
    const run = Promise.resolve().then(async () => {
      // Bail before touching ANY shared state if the generation moved (stopped/restarted before we
      // ran → old ports/db), and release our coalescing slot only if it is still OURS (CMAP round 3
      // — Codex). The old code deleted `scheduledDrains[key]` unconditionally and BEFORE the
      // generation check: a stop()/start()+new scheduleDrain for the same key installs a NEW-
      // generation run in that slot, and the unconditional delete would drop that live slot.
      if (this.generation !== gen) return;
      if (this.scheduledDrains.get(key) === run) this.scheduledDrains.delete(key);
      try {
        // NB: the fast trigger classifies FRESH (no verdict memo). A submit/quiescence
        // trigger fires precisely because the ring just changed, so it must re-check the
        // gate — the memo is the backstop tick's optimization for a STATIC ring, not this
        // event-driven re-check. tick owns and prunes the memo alone.
        const outcome = await deliverAgentMailSerialized(ports, db, workspacePath, toAgent);
        if (this.generation !== gen) return; // stop() landed during the await → do NOT mutate the
                                             // NEW generation's freshly-cleared streak map
        this.recordStreak(key, outcome);
        this.armInputRetry(key, workspacePath, toAgent, outcome, gen);
      } catch (err) {
        ports.log(`[mailbox] scheduled drain failed for ${toAgent}: ${String(err)}`);
      }
    });
    this.scheduledDrains.set(key, run);
    return run;
  }
}
