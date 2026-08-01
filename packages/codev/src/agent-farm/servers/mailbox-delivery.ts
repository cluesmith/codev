/**
 * Mailbox delivery orchestration (Spec 1313, Phase 4).
 *
 * The single gate-checked delivery path: **persist → serialize → gate → deliver |
 * hold**. Both the send request (`handleSend`, after it enqueues) and the periodic
 * backstop drainer route through {@link deliverAgentMail}, so there is exactly one
 * place a message body is ever written to a PTY — and it only ever writes to a
 * prompt the render-gate has proven empty. This is what eliminates corruption by
 * construction: a message can never fuse with a draft, because it is never
 * delivered while one exists; and there is no force path.
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
  listHeld,
  markDelivered,
  setHeldReason,
  pruneTerminal,
  findEscalatable,
  markEscalated,
} from '../db/mailbox.js';
import type { DbMailbox, MailboxReason } from '../db/types.js';
import type { GateProfile, RingSnapshot, GateVerdict } from './render-gate.js';
import { KeyedSerializer } from './write-queue.js';

/**
 * The structural view of a live PTY session the delivery path needs. `PtySession`
 * satisfies this (ringBuffer + info getter + the Spec 1313 identity getters +
 * write); tests pass a fake. Kept minimal and structural so the module never
 * imports the terminal layer.
 */
export interface DeliverySession {
  readonly ringBuffer: { getAll(): string[] };
  readonly info: { cols: number; rows: number };
  readonly command: string;
  readonly launchArgs: string[];
  readonly cwd: string;
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
  /** The render-gate: classify a rendered ring snapshot against a profile. */
  classify(snapshot: RingSnapshot, profile: GateProfile): Promise<GateVerdict>;
  /**
   * Write a formatted message (text + Enter, unless `noEnter`) to the session.
   * May return a promise that resolves when the paced write — including the
   * trailing Enter — has fully completed. The delivery `await`s it so the
   * per-agent serializer holds the line until the submit is entirely on the wire
   * (completion chaining): the next delivery therefore never starts mid-write.
   */
  writeMessage(session: DeliverySession, formattedMessage: string, noEnter: boolean): void | Promise<void>;
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
  log(message: string): void;
  now(): number;
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

/** The seed-capped reconnect-replay snapshot the gate classifies. */
function snapshotOf(session: DeliverySession): RingSnapshot {
  return {
    replay: session.ringBuffer.getAll().join('\n'),
    cols: session.info.cols,
    rows: session.info.rows,
  };
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
  toAgent: string
): Promise<DeliveryOutcome> {
  const held = findHeldForAgent(db, workspacePath, toAgent);
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

  const verdict = await ports.classify(snapshotOf(session), profile);
  if (!verdict.clean) return hold(verdict.reason ?? 'busy');

  // Clean, verified-empty prompt → deliver the oldest held message. Await the
  // write's paced completion so a serialized follow-up delivery never begins
  // until this message's text + Enter is fully on the wire.
  const row = held[0];
  await ports.writeMessage(session, row.formatted_message, row.no_enter === 1);
  ports.broadcast(broadcastForRow(row, ports.now()));
  markDelivered(db, row.id, ports.now());
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
  toAgent: string
): Promise<DeliveryOutcome> {
  return deliverySerializer.run(agentKey(workspacePath, toAgent), () =>
    deliverAgentMail(ports, db, workspacePath, toAgent)
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
  private readonly notCleanStreak = new Map<string, number>();
  // Spec 1313 Phase 5: agents with a fast-trigger drain already queued. A burst of
  // submit/quiescence signals for one agent coalesces onto the same pending promise
  // (one gate check, not one per trigger); the slot is released when the pass begins.
  private readonly scheduledDrains = new Map<string, Promise<void>>();

  constructor(opts: { intervalMs?: number; pruneRetentionDays?: number; escalationMs?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_BACKSTOP_INTERVAL_MS;
    this.retentionDays = opts.pruneRetentionDays ?? DEFAULT_PRUNE_RETENTION_DAYS;
    this.escalationMs = opts.escalationMs ?? DEFAULT_ESCALATION_MS;
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
  }

  /** Per-agent consecutive not-clean count (liveness telemetry; Phase 7 reads this). */
  get streaks(): ReadonlyMap<string, number> {
    return this.notCleanStreak;
  }

  /** One backstop pass. Guarded against re-entry so a slow gate can't overlap ticks. */
  async tick(): Promise<void> {
    const ports = this.ports;
    const db = this.db;
    if (!ports || !db || this.ticking) return;
    this.ticking = true;
    try {
      const agents = new Map<string, { workspacePath: string; toAgent: string }>();
      for (const row of listHeld(db)) {
        agents.set(agentKey(row.workspace_path, row.to_agent), {
          workspacePath: row.workspace_path,
          toAgent: row.to_agent,
        });
      }
      for (const [key, { workspacePath, toAgent }] of agents) {
        const outcome = await deliverAgentMailSerialized(ports, db, workspacePath, toAgent);
        this.recordStreak(key, outcome);
      }
      this.escalateOverdue(ports, db);
      pruneTerminal(db, this.retentionDays, ports.now());
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
      const ageMs = now - row.created_at;
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
    // Liveness telemetry (Spec 1313, Phase 7 — spec line 91): a sustained `no-profile`
    // streak means the session's app is unrecognized (a net-new or drifted classifier),
    // so its mail will NEVER deliver — surface it instead of holding silently. Scoped to
    // `no-profile` on purpose: a `busy` streak is a human present at the line (Constraint
    // 1 — legitimate, must not false-alarm), and `no-live-pty` is no session at all.
    // Reported once, exactly at the crossing, so a persistently-unknown app raises one
    // diagnostic rather than one per tick; the threshold filters transient boot/relaunch
    // screens. The pure module only reports the crossing — the live binding
    // ({@link DeliveryPorts.onLiveness}) applies the spec's "with recent output" gate and
    // does the loud log + broadcast, so an idle unknown session does not false-alarm.
    if (outcome.reason === 'no-profile' && next === LIVENESS_STREAK_THRESHOLD) {
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
    const key = agentKey(workspacePath, toAgent);
    const existing = this.scheduledDrains.get(key);
    if (existing) return existing;
    const run = Promise.resolve().then(async () => {
      this.scheduledDrains.delete(key);
      try {
        const outcome = await deliverAgentMailSerialized(ports, db, workspacePath, toAgent);
        this.recordStreak(key, outcome);
      } catch (err) {
        ports.log(`[mailbox] scheduled drain failed for ${toAgent}: ${String(err)}`);
      }
    });
    this.scheduledDrains.set(key, run);
    return run;
  }
}
