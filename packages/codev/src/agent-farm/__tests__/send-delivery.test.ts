/**
 * Mailbox delivery orchestration (Spec 1313, Phase 4) — unit tests.
 *
 * Exercises the single gate-checked delivery path and the backstop drainer against
 * a real GLOBAL_SCHEMA-seeded SQLite DB (the mailbox operations are real — no
 * mocking of the system under test), with the *edges* (live session, profile, gate,
 * write, broadcast) injected as fakes so every branch is deterministic. The gate's
 * real screen-rendering is covered by render-gate.test.ts; here the verdict is
 * injected so we test the orchestration, not xterm.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import { scheduleDelayedSend, shutdownDelayedSends } from '../servers/delayed-send.js';
import {
  deliverAgentMail,
  deliverAgentMailSerialized,
  MailboxDrainer,
  agentKey,
  type DeliveryPorts,
  type DeliverySession,
  type DeliveredBroadcast,
  type EscalationInfo,
  type LivenessInfo,
  type HeldOwnerNoticeInfo,
} from '../servers/mailbox-delivery.js';
import type { GateProfile, GateVerdict } from '../servers/render-gate.js';
import { formatArchitectToBuilderMessage } from '../utils/message-format.js';

const PROFILE: GateProfile = { app: 'claude', markerPattern: /^❯/, regionEndPatterns: [] };
const CLEAN: GateVerdict = { clean: true, detail: 'empty' };
const BUSY: GateVerdict = { clean: false, reason: 'busy', detail: 'user-text' };

/**
 * A minimal DeliverySession fake (records writes). Spec 1313 render-gate round 2: the gate no
 * longer reads a ring snapshot — it classifies the session's screen and the delivery path keys
 * its TOCTOU/memo on the monotone `bytesWritten` token — so the fake exposes `bytesWritten`
 * (default 0) instead of the retired `ringBuffer.{getAll,currentSeq,partialBytes}`. Tests that
 * need a MOVING token build the session inline with a `get bytesWritten()` (a spread would freeze
 * a getter to its value); a static number covers everything else.
 */
function fakeSession(overrides: Partial<DeliverySession> = {}): DeliverySession & { writes: string[] } {
  const writes: string[] = [];
  return {
    id: 'term-fake',
    bytesWritten: 0,
    // Old enough that the Issue #1573 settle window has long passed for the harness clock
    // (`now` starts at 1000): a test that wants a still-painting screen overrides it.
    lastDataAt: 0,
    info: { cols: 110, rows: 32 },
    command: 'claude',
    launchArgs: [],
    cwd: '/ws/a',
    writable: true,
    write: (data: string) => {
      writes.push(data);
      return true;
    },
    writes,
    ...overrides,
  };
}

interface Harness {
  ports: DeliveryPorts;
  broadcasts: DeliveredBroadcast[];
  writes: Array<{ formattedMessage: string; noEnter: boolean }>;
  logs: string[];
  /** Count of onHeldStateChange fires (held-set-change SSE trigger). */
  heldChanges: number;
  /** onEscalation payloads (the escalation SSE trigger — metadata only). */
  escalations: EscalationInfo[];
  /** onLiveness payloads (the no-profile-streak diagnostic — metadata only). */
  livenessCalls: LivenessInfo[];
  /** escalateHeldToOwner payloads (Spec 1313 round 3 — starvation notices to an owner architect). */
  ownerNotices: HeldOwnerNoticeInfo[];
  /** clearHeldOwnerNotice calls (Spec 1313 round 3 — a starving agent's notice cleared on drain). */
  ownerClears: Array<{ workspacePath: string; toAgent: string }>;
  setSession(agent: string, session: DeliverySession | null): void;
  setProfile(p: GateProfile | null): void;
  setVerdict(v: GateVerdict): void;
  setClassify(fn: ((session: DeliverySession, p: GateProfile) => Promise<GateVerdict>) | null): void;
  now: number;
  /**
   * Result the fake `writeMessage` port returns (Spec 1313 silent-loss test). Default true
   * (the write landed); set false to model a dropped PTY write (#1198) and assert the row
   * is HELD `no-live-pty`, not marked delivered.
   */
  writeResult: boolean;
  /**
   * What the fake echo watch answers (Issue #1573). Default true (the header showed up on the
   * terminal); set false to model a write whose bytes never reached the screen and assert the
   * row is HELD rather than marked delivered.
   */
  echoVerified: boolean;
}

function harness(): Harness {
  const sessions = new Map<string, DeliverySession | null>();
  let profile: GateProfile | null = PROFILE;
  let verdict: GateVerdict = CLEAN;
  let classifyOverride: ((session: DeliverySession, p: GateProfile) => Promise<GateVerdict>) | null = null;
  const broadcasts: DeliveredBroadcast[] = [];
  const writes: Array<{ formattedMessage: string; noEnter: boolean }> = [];
  const logs: string[] = [];
  const h: Harness = {
    broadcasts,
    writes,
    logs,
    heldChanges: 0,
    escalations: [],
    livenessCalls: [],
    ownerNotices: [],
    ownerClears: [],
    now: 1000,
    writeResult: true,
    echoVerified: true,
    setSession: (agent, s) => sessions.set(agent, s),
    setProfile: (p) => {
      profile = p;
    },
    setVerdict: (v) => {
      verdict = v;
    },
    setClassify: (fn) => {
      classifyOverride = fn;
    },
    ports: {
      getSessionForAgent: (_ws, agent) => sessions.get(agent) ?? null,
      resolveProfile: () => profile,
      classify: (session: DeliverySession, p: GateProfile): Promise<GateVerdict> =>
        classifyOverride ? classifyOverride(session, p) : Promise.resolve(verdict),
      writeMessage: (_s, formattedMessage, noEnter, precheck) => {
        // Mirror the live binding's ordering: the precheck runs INSIDE the lock, before the
        // first byte (Issue #1365), so an abort must record no write at all.
        const abort = precheck();
        if (abort) return { status: 'aborted', abort };
        writes.push({ formattedMessage, noEnter });
        return h.writeResult ? { status: 'written' } : { status: 'dropped' };
      },
      watchEcho: () => Promise.resolve({ verify: () => Promise.resolve(h.echoVerified) }),
      broadcast: (f) => broadcasts.push(f),
      onHeldStateChange: () => {
        h.heldChanges++;
      },
      onEscalation: (info) => h.escalations.push(info),
      onLiveness: (info) => h.livenessCalls.push(info),
      escalateHeldToOwner: (info) => { h.ownerNotices.push(info); return true; },
      clearHeldOwnerNotice: (ws, agent) => h.ownerClears.push({ workspacePath: ws, toAgent: agent }),
      log: (m) => logs.push(m),
      now: () => h.now,
    },
  };
  return h;
}

