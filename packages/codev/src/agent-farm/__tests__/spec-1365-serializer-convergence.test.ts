/**
 * Serializer convergence (Issue #1365) — the gated mailbox write edge takes the same
 * per-terminal submission lock as `--interrupt` / `--escape`.
 *
 * Before this change the two paths held DISJOINT locks (per-agent for deliveries,
 * per-terminal for operator actions), so they could interleave on one terminal. The
 * failure that mattered was not a garbled composer but a **false `delivered`**: a `^C`
 * landing inside a delivery's text→Enter window cleared the composer, the delivery's Enter
 * submitted nothing, every byte still reported success, and the row was marked delivered
 * for a message the agent never saw. `--escape` produces the truncated variant.
 *
 * The composer double below is what makes that visible: it models the one TUI behaviour the
 * bug depends on — `^C`/ESC discard pending input, Enter submits whatever has accumulated.
 * Each corruption test is paired with a bypass-the-lock control that reproduces the original
 * bug, so these assert the fix rather than merely exercising it.
 *
 * Real timers throughout (the paced writer schedules on real `setTimeout`), with the
 * production pacing constants: lines 10 ms apart, Enter 80 ms after the last line.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import {
  submitToSession,
  trySubmitToSession,
  isSubmissionInFlight,
  pendingSubmissionSessions,
  resetSubmissionChains,
  unserializedWriteCount,
  OPERATOR_SUBMIT_WAIT_CEILING_MS,
} from '../servers/session-submit.js';
import {
  submitMessagePaced,
  writeMessageToSession,
  writeEscapeToSession,
} from '../servers/message-write.js';
import {
  deliverAgentMail,
  MailboxDrainer,
  type DeliveryPorts,
  type DeliverySession,
  type WriteAbort,
} from '../servers/mailbox-delivery.js';
import type { GateProfile, GateVerdict } from '../servers/render-gate.js';

const PROFILE: GateProfile = { app: 'claude', markerPattern: /^❯/, regionEndPatterns: [] };
const CLEAN: GateVerdict = { clean: true, detail: 'empty' };
const WS = '/ws/a';
const AGENT = 'spir-1';

/** A body long enough to take the paced multi-line path (≥4 lines) and so hold the line ~110 ms. */
const MULTILINE = 'L1\nL2\nL3\nL4';
/** Time for a MULTILINE paced write to finish: last line at 30 ms + the 80 ms Enter delay. */
const MULTILINE_DONE_MS = 3 * 10 + 80;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A composer that models the failure. `^C` and ESC discard pending input the way a real
 * TUI does; Enter submits whatever has accumulated. Everything else is text.
 */
