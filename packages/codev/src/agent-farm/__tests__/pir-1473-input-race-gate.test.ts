/**
 * The gate→write INPUT race (Issue #1473).
 *
 * Spec 1313's gate proves a composer is a verified-empty prompt, and #1365/#1573 closed the
 * OUTPUT-side staleness around that proof. Two input-side windows stayed open, and both are
 * the same corruption class — a message fused into a draft a human had started:
 *
 *   R1  a keystroke lands AFTER the gate sampled its change token. `bytesWritten` counts
 *       output, so nothing the guard compared had moved.
 *   R2  a keystroke lands just BEFORE the sample and is not echoed yet. No counter comparison
 *       can catch that — both samples agree, correctly — so it needs a clock.
 *
 * These tests drive the real `deliverAgentMail` against injected edges, so what is under test
 * is the ORCHESTRATION: which signal is consulted where, what is held, what is reported, and —
 * the part that is easy to lose in a refactor — what a delivery's OWN write must never do.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import {
  deliverAgentMail,
  MailboxDrainer,
  agentKey,
  INPUT_SETTLE_BEFORE_WRITE_MS,
  type DeliveryPorts,
  type DeliverySession,
  type UnverifiedDeliveryInfo,
  type WriteResult,
} from '../servers/mailbox-delivery.js';
import { submitMessagePaced } from '../servers/message-write.js';
import { resetSubmissionChains } from '../servers/session-submit.js';
import { isUnverifiableVerdict } from '@cluesmith/codev-sdk/hold-verdict';
import type { GateProfile, GateVerdict } from '../servers/render-gate.js';

const WS = '/ws/a';
const AGENT = 'spir-1';
const PROFILE: GateProfile = { app: 'claude', markerPattern: /^❯/, regionEndPatterns: [] };
const CLEAN: GateVerdict = { clean: true, detail: 'empty' };
const NOW = 1_000_000;

/**
 * A DeliverySession whose signals are LIVE getters, so a test can move them from inside an
 * injected port — which is the only way to model "a keystroke landed during the await".
 */
function mutableSession(): DeliverySession & {
  writes: string[];
  bytes: number;
  seq: number;
  inputAt: number;
} {
  const state = { writes: [] as string[], bytes: 0, seq: 0, inputAt: 0 };
  return {
    id: 'term-1473',
    get bytesWritten() { return state.bytes; },
    lastDataAt: 0,
    get inputSeq() { return state.seq; },
    get lastInputAt() { return state.inputAt; },
    info: { cols: 110, rows: 32 },
    command: 'claude',
    launchArgs: [],
    cwd: WS,
    writable: true,
    write(data: string) { state.writes.push(data); return true; },
    get writes() { return state.writes; },
    get bytes() { return state.bytes; },
    set bytes(v: number) { state.bytes = v; },
    get seq() { return state.seq; },
    set seq(v: number) { state.seq = v; },
    get inputAt() { return state.inputAt; },
    set inputAt(v: number) { state.inputAt = v; },
  };
}

interface Harness {
  ports: DeliveryPorts;
  session: ReturnType<typeof mutableSession>;
  writes: string[];
  logs: string[];
  notices: UnverifiedDeliveryInfo[];
  now: number;
  /** What the injected write edge reports; the default is a clean, unraced completion. */
  writeResult: WriteResult;
  /** Runs inside the injected `classify`, before it resolves — the R1 window. */
  duringClassify: (() => void) | null;
  /** Runs inside the injected `watchEcho`, before it resolves — the OTHER unbounded await. */
  duringWatchEcho: (() => void) | null;
  /** Runs inside the injected write edge, before its precheck — the in-lock window. */
  beforePrecheck: (() => void) | null;
  echoVerified: boolean;
}