describe('deliverAgentMail (Spec 1313, Phase 4)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  function enqueue(overrides: Partial<mailbox.EnqueueInput> = {}, now = 1000) {
    return mailbox.enqueue(
      db,
      {
        workspacePath: '/ws/a',
        toAgent: 'spir-1',
        body: 'hi',
        formattedMessage: '[from architect] hi',
        ...overrides,
      },
      now
    );
  }

  it('empty mailbox → nothing delivered, no reason, no session lookup needed', async () => {
    const h = harness();
    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(out).toEqual({ delivered: [], reason: null });
    expect(h.writes).toHaveLength(0);
  });

  it('clean gate → delivers the oldest held message, marks it delivered, broadcasts', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    const row = enqueue();
    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.delivered).toEqual([row.id]);
    expect(out.reason).toBeNull();
    expect(h.writes).toEqual([{ formattedMessage: '[from architect] hi', noEnter: false }]);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
    expect(h.broadcasts[0]).toMatchObject({ type: 'message', content: 'hi', to: { agent: 'spir-1' } });
  });

  /**
   * #1574: the bytes a builder actually sees must name the recipient the mailbox row
   * was addressed to. Asserted end-to-end (real formatter → real row → real delivery →
   * captured write) rather than on the formatter alone: a frame built with the wrong
   * recipient would still pass a formatter-only test, and that is the exact failure —
   * a frame attesting to an address that is not the row's.
   */
  it('a delivered row is self-attesting: the injected bytes carry the row\'s to_agent', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    const row = enqueue({ formattedMessage: formatArchitectToBuilderMessage('spir-1', 'hi') });

    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    const stored = mailbox.getById(db, row.id)!;
    expect(stored.status).toBe('delivered');
    expect(h.writes[0].formattedMessage).toContain(`→ ${stored.to_agent}`);
    // And the reply channel travels with it — the point-of-need reminder that
    // survives a builder's `/clear` (the real #1530 defect).
    expect(h.writes[0].formattedMessage).toContain('afx send architect');
  });

  it('busy gate → holds, sets reason=busy, writes nothing', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    const row = enqueue();
    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    // The gate's detail rides the outcome (Spec 1313 render-gate hardening) so a
    // classifier-stuck streak can escalate to liveness telemetry; a plain draft is `user-text`.
    expect(out).toEqual({ delivered: [], reason: 'busy', detail: 'user-text' });
    expect(h.writes).toHaveLength(0);
    const stored = mailbox.getById(db, row.id);
    expect(stored?.status).toBe('held');
    expect(stored?.reason).toBe('busy');
  });

  it('no live session → holds with reason no-live-pty (dead-session case)', async () => {
    const h = harness();
    h.setSession('spir-1', null);
    const row = enqueue({ reason: 'busy' });
    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.reason).toBe('no-live-pty');
    expect(mailbox.getById(db, row.id)?.reason).toBe('no-live-pty'); // refreshed from the stale 'busy'
  });

  it('no profile (unknown app) → holds with reason no-profile', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setProfile(null);
    enqueue();
    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(out.reason).toBe('no-profile');
  });

  it('clean gate but PTY unwritable (torn-down shellper) → holds no-live-pty, writes nothing, not delivered', async () => {
    // Spec 1313 iter-1 review (Codex): a session can go unwritable (#1198: a dead
    // shellper socket still reports status 'running', writes are dropped) after it is
    // resolved. Delivering off the paced-write timer would mark such a row delivered;
    // the write-instant `writable` re-check must hold it instead ("an errored PTY
    // write leaves the row held").
    const h = harness();
    h.setSession('spir-1', fakeSession({ writable: false }));
    const row = enqueue();
    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.reason).toBe('no-live-pty');
    expect(out.delivered).toEqual([]);
    expect(h.writes).toHaveLength(0); // no bytes on the wire
    expect(h.broadcasts).toHaveLength(0); // no delivered broadcast
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
    expect(mailbox.getById(db, row.id)?.reason).toBe('no-live-pty');
  });

  it('clean gate, writable at t=0, but the paced write is dropped mid-pace → holds no-live-pty, not delivered', async () => {
    // Spec 1313 integration review (Codex — silent-loss fix): the write-instant `writable`
    // precheck cannot see a shellper socket that dies DURING the paced text→…→Enter sequence
    // (#1198: writes then return false). writeMessage threads that per-write result; a `false`
    // result must HOLD the row (`no-live-pty`), NOT mark it delivered — the exact silent loss
    // this spec exists to eliminate. This is the complement of the t=0-precheck case above:
    // there the session was dead before the write (0 writes); here it is writable when we start
    // and the write itself is dropped (1 write attempted, 0 delivered). The paced-write drop
    // threading itself — for BOTH the first and the delayed Enter/multiline writes — is covered
    // end-to-end in spec-1313-paced-write-drop.test.ts; here writeMessage returns the aggregate.
    const h = harness();
    h.setSession('spir-1', fakeSession()); // writable: true → the t=0 precheck PASSES
    h.writeResult = false; // ...but the write drops (socket died mid-pace)
    const row = enqueue();
    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.reason).toBe('no-live-pty');
    expect(out.delivered).toEqual([]);
    expect(h.writes).toHaveLength(1); // the write WAS attempted (unlike the t=0-precheck case)
    expect(h.broadcasts).toHaveLength(0); // but no delivered broadcast
    expect(mailbox.getById(db, row.id)?.status).toBe('held'); // never markDelivered
    expect(mailbox.getById(db, row.id)?.reason).toBe('no-live-pty');
  });

  it('row dismissed during the gate check → not written, not delivered, stays dismissed (resolve/deliver race)', async () => {
    // Spec 1313 iter-1 review (Codex): dismiss/supersede run outside the per-agent
    // delivery serializer, so one landing in the gate→write window must not still put
    // bytes on the wire. Here the gate `classify` dismisses the row mid-check; the
    // write-instant getById re-read must see it is no longer held and skip the write.
    const h = harness();
    h.setSession('spir-1', fakeSession());
    const row = enqueue();
    h.ports.classify = async () => {
      mailbox.dismiss(db, row.id, 1001); // operator dismisses while the gate runs
      return CLEAN;
    };
    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(out.delivered).toEqual([]);
    expect(h.writes).toHaveLength(0); // never written after dismissal
    expect(h.broadcasts).toHaveLength(0);
    expect(mailbox.getById(db, row.id)?.status).toBe('dismissed'); // delivery left it terminal
  });

  it('delivers only ONE message per clean pass (oldest first) — the rest wait for the next clean gate', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    const older = enqueue({ body: 'first', formattedMessage: 'F' }, 1000);
    const newer = enqueue({ body: 'second', formattedMessage: 'S' }, 2000);

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(out.delivered).toEqual([older.id]);
    expect(h.writes).toEqual([{ formattedMessage: 'F', noEnter: false }]);
    expect(mailbox.getById(db, older.id)?.status).toBe('delivered');
    expect(mailbox.getById(db, newer.id)?.status).toBe('held');
  });

  it('noEnter row → writeMessage receives noEnter=true (staged, not submitted)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    enqueue({ noEnter: true });
    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(h.writes[0].noEnter).toBe(true);
  });

  it('is idempotent: a second pass after delivery finds no held rows and is a no-op', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    enqueue();
    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    const out2 = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(out2).toEqual({ delivered: [], reason: null });
    expect(h.writes).toHaveLength(1); // not re-delivered
  });

  it('re-validates the SCREEN after the classify: a keystroke landing during the classify → holds, never writes (Spec 1313 render-gate hardening)', async () => {
    // The classify awaits (the mirror flushes its parser); if the user starts typing during
    // it, the clean verdict is for a screen that no longer exists. The delivery path samples
    // the monotone bytesWritten token before the classify and re-checks it after — a change
    // means "screen moved under us" → hold, never write the message onto the now-present draft
    // (the false-clean the gate exists to prevent).
    let bytes = 0;
    const session: DeliverySession = {
      id: 'term-moving',
      get bytesWritten() {
        return bytes;
      },
      // Settled (Issue #1573), so the hold this test asserts is attributable to the token
      // moving under the classify — not to an unknown screen age.
      lastDataAt: 0,
      info: { cols: 110, rows: 32 },
      command: 'claude',
      launchArgs: [],
      cwd: '/ws/a',
      writable: true,
      write: () => true,
    };
    const h = harness();
    h.setSession('spir-1', session);
    // Model the keystroke: new output advances the token *during* the classify, which still
    // returns CLEAN for the (now stale) screen it was handed.
    h.setClassify(async () => {
      bytes++;
      return CLEAN;
    });
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(out.delivered).toEqual([]);
    expect(out.reason).toBe('busy'); // held: the screen moved under the gate
    expect(h.writes).toHaveLength(0); // never wrote onto the draft that appeared
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
  });

  // ==========================================================================
  // Spec 1307 `--delay` ordering, re-homed onto the mailbox.
  //
  // 1307's load-bearing guarantee: "a delayed message never overtakes a message
  // already QUEUED for that session" — the /arch-save case where /clear is sent
  // with no delay and /arch-init with one, and the clear MUST land first or it
  // wipes the freshly-recovered context. 1307 got this from SendBuffer's per-session
  // FIFO; this project deleted SendBuffer, so the guarantee now rests on two facts
  // proven together here: (a) a delayed send is enqueued only WHEN its timer fires,
  // so its row is necessarily younger than anything already held; and (b) the drain
  // delivers the oldest held row first (created_at ASC). This is the mailbox-model
  // replacement for the SendBuffer ordering test the rebase removed.
  // ==========================================================================
  describe('delayed sends never overtake already-queued mail (Spec 1307 ordering)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1000); // fake wall clock → drives mailbox created_at
      shutdownDelayedSends(); // no timers leak in from a prior test
    });
    afterEach(() => {
      shutdownDelayedSends();
      vi.useRealTimers();
    });

    it('the /clear-then-delayed-/arch-init case: the clear drains first', async () => {
      const h = harness();
      h.setSession('spir-1', fakeSession()); // clean composer → gate delivers

      // (1) /clear is sent with no delay at T=1000 and sits held (someone was typing
      //     when it arrived, so it did not deliver immediately).
      const clear = enqueue({ body: '/clear', formattedMessage: '/clear' }, Date.now());

      // (2) /arch-init is scheduled +15s. A pre-due delayed send lives ONLY in the
      //     in-memory timer registry — its mailbox row must NOT exist yet (this is the
      //     dropped-on-restart durability contract: nothing durable until it fires).
      scheduleDelayedSend(15, 'term-1', () => {
        enqueue({ body: '/arch-init', formattedMessage: '/arch-init' }, Date.now());
      });
      expect(mailbox.findHeldForAgent(db, '/ws/a', 'spir-1').map((r) => r.body)).toEqual([
        '/clear',
      ]);

      // (3) Timer fires at T=16000 → /arch-init is enqueued NOW, strictly younger.
      await vi.advanceTimersByTimeAsync(15_000);
      const held = mailbox.findHeldForAgent(db, '/ws/a', 'spir-1');
      expect(held.map((r) => r.body)).toEqual(['/clear', '/arch-init']); // oldest-first
      expect(held[1].created_at).toBeGreaterThan(held[0].created_at); // enqueued at fire time

      // (4) Drain against a clean gate: the OLDEST row (the clear) delivers first, and
      //     only one lands per clean pass — so /arch-init cannot overtake it.
      const first = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
      expect(first.delivered).toEqual([clear.id]);
      expect(mailbox.getById(db, clear.id)?.status).toBe('delivered');

      // (5) The next pass delivers /arch-init — after the clear, never before it.
      const second = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
      expect(second.delivered).toHaveLength(1);
      expect(mailbox.getById(db, second.delivered[0])?.body).toBe('/arch-init');
    });
  });
});