function makeComposer(id = 'term-1') {
  let pending = '';
  const submitted: string[] = [];
  const bypasses: string[] = [];
  const session = {
    id,
    write(data: string): boolean {
      if (data === '\r') {
        submitted.push(pending);
        pending = '';
      } else if (data === '\x03') {
        bypasses.push('interrupt');
        pending = '';
      } else if (data === '\x1b') {
        bypasses.push('escape');
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
    bypasses,
    get pending() {
      return pending;
    },
  };
}

/** The immediate `--interrupt` submission, exactly as tower-routes issues it. */
function interruptSubmission(session: { id: string; write(d: string): boolean }, body: string) {
  return () => {
    session.write('\x03');
    return writeMessageToSession(session, body, false, 100);
  };
}

/** A gated delivery's write edge, as mailbox-wiring binds it. */
function deliveryWrite(session: { id: string; write(d: string): boolean }, body: string) {
  return submitMessagePaced(session, body, false, () => null);
}

describe('Issue #1365 — the gated write edge and the operator paths share one lock', () => {
  beforeEach(() => resetSubmissionChains());

  it('an interrupt cannot land inside a delivery text→Enter window (the false-delivered bug)', async () => {
    const c = makeComposer();

    const delivery = deliveryWrite(c.session, MULTILINE);
    const interrupt = submitToSession(c.session.id, interruptSubmission(c.session, 'INT'));
    const [result] = await Promise.all([delivery, interrupt]);

    // The delivery's body was submitted WHOLE, and the interrupt's separately.
    expect(c.submitted).toEqual([MULTILINE, 'INT']);
    // ...and only then may the row be marked delivered.
    expect(result).toEqual({ status: 'written' });
  });

  it('CONTROL: bypassing the lock reproduces the original bug — body lost, write still "succeeds"', async () => {
    const c = makeComposer();

    // Exactly the pre-#1365 delivery edge: a paced write under no per-terminal lock.
    writeMessageToSession(c.session, MULTILINE, false);
    await submitToSession(c.session.id, interruptSubmission(c.session, 'INT'));
    await sleep(MULTILINE_DONE_MS + 20);

    // The ^C cleared the composer mid-write; the delivery's Enter submitted an empty line.
    // Every byte reached the PTY, so the old boolean-returning port reported success and the
    // row was marked delivered — a message the agent never saw.
    expect(c.submitted).not.toContain(MULTILINE);
    expect(c.submitted).toContain('');
  });

  it('an escape cannot truncate an in-flight multi-line delivery', async () => {
    const c = makeComposer();

    const delivery = deliveryWrite(c.session, MULTILINE);
    const escape = submitToSession(c.session.id, () => writeEscapeToSession(c.session, false));
    const [result] = await Promise.all([delivery, escape]);

    expect(c.submitted[0]).toBe(MULTILINE); // whole, not a tail of it
    expect(result).toEqual({ status: 'written' });
  });

  it('CONTROL: bypassing the lock lets an escape submit a TRUNCATED body', async () => {
    const c = makeComposer();

    writeMessageToSession(c.session, MULTILINE, false);
    await submitToSession(c.session.id, () => writeEscapeToSession(c.session, false));
    await sleep(MULTILINE_DONE_MS + 20);

    // The ESC discarded the lines written so far; the escape's own Enter then submitted the
    // remainder as if it were the whole message.
    expect(c.submitted[0]).not.toBe(MULTILINE);
    expect(MULTILINE.endsWith(c.submitted[0])).toBe(true); // a strict tail — i.e. truncated
    expect(c.submitted[0].length).toBeLessThan(MULTILINE.length);
  });

  it('two deliveries to one terminal still cannot interleave', async () => {
    const c = makeComposer();

    const first = deliveryWrite(c.session, MULTILINE);
    // A second delivery arriving mid-write is DECLINED, not queued — the caller re-holds.
    const second = await deliveryWrite(c.session, 'SECOND');
    expect(second).toEqual({ status: 'contended' });
    expect(await first).toEqual({ status: 'written' });
    expect(c.submitted).toEqual([MULTILINE]);
  });

  it('deliveries to DIFFERENT terminals do not serialize (the lock key is the real session id)', async () => {
    const a = makeComposer('term-a');
    const b = makeComposer('term-b');

    const [ra, rb] = await Promise.all([deliveryWrite(a.session, MULTILINE), deliveryWrite(b.session, MULTILINE)]);

    // Both ran. Were the key `undefined` for every session — the hazard a structurally-typed
    // fake without an `id` would create — the second would have been declined as contended.
    expect(ra).toEqual({ status: 'written' });
    expect(rb).toEqual({ status: 'written' });
    expect(a.submitted).toEqual([MULTILINE]);
    expect(b.submitted).toEqual([MULTILINE]);
  });

  it('a session with no id throws instead of keying every lock on undefined', async () => {
    const c = makeComposer();
    const idless = { ...c.session, id: '' as string };

    await expect(submitMessagePaced(idless, 'hi', false, () => null)).rejects.toThrow(/non-empty string/);
    expect(c.submitted).toHaveLength(0);
  });

  it('the returned promise resolves only AFTER the trailing Enter', async () => {
    const c = makeComposer();
    const result = await deliveryWrite(c.session, MULTILINE);
    // Resolution implies submission — the property the per-agent serializer's completion
    // chaining depends on. No extra wait: the Enter has already fired.
    expect(c.submitted).toEqual([MULTILINE]);
    expect(result).toEqual({ status: 'written' });
  });

  it('reports a dropped write (#1198) rather than a delivery', async () => {
    const session = { id: 'term-dead', write: () => false };
    expect(await submitMessagePaced(session, MULTILINE, false, () => null)).toEqual({ status: 'dropped' });
  });

  it('an in-lock precheck refusal writes nothing', async () => {
    const c = makeComposer();
    const abort: WriteAbort = { kind: 'hold', reason: 'busy' };

    const result = await submitMessagePaced(c.session, MULTILINE, false, () => abort);

    expect(result).toEqual({ status: 'aborted', abort });
    expect(c.submitted).toHaveLength(0);
    expect(c.pending).toBe(''); // not one byte, not even un-submitted text
  });

  it('leaves no chain behind once mixed traffic settles', async () => {
    const c = makeComposer();
    await Promise.all([
      deliveryWrite(c.session, MULTILINE),
      submitToSession(c.session.id, interruptSubmission(c.session, 'INT')),
      submitToSession(c.session.id, () => writeEscapeToSession(c.session, false)),
    ]);
    await sleep(10);
    expect(pendingSubmissionSessions()).toBe(0);
    expect(isSubmissionInFlight(c.session.id)).toBe(false);
  });
});

describe('Issue #1365 — deliveries decline contention, operators wait (bounded)', () => {
  beforeEach(() => resetSubmissionChains());

  it('a delivery declines a contended terminal IMMEDIATELY instead of queueing', async () => {
    const c = makeComposer();
    // An operator holds the line for well over a backstop tick.
    const holder = submitToSession(c.session.id, () => {
      c.session.write('slow');
      setTimeout(() => c.session.write('\r'), 300);
      return 300;
    });

    const startedAt = Date.now();
    const result = await trySubmitToSession(c.session.id, () => 0);
    const waited = Date.now() - startedAt;

    expect(result).toBe(false);
    expect(waited).toBeLessThan(100); // did not wait out the 300 ms holder
    await holder;
  });

  it('the drainer keeps delivering to OTHER agents while one terminal is held', async () => {
    // The liveness property: MailboxDrainer.tick walks agents sequentially, so a delivery
    // that blocked on a terminal lock would stall every other agent behind it.
    const busy = makeComposer('term-busy');
    const free = makeComposer('term-free');
    const db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    try {
      const sessions = new Map<string, DeliverySession>([
        ['agent-busy', sessionFor(busy.session)],
        ['agent-free', sessionFor(free.session)],
      ]);
      const ports = livePorts(sessions);
      mailbox.enqueue(db, { workspacePath: WS, toAgent: 'agent-busy', body: 'a', formattedMessage: 'A' }, 1000);
      mailbox.enqueue(db, { workspacePath: WS, toAgent: 'agent-free', body: 'b', formattedMessage: 'B' }, 1000);

      const holder = submitToSession('term-busy', () => {
        setTimeout(() => busy.session.write('held'), 250);
        return 250;
      });

      const startedAt = Date.now();
      const drainer = new MailboxDrainer({ intervalMs: 999_999 });
      drainer.start(ports, db);
      await drainer.tick();
      drainer.stop();
      const tickMs = Date.now() - startedAt;

      expect(free.submitted).toEqual(['B']); // the unblocked agent was served
      expect(tickMs).toBeLessThan(250); // and the tick did not wait out the held terminal
      await holder;
    } finally {
      db.close();
    }
  });

  it('an operator submission stops waiting at the ceiling and says so', async () => {
    const c = makeComposer();
    const ceilingMs = 40;
    const expired: number[] = [];

    // The holder must be a DELIVERY write: since the codex review of PR #1492 the ceiling
    // deliberately refuses to bypass another OPERATOR, so an operator holder would (correctly)
    // never expire this ceiling at all.
    const holder = trySubmitToSession(c.session.id, () => {
      setTimeout(() => c.session.write('\r'), 400);
      return 400;
    });
    const startedAt = Date.now();
    await submitToSession(c.session.id, () => { c.session.write('\x03'); return 0; }, undefined, {
      waitCeilingMs: ceilingMs,
      onCeilingExpired: (ms) => expired.push(ms),
    });
    const waited = Date.now() - startedAt;

    expect(expired).toEqual([ceilingMs]); // degraded, and announced
    expect(waited).toBeLessThan(400); // did not wait out the holder
    expect(c.bypasses).toEqual(['interrupt']); // the ^C did go out — the escape hatch still works
    expect(unserializedWriteCount(c.session.id)).toBe(1);
    await holder;
  });

  it('an operator submission below the ceiling still serializes normally', async () => {
    const c = makeComposer();
    const expired: number[] = [];

    const delivery = deliveryWrite(c.session, MULTILINE); // ~110 ms, well under the ceiling
    await submitToSession(c.session.id, interruptSubmission(c.session, 'INT'), undefined, {
      waitCeilingMs: OPERATOR_SUBMIT_WAIT_CEILING_MS,
      onCeilingExpired: (ms) => expired.push(ms),
    });

    expect(expired).toEqual([]);
    expect(await delivery).toEqual({ status: 'written' });
    expect(c.submitted).toEqual([MULTILINE, 'INT']);
  });

  it('operator vs operator NEVER degrades — the wait stays unbounded, as before #1365', async () => {
    // The regression codex caught in PR #1492 review. Before this change `submitToSession` had
    // no ceiling at all, so two operator submissions to one terminal were ALWAYS fully
    // serialized. A ceiling that could skip a body-bearing operator would make this one pair
    // strictly WORSE than the old behaviour — the opposite of the point.
    const c = makeComposer();
    const expired: number[] = [];

    // A body-bearing interrupt that holds the line far longer than the ceiling.
    const first = submitToSession(c.session.id, interruptSubmission(c.session, 'OP-ONE'), undefined, {
      waitCeilingMs: 30,
      onCeilingExpired: (ms) => expired.push(ms),
    });
    await sleep(5);
    const second = submitToSession(c.session.id, interruptSubmission(c.session, 'OP-TWO'), undefined, {
      waitCeilingMs: 30, // would fire long before the first operator finishes, if it were armed
      onCeilingExpired: (ms) => expired.push(ms),
    });
    await Promise.all([first, second]);

    expect(expired).toEqual([]); // neither operator gave up on the other
    expect(c.submitted).toEqual(['OP-ONE', 'OP-TWO']); // strictly ordered, neither clobbered
  });

  it('a THIRD operator does not bypass a QUEUED one (a waiting operator counts, not just a writing one)', async () => {
    const c = makeComposer();
    const expired: number[] = [];
    const opts = { waitCeilingMs: 30, onCeilingExpired: (ms: number) => expired.push(ms) };

    // Head is a DELIVERY (bypassable); B queues behind it; C must not skip B.
    const delivery = deliveryWrite(c.session, MULTILINE);
    await sleep(5);
    const b = submitToSession(c.session.id, interruptSubmission(c.session, 'OP-B'), undefined, opts);
    await sleep(5);
    const c3 = submitToSession(c.session.id, interruptSubmission(c.session, 'OP-C'), undefined, opts);
    await Promise.all([delivery, b, c3]);

    // B may degrade past the delivery (that is the ceiling's whole purpose); C may not
    // degrade past B, so at most one degradation is recorded and the operators stay ordered.
    expect(expired.length).toBeLessThanOrEqual(1);
    const ops = c.submitted.filter((s) => s.startsWith('OP-'));
    expect(ops).toEqual(['OP-B', 'OP-C']);
  });

  it('a delivery raced by a ceiling-expired write reports preempted, never written', async () => {
    // The one hole the ceiling opens: an operator that gave up waiting writes into a
    // delivery already on the wire. Detected by counting lock bypasses — no re-classify.
    const c = makeComposer();

    const delivery = deliveryWrite(c.session, MULTILINE);
    await sleep(5); // let the delivery take the lock
    await submitToSession(c.session.id, () => { c.session.write('\x03'); return 0; }, undefined, {
      waitCeilingMs: 0, // give up at once — the degraded path
    });

    expect(await delivery).toEqual({ status: 'preempted' });
  });
});

/** Wrap a composer as the DeliverySession the delivery path expects. */
function sessionFor(session: { id: string; write(d: string): boolean }): DeliverySession {
  return {
    id: session.id,
    bytesWritten: 0,
    info: { cols: 110, rows: 32 },
    command: 'claude',
    launchArgs: [],
    cwd: WS,
    writable: true,
    write: (d: string) => session.write(d),
  };
}

/** Delivery ports whose write edge is the REAL locked one, so the lock is under test. */
function livePorts(sessions: Map<string, DeliverySession>, log: string[] = []): DeliveryPorts {
  return {
    getSessionForAgent: (_ws, agent) => sessions.get(agent) ?? null,
    resolveProfile: () => PROFILE,
    classify: () => Promise.resolve(CLEAN),
    writeMessage: (session, msg, noEnter, precheck) => submitMessagePaced(session, msg, noEnter, precheck),
    broadcast: () => {},
    onHeldStateChange: () => {},
    onEscalation: () => {},
    onLiveness: () => {},
    log: (m) => log.push(m),
    now: () => 1000,
  };
}

describe('Issue #1365 — a raced delivery is held, never marked delivered', () => {
  let db: Database.Database;
  beforeEach(() => {
    resetSubmissionChains();
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  const enqueue = (formattedMessage = MULTILINE) =>
    mailbox.enqueue(db, { workspacePath: WS, toAgent: AGENT, body: 'hi', formattedMessage }, 1000);

  it('an uncontended delivery still delivers and marks the row', async () => {
    const c = makeComposer();
    const ports = livePorts(new Map([[AGENT, sessionFor(c.session)]]));
    const row = enqueue();

    const out = await deliverAgentMail(ports, db, WS, AGENT);

    expect(out.delivered).toEqual([row.id]);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
    expect(c.submitted).toEqual([MULTILINE]);
  });

  it('a delivery racing an interrupt HOLDS the row instead of reporting it delivered', async () => {
    // The regression this issue exists to close. Pre-#1365 this row read `delivered` while
    // the agent's composer had been cleared — silent loss with a false audit record.
    const c = makeComposer();
    const ports = livePorts(new Map([[AGENT, sessionFor(c.session)]]));
    const row = enqueue();

    // The interrupt takes the terminal first; the delivery must decline, not write into it.
    const interrupt = submitToSession(c.session.id, interruptSubmission(c.session, 'INT'));
    const out = await deliverAgentMail(ports, db, WS, AGENT);
    await interrupt;

    expect(out).toEqual({ delivered: [], reason: 'busy' });
    const stored = mailbox.getById(db, row.id);
    expect(stored?.status).toBe('held'); // still deliverable — nothing was lost
    expect(stored?.reason).toBe('busy');
    expect(c.submitted).toEqual(['INT']); // only the operator's message went out
  });

  it('the held row delivers on the next pass, once the terminal is free', async () => {
    const c = makeComposer();
    const ports = livePorts(new Map([[AGENT, sessionFor(c.session)]]));
    const row = enqueue();

    const interrupt = submitToSession(c.session.id, interruptSubmission(c.session, 'INT'));
    await deliverAgentMail(ports, db, WS, AGENT); // declined
    await interrupt;
    const out = await deliverAgentMail(ports, db, WS, AGENT); // retried

    expect(out.delivered).toEqual([row.id]);
    expect(c.submitted).toEqual(['INT', MULTILINE]);
  });

  it('a row dismissed while the write edge runs is NOT re-held (row-resolved)', async () => {
    const c = makeComposer();
    const sessions = new Map([[AGENT, sessionFor(c.session)]]);
    const ports = livePorts(sessions);
    let heldChanges = 0;
    ports.onHeldStateChange = () => { heldChanges++; };
    const row = enqueue();

    // Dismiss inside the lock, at the write instant — the window the in-lock row-status
    // re-check exists to cover. The port relays the delivery module's own precheck.
    ports.writeMessage = (session, msg, noEnter, precheck) =>
      submitMessagePaced(session, msg, noEnter, () => {
        mailbox.dismiss(db, row.id, 1001);
        return precheck();
      });

    const out = await deliverAgentMail(ports, db, WS, AGENT);

    expect(out).toEqual({ delivered: [], reason: null }); // terminal state — not re-held
    expect(mailbox.getById(db, row.id)?.status).toBe('dismissed');
    expect(heldChanges).toBeGreaterThan(0); // the indicator was refreshed
    expect(c.submitted).toHaveLength(0); // and nothing went on the wire
  });

  it('a session that became unwritable inside the lock holds no-live-pty', async () => {
    const c = makeComposer();
    let writable = true;
    const session: DeliverySession = { ...sessionFor(c.session), get writable() { return writable; } };
    const ports = livePorts(new Map([[AGENT, session]]));
    const row = enqueue();

    ports.writeMessage = (s, msg, noEnter, precheck) =>
      submitMessagePaced(s, msg, noEnter, () => {
        writable = false; // the shellper socket dies while we hold the lock
        return precheck();
      });

    const out = await deliverAgentMail(ports, db, WS, AGENT);

    expect(out.reason).toBe('no-live-pty');
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
    expect(c.submitted).toHaveLength(0);
  });

  it('a screen that moved inside the lock holds busy', async () => {
    const c = makeComposer();
    let bytes = 10;
    const session: DeliverySession = { ...sessionFor(c.session), get bytesWritten() { return bytes; } };
    const ports = livePorts(new Map([[AGENT, session]]));
    const row = enqueue();

    ports.writeMessage = (s, msg, noEnter, precheck) =>
      submitMessagePaced(s, msg, noEnter, () => {
        bytes += 1; // new output landed between the gate and the first byte
        return precheck();
      });

    const out = await deliverAgentMail(ports, db, WS, AGENT);

    expect(out.reason).toBe('busy');
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
    expect(c.submitted).toHaveLength(0);
  });

  it('a preempted write holds the row and logs why', async () => {
    const c = makeComposer();
    const logs: string[] = [];
    const ports = livePorts(new Map([[AGENT, sessionFor(c.session)]]), logs);
    const row = enqueue();

    ports.writeMessage = async (s, msg, noEnter, precheck) => {
      const write = submitMessagePaced(s, msg, noEnter, precheck);
      await sleep(5);
      await submitToSession(s.id, () => { c.session.write('\x03'); return 0; }, undefined, { waitCeilingMs: 0 });
      return write;
    };

    const out = await deliverAgentMail(ports, db, WS, AGENT);

    expect(out.reason).toBe('busy');
    expect(mailbox.getById(db, row.id)?.status).toBe('held'); // redelivered later, never falsely delivered
    expect(logs.some((l) => l.includes('unserialized'))).toBe(true);
  });
});
