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
import { findHeldForAgent, listHeld, markDelivered, setHeldReason, pruneTerminal } from '../db/mailbox.js';
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
  log(message: string): void;
  now(): number;
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
  private readonly notCleanStreak = new Map<string, number>();

  constructor(opts: { intervalMs?: number; pruneRetentionDays?: number } = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_BACKSTOP_INTERVAL_MS;
    this.retentionDays = opts.pruneRetentionDays ?? DEFAULT_PRUNE_RETENTION_DAYS;
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
        if (outcome.delivered.length > 0 || outcome.reason === null) {
          this.notCleanStreak.delete(key);
        } else {
          this.notCleanStreak.set(key, (this.notCleanStreak.get(key) ?? 0) + 1);
        }
      }
      pruneTerminal(db, this.retentionDays, ports.now());
    } finally {
      this.ticking = false;
    }
  }
}
