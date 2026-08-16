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
 * this terminal now" actions and take the separate per-terminal submission lock
 * (`session-submit.ts`), not the per-agent serializer here — every autonomous/scheduled/
 * held send, by contrast, delivers through this gate.
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
  setHeldReason,
  pruneTerminal,
  findEscalatable,
  markEscalated,
  findStarvingAgents,
} from '../db/mailbox.js';
import type { DbMailbox, MailboxReason } from '../db/types.js';
import type { GateProfile, GateVerdict } from './render-gate.js';
import { KeyedSerializer } from './write-queue.js';

/**
 * The structural view of a live PTY session the delivery path needs. `PtySession`
 * satisfies this (ringBuffer + info getter + the Spec 1313 identity getters +
 * write); tests pass a fake. Kept minimal and structural so the module never
 * imports the terminal layer.
 */
export interface DeliverySession {
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
   * Write a formatted message (text + Enter, unless `noEnter`) to the session and
   * report whether every byte reached the terminal. Resolves `true` when the paced
   * write — including the trailing Enter — has fully completed; `false` when any
   * write was dropped (#1198: a shellper socket that died mid-pace). The delivery
   * `await`s it for two reasons: (1) completion chaining — the per-agent serializer
   * holds the line until the submit is entirely on the wire, so the next delivery
   * never starts mid-write; (2) the boolean gates markDelivered — a dropped write
   * holds the row (`no-live-pty`) instead of falsely reporting delivery (Spec 1313
   * integration review — the silent-loss finding).
   */
  writeMessage(session: DeliverySession, formattedMessage: string, noEnter: boolean): boolean | Promise<boolean>;
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
  log(message: string): void;
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
  /** How long the oldest eligible held row has been stuck, in ms. */
  ageMs: number;
  /** How many eligible held rows are backed up for the agent. */
  heldCount: number;
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
}

/** Outcome of one delivery pass over an agent's held mail. */
export interface DeliveryOutcome {
  /** Row ids delivered this pass — 0 or 1 (one message per clean gate; its Enter makes the line busy). */
  delivered: string[];
  /** When nothing was delivered, why the agent's mail stays held; null if delivered or the mailbox was empty. */
  reason: MailboxReason | null;
  /**
   * The gate's internal detail when a `busy` hold came from the render-gate (Spec 1313
   * render-gate hardening) — telemetry only. Distinguishes a legitimately-occupied line
   * (`user-text`, a human present) from a classifier that CANNOT verify the composer
   * (`no-region-end`/`no-composer-marker` = a drifted profile or an unrenderable frame),
   * which {@link MailboxDrainer.recordStreak} escalates to liveness telemetry. Absent
   * for non-gate holds (`no-live-pty`/`no-profile`) and deliveries.
   */
  detail?: GateVerdict['detail'];
}

/**
 * A gate outcome the render gate CANNOT bound to a decision — an unrecognized app
 * (`no-profile`) or a recognized app whose composer region can't be found
 * (`no-region-end`/`no-region-start`/`no-composer-marker` = a drifted TUI layout or an
 * unrenderable #1047 ring). A sustained streak of these means the mail will NEVER deliver
 * on its own, so it
 * is the class {@link MailboxDrainer.recordStreak} escalates to liveness telemetry; a
 * `busy`/`user-text` streak is deliberately excluded (a human legitimately at the line),
 * and `multi-row-draft` is excluded for the SAME reason — it is a human sitting on a
 * multi-line draft, just one whose cells the classifier cannot count (CMAP 2026-08-09,
 * claude F2). Its other reading — kimi growing its box while idle, i.e. the measured
 * premise behind the rule having failed — would be a genuine stuck state, but it carries
 * no recent output, and `surfaceLiveness` only alarms when output is recent, so
 * including it would add false alarms without catching that case anyway.
 * Shared by `recordStreak` and the cooldown branch of {@link MailboxDrainer.tick} so a
 * skipped tick and a real pass agree on what counts as classifier-stuck (CMAP round 3).
 */
const CLASSIFIER_STUCK_DETAILS: Record<GateVerdict['detail'], boolean> = {
  // Held by a drifted profile or an unrenderable frame — will never clear on its own.
  'no-composer-marker': true,
  'no-region-end': true,
  'no-region-start': true,
  // Held by a human at the composer — clears when they send or clear the draft.
  'multi-row-draft': false,
  'user-text': false,
  empty: false,
};

function isClassifierStuck(
  reason: MailboxReason | null,
  detail: GateVerdict['detail'] | undefined
): boolean {
  // Exhaustive by TYPE, not by an `||` chain: widening GateVerdict['detail'] without
  // classifying the new value is a compile error rather than a silent `false`, which is
  // exactly how `multi-row-draft` slipped in unclassified when the union last grew.
  return reason === 'no-profile' || (detail !== undefined && CLASSIFIER_STUCK_DETAILS[detail]);
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
 */
function ringToken(session: DeliverySession, profile: GateProfile): string {
  return `${session.bytesWritten}:${session.info.cols}x${session.info.rows}:${profile.app}`;
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

  const hold = (reason: MailboxReason): DeliveryOutcome => {
    for (const row of held) {
      if (row.reason !== reason) setHeldReason(db, row.id, reason, ports.now());
    }
    return { delivered: [], reason };
  };

  const session = ports.getSessionForAgent(workspacePath, toAgent);
  if (!session) return hold('no-live-pty');

  const profile = ports.resolveProfile(session);
  if (!profile) return hold('no-profile');

  // Sample the ring's change-token BEFORE the (possibly memoized) classify, so we can
  // re-validate afterward that the screen didn't move under us (below).
  const tokenBefore = ringToken(session, profile);

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
    for (const row of held) {
      if (row.reason !== reason) setHeldReason(db, row.id, reason, ports.now());
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
  if (ringToken(session, profile) !== tokenBefore) return hold('busy');

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

  // Default false so an unobserved result is the SAFE failure mode (hold, never a false
  // delivery); the try either assigns the real boolean or throws past this point.
  let written = false;
  try {
    written = await ports.writeMessage(session, current.formatted_message, current.no_enter === 1);
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
    // every case a leftover CLEAN would let a follow-up held message memo-hit the SAME token (PTY
    // INPUT does not advance the ring — only OUTPUT does) and write onto the not-yet-echoed line, so
    // the memo must die here. The deeper input-echo-lag window — a fresh classify racing the echo — is
    // the pre-existing gate→write INPUT race in the review's Technical Debt.
    memo?.delete(cacheKey);
  }

  // A dropped PTY write (#1198) means zero-or-partial bytes reached the terminal — the exact silent
  // loss this spec exists to prevent (Spec 1313 integration review — Codex). The t=0 `writable`
  // precheck above cannot catch a socket that dies mid-pace (the text/lines/Enter fire across
  // setTimeout gaps), so writeMessage threads the per-write result: `false` → no complete submit
  // landed. Hold the row (`no-live-pty`, retried on the next clean gate pass) instead of marking it
  // delivered. Any bytes already on the wire only make the line dirty; the render gate then holds on
  // that draft until the session recovers or is torn down — it can never be marked delivered on a
  // dead PTY.
  if (!written) return hold('no-live-pty');

  // markDelivered is guarded (held→delivered only). If it did NOT transition, the row
  // was dismissed/superseded during the paced write — accept that terminal state and
  // do not broadcast a delivery for it.
  if (!markDelivered(db, row.id, ports.now())) {
    ports.onHeldStateChange();
    return { delivered: [], reason: null };
  }
  ports.broadcast(broadcastForRow(current, ports.now()));
  ports.onHeldStateChange(); // a held row left the set → refresh the indicator count
  ports.log(`[mailbox] delivered ${row.id} → ${toAgent} @ ${path.basename(workspacePath)}`);
  return { delivered: [row.id], reason: null };
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
    this.generation++;
  }

  /** Per-agent consecutive not-clean count (liveness telemetry; Phase 7 reads this). */
  get streaks(): ReadonlyMap<string, number> {
    return this.notCleanStreak;
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
      });
      ports.log(
        `[mailbox] ESCALATED ${row.id.slice(0, 8)}… → ${row.to_agent} @ ${path.basename(row.workspace_path)} ` +
          `(held ${Math.round(ageMs / 1000)}s, reason ${row.reason ?? 'held'}) — visibility only, not delivered`
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
          ageMs: now - agent.stuckSince,
          heldCount: agent.count,
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
      } catch (err) {
        ports.log(`[mailbox] scheduled drain failed for ${toAgent}: ${String(err)}`);
      }
    });
    this.scheduledDrains.set(key, run);
    return run;
  }
}