function harness(): Harness {
  const session = mutableSession();
  const writes: string[] = [];
  const logs: string[] = [];
  const notices: UnverifiedDeliveryInfo[] = [];
  const h: Harness = {
    session,
    writes,
    logs,
    notices,
    now: NOW,
    writeResult: { status: 'written' },
    duringClassify: null,
    duringWatchEcho: null,
    beforePrecheck: null,
    echoVerified: true,
    ports: {
      getSessionForAgent: () => session,
      resolveProfile: () => PROFILE,
      classify: async () => {
        // A real classify awaits (the mirror flushes its parser and xterm yields between parse
        // slices). Yielding here is what makes the "a keystroke landed mid-classify" case real
        // rather than a rearrangement of synchronous statements.
        await Promise.resolve();
        h.duringClassify?.();
        return CLEAN;
      },
      writeMessage: (_s, msg, _noEnter, precheck) => {
        h.beforePrecheck?.();
        const abort = precheck();
        if (abort) return { status: 'aborted', abort };
        writes.push(msg);
        return h.writeResult;
      },
      watchEcho: async () => {
        await Promise.resolve();
        h.duringWatchEcho?.();
        return { verify: () => Promise.resolve(h.echoVerified) };
      },
      broadcast: () => {},
      onHeldStateChange: () => {},
      onEscalation: () => {},
      onLiveness: () => {},
      onUnverifiedDelivery: (info) => notices.push(info),
      log: (m) => logs.push(m),
      now: () => h.now,
    },
  };
  return h;
}