describe('deliverAgentMailSerialized — concurrent-send serialization (Spec 1313, spike w1a)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  it('two concurrent deliveries to one agent each write exactly one message, in order — no blob, no double-write', async () => {
    const h = harness();
    // writeMessage yields a microtask so an unserialized racer WOULD interleave;
    // the serializer must still produce ordered, once-each writes.
    h.ports.writeMessage = (_s, formattedMessage, noEnter) =>
      Promise.resolve().then(() => {
        h.writes.push({ formattedMessage, noEnter });
        return { status: 'written' as const }; // the write landed (Spec 1313: the port reports delivery success)
      });
    h.setSession('spir-1', fakeSession());
    mailbox.enqueue(db, { workspacePath: '/ws/a', toAgent: 'spir-1', body: '1', formattedMessage: 'F' }, 1000);
    mailbox.enqueue(db, { workspacePath: '/ws/a', toAgent: 'spir-1', body: '2', formattedMessage: 'S' }, 2000);

    // Fire both concurrently (the w1a scenario: two sends land at once).
    const [o1, o2] = await Promise.all([
      deliverAgentMailSerialized(h.ports, db, '/ws/a', 'spir-1'),
      deliverAgentMailSerialized(h.ports, db, '/ws/a', 'spir-1'),
    ]);

    // Each message written exactly once, oldest first — never fused, never duplicated.
    expect(h.writes).toEqual([
      { formattedMessage: 'F', noEnter: false },
      { formattedMessage: 'S', noEnter: false },
    ]);
    // Each pass delivered exactly one distinct row.
    const delivered = [...o1.delivered, ...o2.delivered];
    expect(delivered).toHaveLength(2);
    expect(new Set(delivered).size).toBe(2);
  });
});

