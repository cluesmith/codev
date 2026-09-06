/**
 * Bounded-patience send (Issue #1481) — `afx send --interrupt-after <seconds>`.
 *
 * The contract under test, stated as the three things that can go wrong:
 *
 *   1. it forces when it should not (the message was already delivered, the row was dismissed,
 *      Tower restarted, the session is gone or has been replaced);
 *   2. it writes the body TWICE, by racing the ordinary gated delivery of the same row;
 *   3. it reports a receipt it does not have.
 *
 * Everything below is aimed at one of those. The database is a real better-sqlite3 with the
 * production schema, the submission lock and row-ownership modules are the real ones, and the
 * composer double models the one TUI behaviour that makes double-writing visible: `^C` discards
 * pending input, Enter submits what has accumulated. Only the deadline CLOCK is faked, because
 * the whole feature is "what happens at an instant" and waiting out real seconds would make the
 * suite slow without making it more honest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import {
  MailboxInterruptCoordinator,
  validateInterruptAfterSeconds,
  type ForceOutcomeInfo,
  type ForcedDeliveryBroadcast,
  type InterruptPorts,
  type InterruptSession,
} from '../servers/mailbox-interrupt.js';
import { validateDelaySeconds, MAX_DELAY_SECONDS } from '../servers/delayed-send.js';
import {
  ownedRowWriteCount,
  resetRowWriteOwnership,
  tryAcquireRowWrite,
} from '../servers/row-write-ownership.js';
import {
  pendingSubmissionSessions,
  resetSubmissionChains,
  submitToSession,
} from '../servers/session-submit.js';
import { submitMessagePaced } from '../servers/message-write.js';
import {
  deliverAgentMail,
  type DeliveryPorts,
  type DeliverySession,
} from '../servers/mailbox-delivery.js';
import type { GateProfile, GateVerdict } from '../servers/render-gate.js';

const WS = '/ws/a';
const AGENT = 'pir-1481';
const PROFILE: GateProfile = { app: 'claude', markerPattern: /^❯/, regionEndPatterns: [] };
const CLEAN: GateVerdict = { clean: true, detail: 'empty' };
const BUSY: GateVerdict = { clean: false, reason: 'busy', detail: 'user-text' };
const BODY = 'wrap up soon';
/** ≥4 lines takes the paced multi-line path, so the write holds the line ~110 ms. */
const MULTILINE = 'L1\nL2\nL3\nL4';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `check` holds, so a test never depends on how many microtasks a path takes. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${what}`);
    await sleep(5);
  }
}

/** A composer that discards pending input on `^C`, as a real TUI does. */
function makeComposer(id = 'term-1') {
  let pending = '';
  const submitted: string[] = [];
  const interrupts: number[] = [];
  const state = { accept: true };
  const session = {
    id,
    get writable() {
      return true;
    },
    write(data: string): boolean {
      if (!state.accept) return false;
      if (data === '\r') {
        submitted.push(pending);
        pending = '';
      } else if (data === '\x03') {
        interrupts.push(submitted.length);
        pending = '';
      } else {
        pending += data;
      }
      return true;
    },
  };
  return {
    session,
    submitted,
    interrupts,
    state,
    get pending() {
      return pending;
    },
  };
}

/** Manual deadline clock: nothing fires until the test says so. */
function fakeClock(start = 0) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { fn: () => void; due: number }>();
  return {
    now: () => now,
    /** Delays the coordinator asked for, in order — the assertion that arming is absolute. */
    scheduled: [] as number[],
    setTimer(fn: () => void, ms: number): unknown {
      const id = nextId++;
      timers.set(id, { fn, due: now + ms });
      this.scheduled.push(ms);
      return id;
    },
    clearTimer(handle: unknown): void {
      timers.delete(handle as number);
    },
    /** Move time forward WITHOUT firing anything (models a slow classify before arming). */
    tick(ms: number): void {
      now += ms;
    },
    /** Move time forward and fire everything now due. */
    advance(ms: number): void {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.due <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

interface Recorded {
  broadcasts: ForcedDeliveryBroadcast[];
  outcomes: ForceOutcomeInfo[];
  heldChanges: number;
  logs: string[];
}

function makePorts(
  clock: ReturnType<typeof fakeClock>,
  resolve: () => InterruptSession | null,
  submitClock?: { sleep(ms: number): Promise<void> },
): { ports: InterruptPorts; rec: Recorded } {
  const rec: Recorded = { broadcasts: [], outcomes: [], heldChanges: 0, logs: [] };
  const ports: InterruptPorts = {
    getSessionForAgent: () => resolve(),
    broadcast: (frame) => rec.broadcasts.push(frame),
    onHeldStateChange: () => {
      rec.heldChanges++;
    },
    onForceOutcome: (info) => rec.outcomes.push(info),
    log: (m, level) => rec.logs.push(`${level ?? 'INFO'} ${m}`),
    now: () => clock.now(),
    setTimer: (fn, ms) => clock.setTimer(fn, ms),
    clearTimer: (handle) => clock.clearTimer(handle),
    ...(submitClock ? { submitClock } : {}),
  };
  return { ports, rec };
}

/** Wrap a composer as the DeliverySession the gated path expects. */
function sessionFor(session: { id: string; write(d: string): boolean }): DeliverySession {
  return {
    id: session.id,
    bytesWritten: 0,
    lastDataAt: 0,
    info: { cols: 110, rows: 32 },
    command: 'claude',
    launchArgs: [],
    cwd: WS,
    writable: true,
    write: (d: string) => session.write(d),
  };
}

/** Gated-delivery ports whose write edge is the REAL locked one. */
function deliveryPorts(session: DeliverySession, verdict: () => GateVerdict = () => CLEAN): DeliveryPorts {
  return {
    getSessionForAgent: () => session,
    resolveProfile: () => PROFILE,
    classify: () => Promise.resolve(verdict()),
    writeMessage: (s, msg, noEnter, precheck) => submitMessagePaced(s, msg, noEnter, precheck),
    broadcast: () => {},
    onHeldStateChange: () => {},
    onEscalation: () => {},
    onLiveness: () => {},
    watchEcho: () => Promise.resolve({ verify: () => Promise.resolve(true) }),
    log: () => {},
    now: () => Date.now(),
  };
}

describe('Issue #1481 — --interrupt-after validation', () => {
  it('accepts whole and fractional budgets up to the shared ceiling', () => {
    for (const value of [0.25, 1, 1.5, 30, MAX_DELAY_SECONDS]) {
      expect(validateInterruptAfterSeconds(value)).toBeNull();
    }
  });

  it('rejects zero, negatives, NaN, Infinity and non-numbers', () => {
    // NaN and Infinity are the ones that matter: `NaN > 0` and `NaN <= 0` are both false, so a
    // comparison chain would pass them through and produce a timer that fires immediately —
    // silently turning bounded patience into an unconditional `--interrupt`.
    expect(validateInterruptAfterSeconds(0)).toMatch(/greater than zero/);
    expect(validateInterruptAfterSeconds(-1)).toMatch(/greater than zero/);
    expect(validateInterruptAfterSeconds(Number.NaN)).toMatch(/finite number/);
    expect(validateInterruptAfterSeconds(Number.POSITIVE_INFINITY)).toMatch(/finite number/);
    expect(validateInterruptAfterSeconds('5')).toMatch(/finite number/);
    expect(validateInterruptAfterSeconds(null)).toMatch(/finite number/);
    expect(validateInterruptAfterSeconds(undefined)).toMatch(/finite number/);
    expect(validateInterruptAfterSeconds(MAX_DELAY_SECONDS + 1)).toMatch(/at most/);
  });

  it('points a zero budget at the flag that actually means "now"', () => {
    expect(validateInterruptAfterSeconds(0)).toContain('--interrupt');
  });

  it('leaves --delay integer-only — the two validators are not interchangeable', () => {
    // Reusing validateDelaySeconds would have rejected every fractional budget; relaxing IT to
    // match would have silently changed `--delay`. Pinned so a later tidy-up cannot merge them.
    expect(validateDelaySeconds(1.5)).toMatch(/whole number/);
    expect(validateInterruptAfterSeconds(1.5)).toBeNull();
  });
});

describe('Issue #1481 — persistence', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  const enqueue = (interruptAt: number | null) =>
    mailbox.enqueue(
      db,
      { workspacePath: WS, toAgent: AGENT, body: BODY, formattedMessage: BODY, interruptAt },
      1000,
    );

  it('persists the deadline as ARMED, with no claim and no prior-partial', () => {
    const row = enqueue(5000);
    const stored = mailbox.getById(db, row.id)!;
    expect(stored.interrupt_at).toBe(5000);
    expect(stored.interrupt_outcome).toBe('armed');
    expect(stored.interrupt_claimed_at).toBeNull();
    expect(stored.interrupt_prior_partial).toBe(0);
    // The row is HELD and ELIGIBLE — a deadline is not a delay.
    expect(stored.status).toBe('held');
    expect(stored.not_before).toBeNull();
    expect(mailbox.findHeldForAgent(db, WS, AGENT, 1000).map((r) => r.id)).toEqual([row.id]);
  });

  it('leaves an ordinary row untouched', () => {
    const stored = mailbox.getById(db, enqueue(null).id)!;
    expect(stored.interrupt_at).toBeNull();
    expect(stored.interrupt_outcome).toBeNull();
    expect(stored.interrupt_prior_partial).toBe(0);
  });

  it('claims held→delivered exactly once, and only while armed', () => {
    const row = enqueue(5000);
    expect(mailbox.claimForForcedInterrupt(db, row.id, 'claimed', 6000)).toBe(true);
    const claimed = mailbox.getById(db, row.id)!;
    expect(claimed.status).toBe('delivered');
    expect(claimed.interrupt_claimed_at).toBe(6000);
    expect(claimed.interrupt_outcome).toBe('claimed');
    // A second force — or a replay after a crash — finds nothing to claim.
    expect(mailbox.claimForForcedInterrupt(db, row.id, 'claimed', 7000)).toBe(false);
    expect(mailbox.getById(db, row.id)!.interrupt_claimed_at).toBe(6000);
  });

  it('refuses to claim a row another path already resolved', () => {
    const row = enqueue(5000);
    expect(mailbox.dismiss(db, row.id, 5500)).toBe(true);
    expect(mailbox.claimForForcedInterrupt(db, row.id, 'claimed', 6000)).toBe(false);
    expect(mailbox.getById(db, row.id)!.status).toBe('dismissed');
  });

  it('records a completion outcome only on a row this Tower claimed', () => {
    const claimedRow = enqueue(5000);
    const neverClaimed = enqueue(5000);
    mailbox.claimForForcedInterrupt(db, claimedRow.id, 'claimed-degraded', 6000);

    expect(mailbox.setForcedInterruptOutcome(db, claimedRow.id, 'degraded-written-unverified', 6100)).toBe(true);
    expect(mailbox.setForcedInterruptOutcome(db, neverClaimed.id, 'written-unverified', 6100)).toBe(false);
    expect(mailbox.getById(db, neverClaimed.id)!.interrupt_outcome).toBe('armed');
  });

  it('skips only a held, armed row and leaves the body deliverable', () => {
    const row = enqueue(5000);
    expect(mailbox.skipForcedInterrupt(db, row.id, 'skipped-offline', 6000)).toBe(true);
    const skipped = mailbox.getById(db, row.id)!;
    expect(skipped.status).toBe('held');
    expect(skipped.interrupt_outcome).toBe('skipped-offline');
    // Idempotent: a second skip finds nothing armed.
    expect(mailbox.skipForcedInterrupt(db, row.id, 'skipped-restart', 6100)).toBe(false);
  });

  it('records prior-partial monotonically, independent of the force outcome', () => {
    const row = enqueue(5000);
    expect(mailbox.markInterruptPriorPartial(db, row.id, 5100)).toBe(true);
    expect(mailbox.markInterruptPriorPartial(db, row.id, 5200)).toBe(false); // already recorded
    mailbox.claimForForcedInterrupt(db, row.id, 'claimed', 6000);
    mailbox.setForcedInterruptOutcome(db, row.id, 'written-unverified', 6100);
    // The uncertainty survives the force: it describes history, not force state.
    expect(mailbox.getById(db, row.id)!.interrupt_prior_partial).toBe(1);
  });

  it('disarms every leftover armed row on restart, whatever its deadline', () => {
    const future = enqueue(9_000);
    const overdue = enqueue(100);
    const ordinary = enqueue(null);
    const alreadyClaimed = enqueue(5000);
    mailbox.claimForForcedInterrupt(db, alreadyClaimed.id, 'claimed', 5000);

    expect(mailbox.disarmInterruptsOnRestart(db, 6000)).toBe(2);

    // Both retired — a future deadline is NOT rearmed: the turn it meant to interrupt is over.
    expect(mailbox.getById(db, future.id)!.interrupt_outcome).toBe('skipped-restart');
    expect(mailbox.getById(db, overdue.id)!.interrupt_outcome).toBe('skipped-restart');
    // ...and both messages are still held, so nothing is lost, only the force.
    expect(mailbox.getById(db, future.id)!.status).toBe('held');
    expect(mailbox.getById(db, overdue.id)!.status).toBe('held');
    // Untouched: an ordinary row, and a row a previous lifetime already claimed (never replayed,
    // even though its write outcome after a crash is unknown).
    expect(mailbox.getById(db, ordinary.id)!.interrupt_outcome).toBeNull();
    expect(mailbox.getById(db, alreadyClaimed.id)!.interrupt_outcome).toBe('claimed');
    expect(mailbox.findArmedInterrupts(db)).toEqual([]);
  });
});

describe('Issue #1481 — the escalation at the deadline', () => {
  let db: Database.Database;
  let clock: ReturnType<typeof fakeClock>;
  let coordinator: MailboxInterruptCoordinator;

  beforeEach(() => {
    resetSubmissionChains();
    resetRowWriteOwnership();
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    clock = fakeClock(1000);
    coordinator = new MailboxInterruptCoordinator();
  });

  afterEach(() => {
    coordinator.stop();
    db.close();
  });

  const enqueue = (opts: { deadlineIn?: number; noEnter?: boolean; body?: string } = {}) =>
    mailbox.enqueue(
      db,
      {
        workspacePath: WS,
        toAgent: AGENT,
        body: opts.body ?? BODY,
        formattedMessage: opts.body ?? BODY,
        noEnter: opts.noEnter,
        interruptAt: clock.now() + (opts.deadlineIn ?? 1000),
      },
      clock.now(),
    );

  it('writes Ctrl+C, then the body, then Enter — and records what it wrote, not a receipt', async () => {
    const c = makeComposer();
    const { ports, rec } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();

    coordinator.arm(row);
    expect(c.interrupts).toEqual([]); // nothing happens before the deadline

    clock.advance(1000);
    await waitFor(() => mailbox.getById(db, row.id)!.interrupt_outcome === 'written-unverified', 'force');

    expect(c.interrupts).toEqual([0]); // the ^C came first, before anything was submitted
    expect(c.submitted).toEqual([BODY]);
    const stored = mailbox.getById(db, row.id)!;
    expect(stored.status).toBe('delivered');
    expect(stored.interrupt_claimed_at).toBe(2000);
    // `written-unverified`, never a bare "delivered": every byte was accepted, and that is ALL
    // that is known. The outcome vocabulary exists to keep that distinction sayable.
    expect(stored.interrupt_outcome).toBe('written-unverified');
    expect(rec.outcomes.map((o) => o.outcome)).toEqual(['written-unverified']);
  });

  it('omits the Enter for a no-enter message — staged, not submitted', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue({ noEnter: true });

    coordinator.arm(row);
    clock.advance(1000);
    await waitFor(() => mailbox.getById(db, row.id)!.status === 'delivered', 'claim');
    await sleep(120);

    expect(c.interrupts).toEqual([0]);
    expect(c.submitted).toEqual([]); // nothing was submitted...
    expect(c.pending).toBe(BODY); // ...the body is staged in the composer
  });

  it('arms against the ABSOLUTE deadline, so a slow first delivery cannot extend patience', () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue({ deadlineIn: 1000 });

    // 900 ms of the budget is spent before the coordinator ever sees the row — exactly what a
    // slow classify on the initial gated attempt would do if arming happened after the await.
    clock.tick(900);
    coordinator.arm(row);

    expect(clock.scheduled).toEqual([100]); // 100 ms left of the budget, not a fresh 1000
  });

  it('fires at once for a deadline that has already passed', () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue({ deadlineIn: 1000 });
    clock.tick(5000);

    coordinator.arm(row);

    expect(clock.scheduled).toEqual([0]);
  });

  it('does NOT force a row the gate delivered first — no Ctrl+C at all', async () => {
    const c = makeComposer();
    const { ports, rec } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    // The ordinary path wins during the patience window.
    mailbox.markDelivered(db, row.id, clock.now() + 500);
    clock.advance(1000);
    await sleep(160);

    expect(c.interrupts).toEqual([]);
    expect(c.submitted).toEqual([]);
    expect(rec.broadcasts).toEqual([]);
    expect(coordinator.pending).toEqual([]);
    // Row status is authoritative for cancellation: the outcome is left as it was.
    expect(mailbox.getById(db, row.id)!.interrupt_outcome).toBe('armed');
  });

  it('does NOT force a dismissed row', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    mailbox.dismiss(db, row.id, clock.now() + 500);
    clock.advance(1000);
    await sleep(160);

    expect(c.interrupts).toEqual([]);
    expect(mailbox.getById(db, row.id)!.status).toBe('dismissed');
  });

  it('skips when the agent has no live session at the deadline, leaving the body held', async () => {
    const { ports, rec } = makePorts(clock, () => null);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    clock.advance(1000);
    await waitFor(() => mailbox.getById(db, row.id)!.interrupt_outcome === 'skipped-offline', 'skip');

    const stored = mailbox.getById(db, row.id)!;
    expect(stored.status).toBe('held'); // the MESSAGE survives; only the force is lost
    expect(rec.broadcasts).toEqual([]); // nothing was delivered, so no delivery event
    expect(rec.outcomes.map((o) => o.outcome)).toEqual(['skipped-offline']);
  });

  it('skips rather than retargeting a session replaced while it queued', async () => {
    const first = makeComposer('term-old');
    const replacement = makeComposer('term-new');
    let calls = 0;
    // Resolves to the old session at dispatch and the new one at the write edge — the shape of a
    // PTY respawn landing while the force waits for the terminal lock.
    const { ports, rec } = makePorts(clock, () => (++calls === 1 ? first.session : replacement.session));
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    clock.advance(1000);
    await waitFor(
      () => mailbox.getById(db, row.id)!.interrupt_outcome === 'skipped-session-replaced',
      'session-replaced skip',
    );

    // Neither terminal was written to: not the dead one, and not a fresh turn that has nothing
    // to do with the one the operator meant to interrupt.
    expect(first.interrupts).toEqual([]);
    expect(replacement.interrupts).toEqual([]);
    expect(mailbox.getById(db, row.id)!.status).toBe('held');
    expect(rec.outcomes.map((o) => o.outcome)).toEqual(['skipped-session-replaced']);
  });

  it('stop() cancels a pending deadline', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    coordinator.arm(enqueue());

    coordinator.stop();
    clock.advance(1000);
    await sleep(160);

    expect(c.interrupts).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it('start() retires a previous lifetime\'s escalations before any writer runs', async () => {
    const c = makeComposer();
    const row = enqueue({ deadlineIn: 5000 }); // still in the future
    const { ports, rec } = makePorts(clock, () => c.session);

    coordinator.start(ports, db);

    expect(mailbox.getById(db, row.id)!.interrupt_outcome).toBe('skipped-restart');
    expect(rec.heldChanges).toBe(1); // ONE refresh for the whole sweep
    // Arming it now is refused — the row is no longer armed, so nothing can force it.
    coordinator.arm(mailbox.getById(db, row.id)!);
    expect(coordinator.pending).toEqual([]);
    clock.advance(5000);
    await sleep(160);
    expect(c.interrupts).toEqual([]);
  });

  it('reports a write the terminal rejected as failed, and never re-sends it', async () => {
    const c = makeComposer();
    const { ports, rec } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);
    c.state.accept = false; // #1198: a dead shellper socket silently drops every write

    clock.advance(1000);
    await waitFor(() => mailbox.getById(db, row.id)!.interrupt_outcome === 'failed', 'failed outcome');

    const stored = mailbox.getById(db, row.id)!;
    // Claimed before the write, so it stays terminal: re-holding would let the backstop
    // gate-deliver a second copy of a body that may be partly on the line already.
    expect(stored.status).toBe('delivered');
    expect(rec.outcomes.map((o) => o.outcome)).toEqual(['failed']);
  });

  it('emits exactly one delivery event, one held-state refresh and one outcome notice', async () => {
    const c = makeComposer();
    const { ports, rec } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    clock.advance(1000);
    await waitFor(() => rec.outcomes.length > 0, 'outcome');
    await sleep(120);

    expect(rec.heldChanges).toBe(1);
    expect(rec.broadcasts).toHaveLength(1);
    expect(rec.outcomes).toHaveLength(1);
    // The feed frame carries the audit, so nothing downstream can render it as a clean receipt.
    expect(rec.broadcasts[0]).toMatchObject({
      toAgent: AGENT,
      body: BODY,
      outcome: 'written-unverified',
      priorPartial: false,
    });
  });

  it('forces the newer armed row without disturbing older ordinary held mail', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const older = mailbox.enqueue(
      db,
      { workspacePath: WS, toAgent: AGENT, body: 'older', formattedMessage: 'older' },
      clock.now() - 60_000,
    );
    const armed = enqueue();
    coordinator.arm(armed);

    clock.advance(1000);
    await waitFor(() => c.submitted.length === 1, 'force');

    // A timed force overtakes older held mail exactly as an immediate `--interrupt` does; it
    // does not claim, clear or deliver those rows.
    expect(c.submitted).toEqual([BODY]);
    expect(mailbox.getById(db, older.id)!.status).toBe('held');
  });

  it('leaves no lock or ownership state behind', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    coordinator.arm(enqueue());
    clock.advance(1000);
    await waitFor(() => c.submitted.length === 1, 'force');
    await sleep(120);

    expect(ownedRowWriteCount()).toBe(0);
    expect(pendingSubmissionSessions()).toBe(0);
    expect(coordinator.pending).toEqual([]);
  });
});

describe('Issue #1481 — the force and the ordinary delivery cannot write the same row twice', () => {
  let db: Database.Database;
  let clock: ReturnType<typeof fakeClock>;
  let coordinator: MailboxInterruptCoordinator;

  beforeEach(() => {
    resetSubmissionChains();
    resetRowWriteOwnership();
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    clock = fakeClock(1000);
    coordinator = new MailboxInterruptCoordinator();
  });

  afterEach(() => {
    coordinator.stop();
    db.close();
  });

  const enqueue = (body = BODY) =>
    mailbox.enqueue(
      db,
      { workspacePath: WS, toAgent: AGENT, body, formattedMessage: body, interruptAt: clock.now() + 1000 },
      clock.now(),
    );

  it('stands aside for an in-flight gated write and cancels when it delivers', async () => {
    const c = makeComposer();
    const { ports, rec } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue(MULTILINE);
    coordinator.arm(row);

    // The REAL gated path, mid paced write (≈110 ms for four lines). Throughout it the row still
    // reads `held` in the database — which is precisely why "held" cannot be used as "idle".
    const delivery = deliverAgentMail(deliveryPorts(sessionFor(c.session)), db, WS, AGENT);
    await sleep(15);
    expect(mailbox.getById(db, row.id)!.status).toBe('held');

    clock.advance(1000); // the deadline lands INSIDE the delivery's write
    const outcome = await delivery;
    await sleep(160);

    expect(outcome.delivered).toEqual([row.id]);
    expect(c.submitted).toEqual([MULTILINE]); // ONE body, not two
    expect(c.interrupts).toEqual([]); // and no Ctrl+C at all
    expect(rec.broadcasts).toEqual([]);
    expect(coordinator.pending).toEqual([]);
  });

  it('proceeds after an owned attempt that wrote nothing', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    // Someone owns the row but has not written: the force must not write concurrently...
    const owner = tryAcquireRowWrite(row.id)!;
    clock.advance(1000);
    await sleep(120);
    expect(c.interrupts).toEqual([]);

    // ...and must resume once that attempt is known to have written nothing.
    owner.settle('no-bytes');
    await waitFor(() => c.submitted.length === 1, 'force after no-byte attempt');
    expect(c.submitted).toEqual([BODY]);
    expect(mailbox.getById(db, row.id)!.interrupt_outcome).toBe('written-unverified');
  });

  it('still forces after an UNCERTAIN attempt, and says the effects may be duplicated', async () => {
    const c = makeComposer();
    const { ports, rec } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    const owner = tryAcquireRowWrite(row.id)!;
    clock.advance(1000);
    await sleep(120);

    // A dropped/preempted/throwing ordinary write: bytes MAY be out, the row is still held, and
    // the ordinary path is itself still allowed to retry it. So the escalation the operator
    // asked for stands — with the duplicate risk recorded rather than silently accepted.
    mailbox.markInterruptPriorPartial(db, row.id, clock.now());
    owner.settle('uncertain');

    await waitFor(() => c.submitted.length === 1, 'force after uncertain attempt');
    expect(mailbox.getById(db, row.id)!.interrupt_prior_partial).toBe(1);
    expect(rec.outcomes[0]).toMatchObject({ outcome: 'written-unverified', priorPartial: true });
    expect(rec.broadcasts[0].priorPartial).toBe(true);
  });

  it('a gated write that was preempted records prior-partial and stays armed', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue(MULTILINE);
    coordinator.arm(row);

    // A ceiling-expired operator writes into the delivery mid-pace → `preempted`: bytes went
    // out, but the composer may have been cleared under them.
    const delivery = deliverAgentMail(deliveryPorts(sessionFor(c.session)), db, WS, AGENT);
    await sleep(15);
    await submitToSession(c.session.id, () => { c.session.write('\x03'); return 0; }, undefined, {
      waitCeilingMs: 0,
    });
    const outcome = await delivery;

    expect(outcome.delivered).toEqual([]);
    const stored = mailbox.getById(db, row.id)!;
    expect(stored.status).toBe('held'); // re-held for the ordinary path, as before #1481
    expect(stored.interrupt_outcome).toBe('armed'); // ...and the force is NOT disarmed by it
    expect(stored.interrupt_prior_partial).toBe(1); // ...but the uncertainty is on the record
  });

  it('a gated pass declines a row a force is writing, rather than duplicating it', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    clock.advance(1000);
    await waitFor(() => c.interrupts.length === 1, 'force started');

    // A backstop tick landing while the force writes: the row's ownership is taken, so the
    // gated pass writes nothing — and by the time it could retry, the claim has made the row
    // terminal anyway.
    const outcome = await deliverAgentMail(deliveryPorts(sessionFor(c.session)), db, WS, AGENT);
    await sleep(160);

    expect(outcome.delivered).toEqual([]);
    expect(c.submitted).toEqual([BODY]); // exactly one body
  });

  it('records a degraded ENTRY on the claim itself, not only on completion', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session, { sleep: () => Promise.resolve() });
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    // Hold the terminal with a long write for something else, so the force's wait ceiling
    // expires and it enters ahead of unfinished work. The ceiling is driven by the injected
    // submit clock rather than by making the blocking write outlast a real two-second ceiling —
    // the fact under test is what the force RECORDS when it enters degraded, not how long a
    // real ceiling is.
    const blocking = submitMessagePaced(c.session, MULTILINE, false, () => null);
    await sleep(10);

    clock.advance(1000);
    await waitFor(() => mailbox.getById(db, row.id)!.interrupt_claimed_at !== null, 'claim');

    // The degradation is recorded by the CLAIM statement itself — `onDegradedEntry` fires before
    // the first byte — so it survives even when no completion update ever lands (a crash, a
    // closed database). Here the completion does land, and carries it forward rather than
    // flattening it into a plain success. The claim-time-only shape is pinned separately, by the
    // repository test that writes `claimed-degraded` and never completes it.
    await waitFor(
      () => mailbox.getById(db, row.id)!.interrupt_outcome === 'degraded-written-unverified',
      'degraded completion',
    );
    // The delivery it bypassed is the one that reports interference — the force does not
    // pretend it was clean.
    expect(await blocking).toEqual({ status: 'preempted' });
  });

  it('never forces a row whose ordinary delivery completed, even after the deadline', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    const outcome = await deliverAgentMail(deliveryPorts(sessionFor(c.session)), db, WS, AGENT);
    expect(outcome.delivered).toEqual([row.id]);

    clock.advance(5000);
    await sleep(160);

    expect(c.submitted).toEqual([BODY]); // still exactly one
    expect(c.interrupts).toEqual([]);
  });

  it('holds the row through the force write, so nothing else can start one', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    clock.advance(1000);
    await waitFor(() => c.interrupts.length === 1, 'force started');
    // Mid-write: ownership is held, so a second writer is refused rather than queued.
    expect(tryAcquireRowWrite(row.id)).toBeNull();

    await waitFor(() => c.submitted.length === 1, 'force finished');
    await sleep(20);
    expect(ownedRowWriteCount()).toBe(0); // released once the paced write completed
  });

  it('a busy gate is no obstacle — that is the entire point of the flag', async () => {
    const c = makeComposer();
    const { ports } = makePorts(clock, () => c.session);
    coordinator.start(ports, db);
    const row = enqueue();
    coordinator.arm(row);

    // The gate says the composer is occupied, so the ordinary path holds the row forever...
    const outcome = await deliverAgentMail(deliveryPorts(sessionFor(c.session), () => BUSY), db, WS, AGENT);
    expect(outcome).toMatchObject({ delivered: [], reason: 'busy' });
    expect(c.submitted).toEqual([]);

    // ...and the force delivers it anyway, ungated, once patience runs out.
    clock.advance(1000);
    await waitFor(() => c.submitted.length === 1, 'force through a busy gate');
    expect(c.interrupts).toEqual([0]);
    expect(mailbox.getById(db, row.id)!.status).toBe('delivered');
  });
});