describe('Issue #1473 — the gate→write input race', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetSubmissionChains();
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  function enqueue(body = 'hi'): mailbox.DbMailbox {
    return mailbox.enqueue(
      db,
      { workspacePath: WS, toAgent: AGENT, body, formattedMessage: `[from architect] ${body}` },
      NOW,
    );
  }

  /** A row whose first line is too short to be a distinctive echo needle → verification skipped. */
  function enqueueUnverifiable(): mailbox.DbMailbox {
    return mailbox.enqueue(
      db,
      { workspacePath: WS, toAgent: AGENT, body: 'ok', formattedMessage: 'ok' },
      NOW,
    );
  }

  describe('R1 — a keystroke lands after the token was sampled', () => {
    it('holds busy:recent-input when input arrives DURING the classify, and writes nothing', async () => {
      const h = harness();
      const row = enqueue();
      h.duringClassify = () => { h.session.seq += 1; };

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.reason).toBe('busy');
      expect(out.detail).toBe('recent-input');
      expect(h.writes).toHaveLength(0);
      const stored = mailbox.getById(db, row.id)!;
      expect(stored.status).toBe('held');
      expect(stored.detail).toBe('recent-input');
    });

    it('holds when input arrives during the in-lock window, after the pre-lock checks passed', async () => {
      const h = harness();
      enqueue();
      h.beforePrecheck = () => { h.session.seq += 3; };

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.reason).toBe('busy');
      expect(out.detail).toBe('recent-input');
      expect(h.writes).toHaveLength(0);
    });

    it('holds when input arrives during the watchEcho await — the OTHER unbounded await in the gap', async () => {
      // `watchEcho` flushes the mirror and can scan up to 1000 lines. It sits between the
      // pre-lock checks and the write, so "the settle covers this window" is not true.
      const h = harness();
      enqueue();
      h.duringWatchEcho = () => { h.session.seq += 1; };

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.reason).toBe('busy');
      expect(out.detail).toBe('recent-input');
      expect(h.writes).toHaveLength(0);
    });

    it('attributes a token move to OUTPUT when only output moved — not to the human', async () => {
      // The token folds both counters. Blaming a repaint on somebody at the keyboard would put
      // a false `recent-input` on `afx inbox` and the send response.
      const h = harness();
      const row = enqueue();
      h.duringClassify = () => { h.session.bytes += 40; };

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.reason).toBe('busy');
      expect(out.detail).toBeUndefined();
      expect(mailbox.getById(db, row.id)?.detail).toBeNull();
    });

    it('does not reuse a memoized CLEAN verdict across a keystroke', async () => {
      // The case that earns the counter on its own: a CachedVerdict survives across backstop
      // ticks, and PTY input does not advance the ring — so without an input term in the token
      // a CLEAN verdict was reusable across a keystroke, with no settle bounding the gap.
      const h = harness();
      enqueue();
      const memo = new Map();
      let classifies = 0;
      const countingPorts: DeliveryPorts = {
        ...h.ports,
        classify: async () => { classifies++; await Promise.resolve(); return CLEAN; },
      };

      // First pass: input is present, so it holds — and memoizes against THAT token.
      h.session.inputAt = NOW;
      await deliverAgentMail(countingPorts, db, WS, AGENT, memo);
      expect(classifies).toBe(1);

      // A keystroke lands. The screen produced no output, so `bytesWritten` is untouched.
      h.session.seq += 1;
      h.now = NOW + 10_000; // the settle has long passed; only the counter differs

      await deliverAgentMail(countingPorts, db, WS, AGENT, memo);
      expect(classifies).toBe(2); // re-classified, not served the stale CLEAN
    });
  });

  describe('R2 — input that landed before the sample and is not echoed yet', () => {
    it('holds when the last input is inside the settle interval', async () => {
      const h = harness();
      const row = enqueue();
      h.session.inputAt = NOW - 100;

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.reason).toBe('busy');
      expect(out.detail).toBe('recent-input');
      expect(h.writes).toHaveLength(0);
      expect(mailbox.getById(db, row.id)?.detail).toBe('recent-input');
    });

    it('delivers once the input has settled', async () => {
      const h = harness();
      const row = enqueue();
      h.session.inputAt = NOW - 400;

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.delivered).toEqual([row.id]);
      expect(h.writes).toHaveLength(1);
    });

    it('treats exactly the settle interval as settled (the >= boundary)', async () => {
      const h = harness();
      const row = enqueue();
      h.session.inputAt = NOW - INPUT_SETTLE_BEFORE_WRITE_MS;

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.delivered).toEqual([row.id]);
    });

    it('holds one millisecond inside the boundary', async () => {
      const h = harness();
      enqueue();
      h.session.inputAt = NOW - (INPUT_SETTLE_BEFORE_WRITE_MS - 1);

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.reason).toBe('busy');
      expect(out.detail).toBe('recent-input');
    });

    it('holds on an UNKNOWN input age rather than writing into it', async () => {
      // The positive `>=` phrasing: NaN fails every comparison, so an unusable timestamp reads
      // as not-settled. An unknown input age is exactly the case that must not be written into.
      const h = harness();
      enqueue();
      h.session.inputAt = Number.NaN;

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.reason).toBe('busy');
      expect(h.writes).toHaveLength(0);
    });

    it('a session that has never had input is settled from birth', async () => {
      const h = harness();
      const row = enqueue();
      expect(h.session.lastInputAt).toBe(0);

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.delivered).toEqual([row.id]);
    });
  });

  describe('the hold is diagnosable but must not false-alarm', () => {
    it('renders as busy:recent-input through the shared formatter, and is NOT escalatable', async () => {
      // It sits beside `user-text`: a human at the line is a hold that clears on its own, and
      // escalating it would alarm on every ordinary typist. `isUnverifiableVerdict` is an
      // allow-list, so the new value is inert there by construction rather than by an edit.
      expect(isUnverifiableVerdict('busy', 'recent-input')).toBe(false);
      expect(isUnverifiableVerdict('busy', 'user-text')).toBe(false);
      expect(isUnverifiableVerdict('busy', 'no-region-end')).toBe(true);
    });

    it('reports how long until it would settle, so the drainer can retry instead of waiting a tick', async () => {
      const h = harness();
      enqueue();
      h.session.inputAt = NOW - 100;

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.retryAfterMs).toBe(INPUT_SETTLE_BEFORE_WRITE_MS - 100);
    });

    it('omits retryAfterMs for a hold that is NOT an input settle', async () => {
      const h = harness();
      enqueue();
      const busyPorts: DeliveryPorts = {
        ...h.ports,
        classify: () => Promise.resolve({ clean: false, reason: 'busy', detail: 'user-text' }),
      };

      const out = await deliverAgentMail(busyPorts, db, WS, AGENT);

      expect(out.reason).toBe('busy');
      expect(out.retryAfterMs).toBeUndefined();
    });
  });

  describe('a delivery must never trip its own input signal', () => {
    it("hard-codes the 'delivery' origin across a whole paced multi-line write", async () => {
      // The self-trip route closed by construction. If the wrapper ever forgot the origin, a
      // delivery would count its own bytes as human input and block the next one — and because
      // a one-arg function is assignable to a two-arg function type, TypeScript would not say
      // a word about it. The failure presents as "mail never delivers".
      const origins: Array<string | undefined> = [];
      let seq = 0;
      const session = {
        id: 'term-selftrip',
        get inputSeq() { return seq; },
        write(data: string, origin?: 'delivery') {
          origins.push(origin);
          // Model PtySession's own rule: only an EXTERNAL write moves the counter.
          if (origin !== 'delivery') seq += data.length;
          return true;
        },
      };

      const result = await submitMessagePaced(session, 'l1\nl2\nl3\nl4\nl5', false, () => null);

      expect(result).toEqual({ status: 'written' });
      expect(origins.length).toBeGreaterThan(1); // paced: line-by-line, then the Enter
      expect(origins.every((o) => o === 'delivery')).toBe(true);
      expect(seq).toBe(0);
    });
  });

  describe('a race DURING the write is reported, never re-written', () => {
    it('flags an input-raced delivery even when the header DID land (verified true)', async () => {
      // The shape that motivated threading a cause all the way to the sender: a human's Enter
      // submits our half-written body. The header is on screen, so `verified` is true, and the
      // old `if (!verified)` never fired — the sender read a plain "Message delivered".
      const h = harness();
      const row = enqueue('a message with a distinctive header line');
      h.writeResult = { status: 'written', racedByInput: true };
      h.echoVerified = true;

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.delivered).toEqual([row.id]);
      expect(out.verified).toBe(true);
      expect(out.unverifiedCause).toBe('input-raced');
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0].cause).toBe('input-raced');
      expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
    });

    it('flags an input-raced delivery that had no echo needle at all', async () => {
      const h = harness();
      const row = enqueueUnverifiable(); // too short to be a distinctive needle → no echo watch
      h.writeResult = { status: 'written', racedByInput: true };

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.delivered).toEqual([row.id]);
      expect(out.verified).toBeUndefined();
      expect(out.unverifiedCause).toBe('input-raced');
      expect(h.notices).toHaveLength(1);
      // And the WARN must not describe a needle it never had.
      const warn = h.logs.find((l) => l.includes('delivered-unverified'))!;
      expect(warn).toBeDefined();
      expect(warn).not.toContain('needle 0 chars');
    });

    it("gives 'input-raced' precedence when the delivery is BOTH raced and unechoed, escalating once", async () => {
      const h = harness();
      const row = enqueue('a message with a distinctive header line');
      h.writeResult = { status: 'written', racedByInput: true };
      h.echoVerified = false;

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.verified).toBe(false);
      expect(out.unverifiedCause).toBe('input-raced');
      expect(h.notices).toHaveLength(1); // exactly once, not one per cause
      expect(h.notices[0].cause).toBe('input-raced');
    });

    it("reports 'no-echo' when the write was NOT raced but the header never appeared", async () => {
      const h = harness();
      enqueue('a message with a distinctive header line');
      h.echoVerified = false;

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out.unverifiedCause).toBe('no-echo');
      expect(h.notices[0].cause).toBe('no-echo');
    });

    it('escalates nothing for an ordinary confirmed delivery', async () => {
      const h = harness();
      const row = enqueue('a message with a distinctive header line');

      const out = await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(out).toEqual({ delivered: [row.id], reason: null, verified: true });
      expect(h.notices).toHaveLength(0);
    });

    it('never re-writes a raced delivery on a later pass (#1584 still holds)', async () => {
      const h = harness();
      enqueue('a message with a distinctive header line');
      h.writeResult = { status: 'written', racedByInput: true };

      await deliverAgentMail(h.ports, db, WS, AGENT);
      await deliverAgentMail(h.ports, db, WS, AGENT);

      expect(h.writes).toHaveLength(1);
    });
  });

  describe('the drainer re-drains after the settle rather than waiting a backstop tick', () => {
    let drainer: MailboxDrainer;

    beforeEach(() => {
      vi.useFakeTimers();
      // A backstop interval far longer than the settle, so anything that delivers inside the
      // settle window demonstrably came from the re-drain and not from a tick.
      drainer = new MailboxDrainer({ intervalMs: 60_000 });
    });

    afterEach(() => {
      drainer.stop();
      vi.useRealTimers();
    });

    it('arms exactly ONE coalesced retry for an agent, however many input holds it takes', async () => {
      const h = harness();
      enqueue();
      h.session.inputAt = NOW - 100;
      drainer.start(h.ports, db);

      await drainer.scheduleDrain(WS, AGENT);
      await drainer.scheduleDrain(WS, AGENT);
      await drainer.scheduleDrain(WS, AGENT);

      expect(drainer.pendingInputRetries).toEqual([agentKey(WS, AGENT)]);
    });

    it('delivers on the retry once the input has settled', async () => {
      const h = harness();
      const row = enqueue();
      h.session.inputAt = NOW - 100;
      drainer.start(h.ports, db);

      await drainer.scheduleDrain(WS, AGENT);
      expect(h.writes).toHaveLength(0);

      // Time moves past the settle, and the armed retry fires.
      h.now = NOW + 1000;
      await vi.advanceTimersByTimeAsync(INPUT_SETTLE_BEFORE_WRITE_MS + 100);

      expect(h.writes).toHaveLength(1);
      expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
    });

    it('arms a retry for a pass run OUTSIDE the drainer (the afx send request path)', async () => {
      // The `afx send` request path calls the delivery directly rather than going through the
      // drainer, so its outcome never reached the retry arming — and a send landing on a
      // just-typed-at terminal fell through to the quiescence trigger or the backstop, in the
      // one case an operator is sitting there watching it. Found by MEASURING the running
      // Tower at the dev-approval gate, not by a unit test, which is why this one exists.
      const h = harness();
      const row = enqueue();
      h.session.inputAt = NOW - 100;
      drainer.start(h.ports, db);

      const outcome = await deliverAgentMail(h.ports, db, WS, AGENT);
      expect(outcome.retryAfterMs).toBeDefined();
      expect(drainer.pendingInputRetries).toEqual([]); // nothing armed by the direct pass itself

      drainer.noteOutcome(WS, AGENT, outcome);
      expect(drainer.pendingInputRetries).toEqual([agentKey(WS, AGENT)]);

      h.now = NOW + 1000;
      await vi.advanceTimersByTimeAsync(INPUT_SETTLE_BEFORE_WRITE_MS + 100);
      expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
    });

    it('noteOutcome is a no-op before the drainer is started', () => {
      const h = harness();
      const stopped = new MailboxDrainer({ intervalMs: 60_000 });
      stopped.noteOutcome(WS, AGENT, { delivered: [], reason: 'busy', retryAfterMs: 50 });
      expect(stopped.pendingInputRetries).toEqual([]);
      expect(h.writes).toHaveLength(0);
    });

    it('arms nothing for a hold that is not an input hold', async () => {
      const h = harness();
      enqueue();
      const busyPorts: DeliveryPorts = {
        ...h.ports,
        classify: () => Promise.resolve({ clean: false, reason: 'busy', detail: 'user-text' }),
      };
      drainer.start(busyPorts, db);

      await drainer.scheduleDrain(WS, AGENT);

      expect(drainer.pendingInputRetries).toEqual([]);
    });

    it('stop() clears a pending retry, and it does not fire afterwards', async () => {
      const h = harness();
      enqueue();
      h.session.inputAt = NOW - 100;
      drainer.start(h.ports, db);
      await drainer.scheduleDrain(WS, AGENT);
      expect(drainer.pendingInputRetries).toHaveLength(1);

      drainer.stop();
      expect(drainer.pendingInputRetries).toEqual([]);

      h.now = NOW + 1000;
      await vi.advanceTimersByTimeAsync(5000);
      expect(h.writes).toHaveLength(0);
    });

    it('warns once when input holds run unbroken past the diagnostic threshold', async () => {
      // A human types in bursts. An unbroken run of sub-settle input holds this long is a
      // machine — most likely a terminal reply the filter does not recognise, arriving on every
      // repaint. That case would otherwise hold forever in silence: plain `busy` nulls its
      // detail and is excluded from the classifier-stuck escalation, and the owner notice is
      // skipped for architects. This log line is the trace that makes it findable.
      const h = harness();
      enqueue();
      h.session.inputAt = NOW - 100;
      drainer.start(h.ports, db);

      for (let i = 0; i < 60; i++) {
        h.session.inputAt = h.now - 100; // still typing, every single pass
        await drainer.tick();
      }

      const warns = h.logs.filter((l) => l.includes('consecutive checks'));
      expect(warns).toHaveLength(1); // reported at the crossing, not once per pass
      expect(warns[0]).toContain(AGENT);
    });

    it('counts consecutive input holds and resets the count on a delivery', async () => {
      const h = harness();
      enqueue();
      h.session.inputAt = NOW - 100;
      drainer.start(h.ports, db);
      const key = agentKey(WS, AGENT);

      await drainer.scheduleDrain(WS, AGENT);
      expect(drainer.inputHoldStreaks.get(key)).toBe(1);

      // Let the coalescing timer clear so the next pass is a fresh hold, not a no-op.
      h.now = NOW + 10;
      await vi.advanceTimersByTimeAsync(INPUT_SETTLE_BEFORE_WRITE_MS + 100);

      // The retry that just fired re-held (input is still recent), so the streak grew.
      expect(drainer.inputHoldStreaks.get(key)).toBeGreaterThanOrEqual(2);

      // Now the input settles and the message goes out — the streak is over.
      h.now = NOW + 100_000;
      await drainer.scheduleDrain(WS, AGENT);
      expect(drainer.inputHoldStreaks.get(key)).toBeUndefined();
    });
  });
});