describe('MailboxDrainer (Spec 1313, Phase 4)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  it('tick drains a clean agent and holds a busy agent, tracking the not-clean streak', async () => {
    const h = harness();
    // agent A: live + clean; agent B: live + busy.
    const sessionA = fakeSession();
    const sessionB = fakeSession();
    h.ports.getSessionForAgent = (_ws, agent) => (agent === 'A' ? sessionA : agent === 'B' ? sessionB : null);

    const rowA = mailbox.enqueue(db, { workspacePath: '/ws', toAgent: 'A', body: 'a', formattedMessage: 'A' }, 1000);
    mailbox.enqueue(db, { workspacePath: '/ws', toAgent: 'B', body: 'b', formattedMessage: 'B' }, 1000);

    // Make B busy by keying classify on the session identity (the gate now classifies a
    // session's screen, not a ring snapshot).
    h.ports.classify = (session, _p) => Promise.resolve(session === sessionB ? BUSY : CLEAN);

    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick();

    expect(mailbox.getById(db, rowA.id)?.status).toBe('delivered');
    expect(drainer.streaks.get(agentKey('/ws', 'A'))).toBeUndefined(); // delivered → no streak
    expect(drainer.streaks.get(agentKey('/ws', 'B'))).toBe(1); // busy → streak 1

    await drainer.tick(); // B still busy → streak grows
    expect(drainer.streaks.get(agentKey('/ws', 'B'))).toBe(2);
    drainer.stop();
  });

  it('start() prunes terminal rows on boot', async () => {
    const h = harness();
    // A delivered row resolved long ago should be pruned on boot.
    const old = mailbox.enqueue(db, { workspacePath: '/ws', toAgent: 'A', body: 'x', formattedMessage: 'X' }, 1000);
    mailbox.markDelivered(db, old.id, 1000);
    const drainer = new MailboxDrainer({ pruneRetentionDays: 7 });
    h.now = 1000 + 8 * 24 * 60 * 60 * 1000; // 8 days later
    drainer.start(h.ports, db);
    expect(mailbox.getById(db, old.id)).toBeNull(); // pruned
    drainer.stop();
  });

  it('the default retention window is 30 days (spec) — keeps a 10-day row, prunes a 31-day one', async () => {
    // Guards the corrected default (was a wrong 7d): a default-constructed drainer
    // must NOT prune a row aged 10 days, but MUST prune it once past 30.
    const day = 24 * 60 * 60 * 1000;
    const h = harness();
    const row = mailbox.enqueue(db, { workspacePath: '/ws', toAgent: 'A', body: 'x', formattedMessage: 'X' }, 1000);
    mailbox.markDelivered(db, row.id, 1000);
    const drainer = new MailboxDrainer(); // no override → the 30-day default

    h.now = 1000 + 10 * day;
    drainer.start(h.ports, db);
    expect(mailbox.getById(db, row.id)).not.toBeNull(); // within 30d → kept (would have been pruned at 7d)
    drainer.stop();

    h.now = 1000 + 31 * day;
    drainer.start(h.ports, db);
    expect(mailbox.getById(db, row.id)).toBeNull(); // beyond 30d → pruned
    drainer.stop();
  });
});

describe('MailboxDrainer verdict memo (Spec 1313 render-gate follow-up)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  const held = (toAgent: string, body = 'hi', now = 1000) =>
    mailbox.enqueue(db, { workspacePath: '/ws', toAgent, body, formattedMessage: body }, now);

  it('classifies a STATIC screen once: a second backstop tick reuses the cached verdict (no re-classify)', async () => {
    const h = harness();
    // Stable token across ticks (bytesWritten constant) + a busy verdict, so the message
    // stays held and both ticks attempt delivery for the same agent.
    h.setSession('spir-1', fakeSession({ bytesWritten: 7 }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return BUSY; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick(); // classify #1 — memo miss
    await drainer.tick(); // static token → memo hit, NOT re-classified
    drainer.stop();
    expect(classifyCalls).toBe(1);
  });

  it('re-classifies after the screen CHANGES — the memo is keyed on the monotone token', async () => {
    const h = harness();
    let bytes = 7;
    // A moving token needs a live getter (a fakeSession spread would freeze bytesWritten to its value).
    h.setSession('spir-1', {
      id: 'term-moving',
      get bytesWritten() { return bytes; },
      // Issue #1573 settle-before-write: epoch 0 against the harness clock is a screen that
      // stopped painting long ago, so this test still exercises the memo and nothing else.
      lastDataAt: 0,
      info: { cols: 110, rows: 32 },
      command: 'claude',
      launchArgs: [],
      cwd: '/ws',
      writable: true,
      write: () => true,
    });
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return BUSY; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick(); // classify #1 (miss)
    await drainer.tick(); // memo hit (token unchanged)
    bytes = 20;           // new output → token advances (monotone; only ever grows)
    await drainer.tick(); // classify #2 (token changed → re-classify)
    drainer.stop();
    expect(classifyCalls).toBe(2);
  });

  it('invalidates the memo after a delivery — a follow-up message re-classifies, never reuses a stale CLEAN', async () => {
    const h = harness();
    // Two held messages, static fake ring. Round-2 fix (Codex): after delivering m1 the memo is
    // invalidated (the write WILL change the screen), so tick 2 does NOT reuse the stale CLEAN —
    // it re-classifies fresh before delivering m2. PTY INPUT doesn't advance the ring, so the token
    // alone would wrongly look unchanged; the invalidation prevents delivering onto an un-echoed
    // line. Both still deliver, in order — but via TWO classifies, not a stale reuse.
    h.setSession('spir-1', fakeSession({ bytesWritten: 3 }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return CLEAN; };
    held('spir-1', 'm1', 1000);
    held('spir-1', 'm2', 1001);
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick(); // classify #1 (miss) → delivers m1 → invalidates the memo
    await drainer.tick(); // memo invalidated → classify #2 (fresh) → delivers m2
    drainer.stop();
    expect(classifyCalls).toBe(2);
    expect(h.writes.map((w) => w.formattedMessage)).toEqual(['m1', 'm2']);
  });

  it('invalidates the memo even when the delivered row was DISMISSED mid-write (CMAP round 3 — Codex/Claude)', async () => {
    const h = harness();
    // The memo delete must sit ABOVE the markDelivered guard: the write already put bytes on the
    // wire, so the cached CLEAN is stale regardless of whether the row then transitions. Here m1 is
    // dismissed DURING its paced write → markDelivered returns false and deliverAgentMail early-
    // returns; if the delete sat below that guard (round-2 placement) the stale CLEAN would survive,
    // and tick 2 would memo-hit and write m2 onto the not-yet-echoed line. Static ring, so the ONLY
    // thing that can force a re-classify on tick 2 is the invalidation.
    h.setSession('spir-1', fakeSession({ bytesWritten: 3 }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return CLEAN; };
    const m1 = held('spir-1', 'm1', 1000);
    held('spir-1', 'm2', 1001);
    h.ports.writeMessage = (_s, formattedMessage, noEnter) => {
      h.writes.push({ formattedMessage, noEnter });
      if (formattedMessage === 'm1') mailbox.dismiss(db, m1.id, 1002); // operator dismisses during the paced write
      return { status: 'written' as const };
    };
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick(); // classify #1 (miss) → writes m1, m1 dismissed mid-write → memo invalidated ANYWAY
    await drainer.tick(); // memo invalidated → classify #2 (fresh) → delivers m2 (NOT a stale memo-hit)
    drainer.stop();
    expect(classifyCalls).toBe(2); // revert the fix (delete below the guard) → 1, and m2 rides a stale CLEAN
    expect(mailbox.getById(db, m1.id)?.status).toBe('dismissed');
    expect(h.writes.map((w) => w.formattedMessage)).toEqual(['m1', 'm2']);
  });

  it('invalidates the memo even when writeMessage REJECTS after partial output (CMAP round 4 — Codex)', async () => {
    const h = harness();
    // Round-4 completion of Fix 1: memo.delete must run on a write REJECTION too (via try/finally),
    // not only a clean return. writeMessage's port contract is WriteResult|Promise<WriteResult>, so a
    // binding could reject after putting bytes on the wire; without the finally the stale CLEAN survives and a
    // follow-up could memo-hit it. Here writeMessage records partial output then rejects → the row
    // stays held (deliverAgentMail throws, caught by the per-agent tick guard) → the NEXT tick must
    // re-classify fresh, not memo-hit. Static ring, so a re-classify can only come from invalidation.
    h.setSession('spir-1', fakeSession({ bytesWritten: 3 }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return CLEAN; };
    let writeAttempts = 0;
    h.ports.writeMessage = async () => {
      writeAttempts++;
      h.writes.push({ formattedMessage: 'partial', noEnter: false }); // some bytes on the wire...
      throw new Error('pty write failed mid-message');                 // ...then reject
    };
    const m1 = held('spir-1', 'm1', 1000);
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick(); // classify #1 → CLEAN → write rejects → finally deletes the memo → row stays held
    await drainer.tick(); // memo invalidated → classify #2 (fresh), NOT a stale memo-hit
    drainer.stop();
    expect(writeAttempts).toBe(2);                            // retried on the second tick (row still held)
    expect(classifyCalls).toBe(2);                           // fresh classify each tick; revert the try/finally → 1
    expect(mailbox.getById(db, m1.id)?.status).toBe('held'); // never delivered (the write kept failing)
  });

  it('bounds the memo: an agent whose mail clears is pruned from the memo on the next tick', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession({ bytesWritten: 1 }));
    h.setVerdict(BUSY); // held → a memo entry is created
    const row = held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick();
    expect(drainer.memoizedAgents).toHaveLength(1);
    mailbox.markDelivered(db, row.id, h.now); // clear the row out-of-band → no held agents next tick
    await drainer.tick();
    expect(drainer.memoizedAgents).toHaveLength(0); // pruned to the (now empty) held-agent set
    drainer.stop();
  });

  it('does NOT reuse a cached verdict across a session swap with an identical token (respawn safety)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession({ bytesWritten: 5 }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return BUSY; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick(); // classify #1 — caches {sessionA, token}
    // Swap in a DIFFERENT session object carrying the SAME token — models a respawned PTY whose
    // fresh bytesWritten (restarts at 0) transiently reproduces the cached token value.
    // Token-only matching would serve the stale verdict; the session guard forces a re-classify.
    h.setSession('spir-1', fakeSession({ bytesWritten: 5 }));
    await drainer.tick();
    drainer.stop();
    expect(classifyCalls).toBe(2);
  });

  it('generation guard (tick): an in-flight pass that resumes after stop() does not seed the new generation (CMAP round 3 — all three)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession({ bytesWritten: 1 }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    h.ports.classify = async () => { await gate; return { clean: false, reason: 'busy', detail: 'no-region-end' }; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    const inFlight = drainer.tick(); // parks at the classify await
    drainer.stop();                  // bumps the generation + clears the streak map
    release();                       // classify resolves → the tick resumes PAST the await
    await inFlight;                  // the post-await generation check must bail before recordStreak
    expect(drainer.streaks.size).toBe(0); // pre-fix: the resumed recordStreak seeds a stale streak (size 1)
  });

  it('generation guard (scheduleDrain): a queued drain that resumes after stop() does not seed the new generation (CMAP round 3 — Codex)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession({ bytesWritten: 1 }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    h.ports.classify = async () => { await gate; return { clean: false, reason: 'busy', detail: 'no-region-end' }; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    const inFlight = drainer.scheduleDrain('/ws', 'spir-1');
    // scheduleDrain's body is a microtask (Promise.resolve().then(...)); WITHOUT draining, stop()
    // below would run before the body even starts, so it would bail at the pre-existing top-of-
    // callback generation check and never reach the post-await guard under test (CMAP round 4 —
    // Claude, who proved the un-drained version stays green even with the whole fix reverted). Drain
    // microtasks so the body runs up to and PARKS at the classify await (a real unresolved gate
    // promise) before we stop() — only then does resuming past the await exercise the guard.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    drainer.stop();                                          // bumps the generation while parked at the await
    release();                                               // classify resolves → the drain resumes PAST the await
    await inFlight;                                          // the post-await generation check must bail before recordStreak
    expect(drainer.streaks.size).toBe(0); // pre-fix: the resumed recordStreak seeds a stale streak (size 1)
  });
});

describe('MailboxDrainer.scheduleDrain — fast delivery triggers (Spec 1313, Phase 5)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  const enqueue = (formattedMessage = 'M') =>
    mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body: 'hi', formattedMessage },
      1000
    );

  it('a trigger delivers a held message on a clean line, without a backstop tick', async () => {
    const h = harness(); // default verdict is CLEAN
    h.setSession('spir-1', fakeSession());
    enqueue('[from architect] hi');
    const drainer = new MailboxDrainer({ intervalMs: 999999 }); // backstop effectively disabled
    drainer.start(h.ports, db);

    await drainer.scheduleDrain('/ws/a', 'spir-1'); // no tick() — the trigger alone delivers

    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].formattedMessage).toBe('[from architect] hi');
    expect(drainer.streaks.get(agentKey('/ws/a', 'spir-1'))).toBeUndefined();
    drainer.stop();
  });

  it('a spurious trigger on a busy screen re-holds — the gate still decides, nothing delivered', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    const row = enqueue();
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);

    await drainer.scheduleDrain('/ws/a', 'spir-1');

    expect(h.writes).toHaveLength(0);
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
    expect(mailbox.getById(db, row.id)?.reason).toBe('busy');
    expect(drainer.streaks.get(agentKey('/ws/a', 'spir-1'))).toBe(1);
    drainer.stop();
  });

  it('coalesces a burst of triggers into one gated pass (gate runs once, not once per trigger)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    // Stay held so EVERY pass would re-run the gate — makes the coalescing observable.
    let classifyCalls = 0;
    h.ports.classify = () => {
      classifyCalls++;
      return Promise.resolve(BUSY);
    };
    enqueue();
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);

    // A submit+quiescence storm: five synchronous triggers for the same agent.
    const p1 = drainer.scheduleDrain('/ws/a', 'spir-1');
    const p2 = drainer.scheduleDrain('/ws/a', 'spir-1');
    expect(p2).toBe(p1); // same in-flight promise → coalesced, not re-queued
    await Promise.all([
      p1,
      p2,
      drainer.scheduleDrain('/ws/a', 'spir-1'),
      drainer.scheduleDrain('/ws/a', 'spir-1'),
      drainer.scheduleDrain('/ws/a', 'spir-1'),
    ]);

    expect(classifyCalls).toBe(1); // one gate check for the whole burst
    drainer.stop();
  });

  it('a later trigger delivers what an earlier busy trigger held (line cleared between triggers)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    const row = enqueue();
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);

    await drainer.scheduleDrain('/ws/a', 'spir-1'); // busy → held
    expect(mailbox.getById(db, row.id)?.status).toBe('held');

    h.setVerdict(CLEAN);
    await drainer.scheduleDrain('/ws/a', 'spir-1'); // line cleared → delivered
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
    expect(h.writes).toHaveLength(1);
    expect(drainer.streaks.get(agentKey('/ws/a', 'spir-1'))).toBeUndefined();
    drainer.stop();
  });

  it('no-ops (resolved) before the drainer is started — needs the bound ports + db', async () => {
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    await expect(drainer.scheduleDrain('/ws/a', 'spir-1')).resolves.toBeUndefined();
  });
});

describe('MailboxDrainer escalation + liveness telemetry (Spec 1313, Phase 7)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  const enqueue = (overrides: Partial<mailbox.EnqueueInput> = {}, now = 1000) =>
    mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body: 'hi', formattedMessage: 'M', ...overrides },
      now
    );

  it('escalates a held row past the escalation age → fires onEscalation (metadata only), never delivers', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY); // held on a busy line (a human is present)
    const row = enqueue({}, 1000);
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 5000 });
    drainer.start(h.ports, db);

    h.now = 1000 + 6000; // past the 5s escalation age
    await drainer.tick();

    // Flagged escalated and broadcast with metadata — but the row is NOT delivered.
    expect(mailbox.getById(db, row.id)?.escalated).toBe(1);
    expect(mailbox.getById(db, row.id)?.status).toBe('held'); // visibility only, no delivery
    expect(h.writes).toHaveLength(0);
    expect(h.escalations).toEqual([
      {
        workspacePath: '/ws/a',
        toAgent: 'spir-1',
        mailboxId: row.id,
        ageMs: 6000,
        reason: 'busy',
        // Issue #1482: the gate detail rides along, so a client seeing this escalation can tell
        // an occupied composer (this case — a human is at the line) from one the classifier
        // could not read at all. Read off the row the delivery pass persisted it to.
        detail: 'user-text',
      },
    ]);
    // Redaction: the escalation payload carries no message body.
    expect(Object.keys(h.escalations[0])).not.toContain('body');
    // The escalated flag flipped → the overview-derived attention bit changed, so the
    // held-state-change event fired too (keeps `mailboxEscalated` from going stale).
    expect(h.heldChanges).toBeGreaterThanOrEqual(1);
    drainer.stop();
  });

  it('escalation fires exactly once — a second tick does not re-escalate or re-broadcast', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    enqueue({}, 1000);
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 5000 });
    drainer.start(h.ports, db);
    h.now = 1000 + 6000;
    await drainer.tick();
    await drainer.tick(); // findEscalatable excludes already-escalated rows
    expect(h.escalations).toHaveLength(1);
    drainer.stop();
  });

  it('a row younger than the escalation age is not escalated', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    const row = enqueue({}, 1000);
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 60000 });
    drainer.start(h.ports, db);
    h.now = 1000 + 5000; // well within the 60s age
    await drainer.tick();
    expect(mailbox.getById(db, row.id)?.escalated).toBe(0);
    expect(h.escalations).toHaveLength(0);
    drainer.stop();
  });

  it('a delivery fires onHeldStateChange (a held row left the set → indicator refetch)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession()); // clean by default → delivers
    enqueue();
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick();
    expect(h.heldChanges).toBeGreaterThanOrEqual(1);
    drainer.stop();
  });

  it('liveness: a sustained no-profile streak reports onLiveness exactly once, at the threshold crossing', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setProfile(null); // unknown app → held no-profile on every pass
    enqueue();
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 999999 });
    drainer.start(h.ports, db);
    for (let i = 0; i < 9; i++) await drainer.tick(); // one short of the threshold
    expect(h.livenessCalls).toHaveLength(0);
    await drainer.tick(); // 10th consecutive no-profile → report once
    await drainer.tick(); // still exactly one (fires only at the crossing, not per tick)
    // The pure module only REPORTS the crossing (metadata, no body); the "recent output"
    // gate + loud log + broadcast live in the wiring binding.
    expect(h.livenessCalls).toEqual([{ workspacePath: '/ws/a', toAgent: 'spir-1', streak: 10 }]);
    drainer.stop();
  });

  it('liveness: a busy streak never reports onLiveness (a busy line is a human present)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    enqueue();
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 999999 });
    drainer.start(h.ports, db);
    for (let i = 0; i < 15; i++) await drainer.tick();
    expect(h.livenessCalls).toHaveLength(0);
    drainer.stop();
  });
});

describe('MailboxDrainer durable --delay (Spec 1313 round 3, change 1)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  const enqueue = (overrides: Partial<mailbox.EnqueueInput> = {}, now = 1000) =>
    mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body: 'hi', formattedMessage: 'M', ...overrides },
      now
    );

  it('a pre-due delayed row survives a drainer stop/start and delivers ONLY after its due time (durable + never early)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession()); // clean → would deliver the instant it is eligible
    enqueue({ formattedMessage: 'L', notBefore: 20000 }, 1000); // scheduled for t=20000

    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    h.now = 5000; // before due
    await drainer.tick();
    expect(h.writes).toHaveLength(0); // not delivered early

    // Tower "restart": stop drops all in-memory drainer state; the row is DURABLE (persisted).
    drainer.stop();
    const drainer2 = new MailboxDrainer({ intervalMs: 999999 });
    drainer2.start(h.ports, db);
    h.now = 15000; // still before due, now on a fresh drainer
    await drainer2.tick();
    expect(h.writes).toHaveLength(0); // the due time survived the restart — still not early

    h.now = 21000; // past due
    await drainer2.tick();
    expect(h.writes.map((w) => w.formattedMessage)).toEqual(['L']); // delivered, not before due
    drainer2.stop();
  });

  it('a pre-due delayed row does not block a later NORMAL message from delivering (eligibility ordering)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    // Delayed row enqueued FIRST (older created_at) but due far in the future; a normal row after it.
    enqueue({ formattedMessage: 'D', notBefore: 50000 }, 1000);
    const normal = enqueue({ formattedMessage: 'N' }, 2000);

    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    h.now = 3000; // the delayed row is not yet due
    await drainer.tick(); // the normal row is the oldest ELIGIBLE → delivers; the pre-due row waits
    expect(h.writes.map((w) => w.formattedMessage)).toEqual(['N']);
    expect(mailbox.getById(db, normal.id)?.status).toBe('delivered');
    drainer.stop();
  });

  it('a PRE-DUE delayed row never escalates; it escalates only after its DUE time, aged from due (not enqueue)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY); // stuck (held) once eligible, so it can reach escalation
    const row = enqueue({ formattedMessage: 'D', notBefore: 100000 }, 1000);
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 5000 });
    drainer.start(h.ports, db);

    h.now = 50000; // 49s past enqueue but NOT yet due
    await drainer.tick();
    expect(mailbox.getById(db, row.id)?.escalated).toBe(0); // scheduled, not stuck → no escalation
    expect(h.escalations).toHaveLength(0);

    h.now = 100000 + 6000; // past the due time by more than escalationMs
    await drainer.tick();
    expect(mailbox.getById(db, row.id)?.escalated).toBe(1);
    expect(h.escalations[0]).toMatchObject({ toAgent: 'spir-1', mailboxId: row.id, ageMs: 6000 }); // aged from DUE, not enqueue
    drainer.stop();
  });
});

describe('MailboxDrainer owner starvation notice (Spec 1313 round 3, change 3)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  const enqueue = (overrides: Partial<mailbox.EnqueueInput> = {}, now = 1000) =>
    mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body: 'hi', formattedMessage: 'M', ...overrides },
      now
    );

  it('raises an owner notice ONCE, only after the owner-notice threshold (not merely the escalation age)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY); // a stuck composer — held, never delivers
    enqueue({ reason: 'busy' }, 1000);
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 5000, ownerNoticeMs: 10000 });
    drainer.start(h.ports, db);

    h.now = 1000 + 6000; // past escalationMs (5s) but before ownerNoticeMs (10s)
    await drainer.tick();
    expect(h.ownerNotices).toHaveLength(0); // basic escalation may fire, but not the owner notice yet

    h.now = 1000 + 11000; // past the owner-notice threshold
    await drainer.tick();
    expect(h.ownerNotices).toHaveLength(1);
    expect(h.ownerNotices[0]).toMatchObject({ workspacePath: '/ws/a', toAgent: 'spir-1', reason: 'busy', heldCount: 1 });
    expect(drainer.notifiedOwnerAgents).toEqual([agentKey('/ws/a', 'spir-1')]);
    // Redaction: the notice payload carries no message body.
    expect(Object.keys(h.ownerNotices[0])).not.toContain('body');

    await drainer.tick(); // still stuck → NOT re-notified (once per episode)
    expect(h.ownerNotices).toHaveLength(1);
    drainer.stop();
  });

  it('clears the pending owner notice once the agent drains', async () => {
    const h = harness();
    // A moving token: clearing the composer produces new output, so bytesWritten advances and the
    // verdict memo re-classifies (a static token would serve the cached BUSY and never deliver).
    let bytes = 1;
    h.setSession('spir-1', {
      id: 'term-moving',
      get bytesWritten() { return bytes; },
      // Issue #1573: the repaint that cleared the composer has already settled by the time a
      // drainer tick sees it — ticks are 1.5 s apart, the settle window is 250 ms.
      lastDataAt: 0,
      info: { cols: 110, rows: 32 },
      command: 'claude',
      launchArgs: [],
      cwd: '/ws/a',
      writable: true,
      write: () => true,
    });
    h.setVerdict(BUSY);
    enqueue({ reason: 'busy' }, 1000);
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 5000, ownerNoticeMs: 10000 });
    drainer.start(h.ports, db);
    h.now = 12000;
    await drainer.tick(); // notice fires
    expect(drainer.notifiedOwnerAgents).toHaveLength(1);

    // The composer clears → new output advances the token → the gate re-classifies clean → the
    // row delivers → the agent is no longer starving → the moot notice is cleared.
    bytes = 50;
    h.setVerdict(CLEAN);
    await drainer.tick();
    expect(h.ownerClears).toEqual([{ workspacePath: '/ws/a', toAgent: 'spir-1' }]);
    expect(drainer.notifiedOwnerAgents).toEqual([]);
    drainer.stop();
  });

  it('never raises a notice ABOUT a notice — a held notice row does not itself trigger one', async () => {
    const h = harness();
    // No live sessions → both rows hold (no-live-pty), so both stay held past the threshold.
    // A pending owner notice (held, keyed with the notice prefix, addressed to the architect 'main').
    mailbox.supersede(
      db,
      '/ws/a',
      `${mailbox.NOTICE_SUPERSEDE_PREFIX}spir-1`,
      { workspacePath: '/ws/a', toAgent: 'main', body: 'starving!', formattedMessage: 'starving!' },
      1000
    );
    // A genuinely stuck builder.
    enqueue({ toAgent: 'spir-1', reason: 'busy' }, 1000);

    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 5000, ownerNoticeMs: 10000 });
    drainer.start(h.ports, db);
    h.now = 12000;
    await drainer.tick();

    // Only the builder's owner is notified; the notice recipient ('main') is never reported starving.
    expect(h.ownerNotices.map((n) => n.toAgent)).toEqual(['spir-1']);
    drainer.stop();
  });

  it('a pre-due-only agent never trips the owner notice (scheduled, not stuck)', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    enqueue({ formattedMessage: 'D', notBefore: 100000 }, 1000); // scheduled far out
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 5000, ownerNoticeMs: 10000 });
    drainer.start(h.ports, db);
    h.now = 50000; // well past ownerNoticeMs in wall-clock, but the row is not yet due
    await drainer.tick();
    expect(h.ownerNotices).toHaveLength(0);
    expect(drainer.notifiedOwnerAgents).toEqual([]);
    drainer.stop();
  });

  it('does NOT arm the once-per-episode guard when the notice no-ops (no architect yet), then fires once one resolves', async () => {
    const h = harness();
    // No live session → the row holds (no-live-pty) and stays stuck past the threshold.
    enqueue({ reason: 'busy' }, 1000);
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 5000, ownerNoticeMs: 10000 });
    drainer.start(h.ports, db);

    // No architect resolvable yet → escalateHeldToOwner no-ops (returns false). The guard must
    // stay UNSET so a later tick retries — else the alarm is suppressed for the whole episode
    // even after an architect appears (the optional-1 bug this asserts against).
    h.ports.escalateHeldToOwner = () => false;
    h.now = 12000; // past ownerNoticeMs (10s)
    await drainer.tick();
    expect(drainer.notifiedOwnerAgents).toEqual([]); // not armed — retries next tick

    // An architect registers → the notice now enqueues (returns true) → fired once, now armed.
    let fired = 0;
    h.ports.escalateHeldToOwner = () => { fired++; return true; };
    h.now = 13000;
    await drainer.tick();
    expect(fired).toBe(1);
    expect(drainer.notifiedOwnerAgents).toHaveLength(1);

    // Still stuck AND already armed → no repeat notify.
    await drainer.tick();
    expect(fired).toBe(1);
    drainer.stop();
  });
});

/**
 * Issue #1482 — the gate verdict's DETAIL survives the trip to the database.
 *
 * The render gate has always distinguished a composer that is legitimately occupied
 * (`user-text` — a human at the line, and the hold clears when they finish) from one it cannot
 * verify at all (`no-region-end` / `no-composer-marker` — a drifted profile, a torn frame, or
 * dimensions that do not match the real terminal, and the hold NEVER clears on its own). That
 * distinction lived only in memory on `DeliveryOutcome`, so every operator surface printed a
 * bare `busy` for both — which is why a dimension divergence could starve an agent invisibly.
 *
 * These pin the persistence contract the surfaces read from.
 */
describe('Issue #1482 — gate detail persisted on the held row', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => db.close());

  const enqueue = (overrides: Partial<mailbox.EnqueueInput> = {}, now = 1000) =>
    mailbox.enqueue(
      db,
      { workspacePath: '/ws/a', toAgent: 'spir-1', body: 'hi', formattedMessage: 'M', ...overrides },
      now
    );

  it.each([
    ['user-text', 'a human is at the composer'],
    ['no-region-end', 'the composer has no proven lower bound'],
    ['no-composer-marker', 'no marker on screen at all'],
  ] as const)('persists detail %s (%s)', async (detail) => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict({ clean: false, reason: 'busy', detail });
    const row = enqueue();

    const outcome = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    expect(outcome.reason).toBe('busy');
    expect(outcome.detail).toBe(detail);
    const stored = mailbox.getById(db, row.id);
    expect(stored?.reason).toBe('busy');
    expect(stored?.detail).toBe(detail);
  });

  it('a clean delivery clears both reason and detail', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    const row = enqueue();
    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(mailbox.getById(db, row.id)?.detail).toBe('user-text');

    // The human finishes; the next pass finds a clean prompt and delivers.
    h.setVerdict(CLEAN);
    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    const stored = mailbox.getById(db, row.id);
    expect(stored?.status).toBe('delivered');
    expect(stored?.reason).toBeNull();
    expect(stored?.detail).toBeNull();
  });

  it('a NON-gate hold nulls a previously-recorded detail', async () => {
    // The regression this guards: a row that held `busy:user-text` while a human typed, whose
    // terminal then died. Leaving the old detail in place would have `afx inbox` asserting
    // "a human is at the composer" about a session that no longer exists.
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    const row = enqueue();
    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(mailbox.getById(db, row.id)?.detail).toBe('user-text');

    h.setSession('spir-1', null); // the PTY is gone
    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');

    const stored = mailbox.getById(db, row.id);
    expect(stored?.reason).toBe('no-live-pty');
    expect(stored?.detail).toBeNull();
  });

  it('a repeated identical verdict does not bump updated_at', async () => {
    // `updated_at` means "when this row's verdict last MOVED" — that is what lets the
    // starvation notice talk about how long a composer has been occupied without a second
    // timestamp column. The backstop re-checks every 1.5s, so a per-tick bump would destroy it.
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict(BUSY);
    const row = enqueue();
    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    const firstUpdate = mailbox.getById(db, row.id)?.updated_at;

    h.now += 60_000;
    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(mailbox.getById(db, row.id)?.updated_at).toBe(firstUpdate);

    // A verdict that genuinely changes DOES move it.
    h.setVerdict({ clean: false, reason: 'busy', detail: 'no-region-end' });
    await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(mailbox.getById(db, row.id)?.updated_at).toBe(h.now);
  });

  it('carries the detail and the confirmation streak into the owner starvation notice', async () => {
    const h = harness();
    h.setSession('spir-1', fakeSession());
    h.setVerdict({ clean: false, reason: 'busy', detail: 'no-region-end' });
    enqueue({}, 1000);
    const drainer = new MailboxDrainer({ intervalMs: 999999, escalationMs: 5000, ownerNoticeMs: 10000 });
    drainer.start(h.ports, db);

    // Three passes before the notice is due: the streak grows to 3, all confirming the same
    // unverifiable verdict.
    h.now = 2000;
    await drainer.tick();
    h.now = 3000;
    await drainer.tick();
    h.now = 12000; // past ownerNoticeMs
    await drainer.tick();

    expect(h.ownerNotices).toHaveLength(1);
    expect(h.ownerNotices[0].reason).toBe('busy');
    expect(h.ownerNotices[0].detail).toBe('no-region-end');
    expect(h.ownerNotices[0].streak).toBe(3);
    drainer.stop();
  });
});
