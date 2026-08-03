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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
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
} from '../servers/mailbox-delivery.js';
import type { GateProfile, GateVerdict, RingSnapshot } from '../servers/render-gate.js';

const PROFILE: GateProfile = { app: 'claude', markerPattern: /^❯/, regionEndPatterns: [] };
const CLEAN: GateVerdict = { clean: true, detail: 'empty' };
const BUSY: GateVerdict = { clean: false, reason: 'busy', detail: 'user-text' };

/** A minimal DeliverySession fake (records writes). */
function fakeSession(overrides: Partial<DeliverySession> = {}): DeliverySession & { writes: string[] } {
  const writes: string[] = [];
  return {
    ringBuffer: { getAll: () => ['❯ '] },
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
  setSession(agent: string, session: DeliverySession | null): void;
  setProfile(p: GateProfile | null): void;
  setVerdict(v: GateVerdict): void;
  setClassify(fn: ((snap: RingSnapshot, p: GateProfile) => Promise<GateVerdict>) | null): void;
  now: number;
}

function harness(): Harness {
  const sessions = new Map<string, DeliverySession | null>();
  let profile: GateProfile | null = PROFILE;
  let verdict: GateVerdict = CLEAN;
  let classifyOverride: ((snap: RingSnapshot, p: GateProfile) => Promise<GateVerdict>) | null = null;
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
    now: 1000,
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
      classify: (snap: RingSnapshot, p: GateProfile): Promise<GateVerdict> =>
        classifyOverride ? classifyOverride(snap, p) : Promise.resolve(verdict),
      writeMessage: (_s, formattedMessage, noEnter) => writes.push({ formattedMessage, noEnter }),
      broadcast: (f) => broadcasts.push(f),
      onHeldStateChange: () => {
        h.heldChanges++;
      },
      onEscalation: (info) => h.escalations.push(info),
      onLiveness: (info) => h.livenessCalls.push(info),
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

  it('re-validates the SCREEN after the classify: a keystroke landing during the render → holds, never writes (Spec 1313 render-gate hardening)', async () => {
    // The whole-ring classify is async (~tens of ms); if the user starts typing during
    // it, the clean verdict is for a screen that no longer exists. The delivery path
    // samples the ring change-token before the classify and re-checks it after — a
    // change means "screen moved under us" → hold, never write the message onto the
    // now-present draft (the false-clean the gate exists to prevent).
    let seq = 0;
    const session: DeliverySession = {
      ringBuffer: {
        getAll: () => ['❯ '],
        get currentSeq() {
          return seq;
        },
        get partialBytes() {
          return 0;
        },
      },
      info: { cols: 110, rows: 32 },
      command: 'claude',
      launchArgs: [],
      cwd: '/ws/a',
      writable: true,
      write: () => true,
    };
    const h = harness();
    h.setSession('spir-1', session);
    // Model the keystroke: the ring token advances *during* the classify, which still
    // returns CLEAN for the (now stale) screen it was handed.
    h.setClassify(async () => {
      seq++;
      return CLEAN;
    });
    const row = enqueue();

    const out = await deliverAgentMail(h.ports, db, '/ws/a', 'spir-1');
    expect(out.delivered).toEqual([]);
    expect(out.reason).toBe('busy'); // held: the screen moved under the gate
    expect(h.writes).toHaveLength(0); // never wrote onto the draft that appeared
    expect(mailbox.getById(db, row.id)?.status).toBe('held');
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
    // Per-agent verdict via classify override:
    h.ports.classify = (_snap, _p) => Promise.resolve(CLEAN); // default clean; B overridden below

    const rowA = mailbox.enqueue(db, { workspacePath: '/ws', toAgent: 'A', body: 'a', formattedMessage: 'A' }, 1000);
    mailbox.enqueue(db, { workspacePath: '/ws', toAgent: 'B', body: 'b', formattedMessage: 'B' }, 1000);

    // Make B busy by keying classify on the session identity.
    h.ports.classify = (_snap, _p) => Promise.resolve(_snap.replay === 'busyB' ? BUSY : CLEAN);
    (sessionB.ringBuffer as { getAll: () => string[] }).getAll = () => ['busyB'];

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

  it('classifies a STATIC ring once: a second backstop tick reuses the cached verdict (no re-render)', async () => {
    const h = harness();
    // Stable ring token across ticks (currentSeq/partialBytes constant) + a busy verdict,
    // so the message stays held and both ticks attempt delivery for the same agent.
    h.setSession('spir-1', fakeSession({ ringBuffer: { getAll: () => ['❯ '], currentSeq: 7, partialBytes: 0 } }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return BUSY; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick(); // classify #1 — memo miss
    await drainer.tick(); // static token → memo hit, NOT re-rendered
    drainer.stop();
    expect(classifyCalls).toBe(1);
  });

  it('re-classifies after the ring CHANGES — the memo is keyed on the ring token', async () => {
    const h = harness();
    let seq = 7;
    h.setSession('spir-1', fakeSession({
      ringBuffer: { getAll: () => ['❯ '], get currentSeq() { return seq; }, partialBytes: 0 },
    }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return BUSY; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick(); // classify #1 (miss)
    await drainer.tick(); // memo hit (token unchanged)
    seq = 8;              // new output → token advances
    await drainer.tick(); // classify #2 (token changed → re-render)
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
    h.setSession('spir-1', fakeSession({ ringBuffer: { getAll: () => ['❯ '], currentSeq: 3, partialBytes: 0 } }));
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
    h.setSession('spir-1', fakeSession({ ringBuffer: { getAll: () => ['❯ '], currentSeq: 3, partialBytes: 0 } }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return CLEAN; };
    const m1 = held('spir-1', 'm1', 1000);
    held('spir-1', 'm2', 1001);
    h.ports.writeMessage = (_s, formattedMessage, noEnter) => {
      h.writes.push({ formattedMessage, noEnter });
      if (formattedMessage === 'm1') mailbox.dismiss(db, m1.id, 1002); // operator dismisses during the paced write
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
    // not only a clean return. writeMessage's port contract is void|Promise<void>, so a binding could
    // reject after putting bytes on the wire; without the finally the stale CLEAN survives and a
    // follow-up could memo-hit it. Here writeMessage records partial output then rejects → the row
    // stays held (deliverAgentMail throws, caught by the per-agent tick guard) → the NEXT tick must
    // re-classify fresh, not memo-hit. Static ring, so a re-classify can only come from invalidation.
    h.setSession('spir-1', fakeSession({ ringBuffer: { getAll: () => ['❯ '], currentSeq: 3, partialBytes: 0 } }));
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
    h.setSession('spir-1', fakeSession({ ringBuffer: { getAll: () => ['❯ '], currentSeq: 1, partialBytes: 0 } }));
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
    h.setSession('spir-1', fakeSession({ ringBuffer: { getAll: () => ['❯ '], currentSeq: 5, partialBytes: 0 } }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return BUSY; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    await drainer.tick(); // classify #1 — caches {sessionA, token}
    // Swap in a DIFFERENT session object carrying the SAME token — models a respawned PTY whose
    // fresh ring (currentSeq restarts at 0) transiently reproduces the cached currentSeq/partial.
    // Token-only matching would serve the stale verdict; the session guard forces a re-classify.
    h.setSession('spir-1', fakeSession({ ringBuffer: { getAll: () => ['❯ '], currentSeq: 5, partialBytes: 0 } }));
    await drainer.tick();
    drainer.stop();
    expect(classifyCalls).toBe(2);
  });

  it('backs off re-classifying a BIG busy ring in the backstop; scheduleDrain still delivers on clear', async () => {
    const h = harness();
    let seq = 1;
    const bigReplay = 'x'.repeat(4 * 1024 * 1024 + 16); // > BIG_RING_UNITS (4 M units)
    h.setSession('spir-1', fakeSession({
      ringBuffer: { getAll: () => [bigReplay], get currentSeq() { return seq; }, partialBytes: 0 },
    }));
    let classifyCalls = 0;
    h.ports.classify = async () => { classifyCalls++; return BUSY; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    // Each tick the busy ring changes (token advances → the memo always misses). Without backoff
    // that is one whole-render per tick; with backoff the backstop skips ticks after a big
    // not-clean render (span 1, 2, 4…). 4 ticks ⇒ fewer than 4 classifies.
    for (let i = 0; i < 4; i++) { seq++; await drainer.tick(); }
    expect(classifyCalls).toBeLessThan(4);
    expect(drainer.backoffAgents).toContain(agentKey('/ws', 'spir-1'));

    // The line clears and a submit/quiescence trigger fires. scheduleDrain classifies FRESH
    // (ignores the backoff) and delivers, resetting the backoff so the backstop resumes.
    h.ports.classify = async () => { classifyCalls++; return CLEAN; };
    seq++;
    await drainer.scheduleDrain('/ws', 'spir-1');
    drainer.stop();
    expect(drainer.backoffAgents).toHaveLength(0);
  });

  it('backoff does NOT delay the classifier-stuck liveness escalation — the streak advances during cooldown', async () => {
    const h = harness();
    let seq = 1;
    const bigReplay = 'x'.repeat(4 * 1024 * 1024 + 16); // big → backoff throttles re-classify
    h.setSession('spir-1', fakeSession({
      ringBuffer: { getAll: () => [bigReplay], get currentSeq() { return seq; }, partialBytes: 0 },
    }));
    // A big ring the gate can't bound → `no-region-end` (classifier-stuck): the SAME population
    // the backoff throttles is the one the liveness net guards. The streak must still cross its
    // threshold (10) on schedule even though most re-classifies are skipped — via the cached
    // classification re-fed on each skipped tick (CMAP round 2 — Claude/Codex).
    h.ports.classify = async () => ({ clean: false, reason: 'busy', detail: 'no-region-end' });
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    for (let i = 0; i < 12; i++) { seq++; await drainer.tick(); } // > threshold, even with skips
    drainer.stop();
    expect(h.livenessCalls.length).toBeGreaterThan(0);
    expect(h.livenessCalls[0]).toMatchObject({ toAgent: 'spir-1', streak: 10 });
  });

  it('forces a fresh classify at the liveness-threshold crossing — a ring that CLEARED mid-cooldown does not false-escalate (CMAP round 3 — Codex/Claude)', async () => {
    const h = harness();
    let seq = 1;
    const bigReplay = 'x'.repeat(4 * 1024 * 1024 + 16); // big → backoff throttles re-classify
    h.setSession('spir-1', fakeSession({
      ringBuffer: { getAll: () => [bigReplay], get currentSeq() { return seq; }, partialBytes: 0 },
    }));
    // Backoff schedule (threshold 10): classify on ticks 1,3,6; every tick (classified OR skipped)
    // advances the streak, so it is 9 after tick 9 with a cooldown skip still pending. Tick 10 is the
    // crossing. PRE-fix it would SKIP and re-feed the STALE `no-region-end`, firing a spurious
    // onLiveness even though the ring has since cleared. The fix forces a real classify at exactly
    // that crossing tick, so the escalation reflects the CURRENT screen (here: cleared → delivers).
    let stuck = true;
    let classifyCalls = 0;
    h.ports.classify = async () => {
      classifyCalls++;
      return stuck ? { clean: false, reason: 'busy', detail: 'no-region-end' } : CLEAN;
    };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    for (let i = 0; i < 9; i++) { seq++; await drainer.tick(); } // streak → 9, still stuck, backoff active
    expect(h.livenessCalls).toHaveLength(0);
    expect(drainer.streaks.get(agentKey('/ws', 'spir-1'))).toBe(9);
    stuck = false;               // the ring clears — but NO fast trigger is observed (backstop only)
    const callsBefore = classifyCalls;
    seq++; await drainer.tick(); // tick 10 = the crossing → MUST force a fresh classify, not skip
    drainer.stop();
    expect(classifyCalls).toBe(callsBefore + 1);    // a real classify happened at the crossing (pre-fix: skipped, +0)
    expect(h.livenessCalls).toHaveLength(0);         // fresh CLEAN → NO false classifier-stuck escalation
    expect(h.writes.map((w) => w.formattedMessage)).toEqual(['hi']); // the cleared line actually delivered
  });

  it('generation guard (tick): an in-flight pass that resumes after stop() does not seed the new generation (CMAP round 3 — all three)', async () => {
    const h = harness();
    const bigReplay = 'x'.repeat(4 * 1024 * 1024 + 16); // big → a resumed pass WOULD seed a backoff entry
    h.setSession('spir-1', fakeSession({ ringBuffer: { getAll: () => [bigReplay], currentSeq: 1, partialBytes: 0 } }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    h.ports.classify = async () => { await gate; return { clean: false, reason: 'busy', detail: 'no-region-end' }; };
    held('spir-1');
    const drainer = new MailboxDrainer({ intervalMs: 999999 });
    drainer.start(h.ports, db);
    const inFlight = drainer.tick(); // parks at the classify await
    drainer.stop();                  // bumps the generation + clears the streak/backoff maps
    release();                       // classify resolves → the tick resumes PAST the await
    await inFlight;                  // the post-await generation check must bail before recordStreak/updateBackoff
    expect(drainer.streaks.size).toBe(0);          // pre-fix: the resumed recordStreak seeds a stale streak (size 1)
    expect(drainer.backoffAgents).toHaveLength(0); // pre-fix: the resumed updateBackoff seeds a stale backoff entry
  });

  it('generation guard (scheduleDrain): a queued drain that resumes after stop() does not seed the new generation (CMAP round 3 — Codex)', async () => {
    const h = harness();
    const bigReplay = 'x'.repeat(4 * 1024 * 1024 + 16);
    h.setSession('spir-1', fakeSession({ ringBuffer: { getAll: () => [bigReplay], currentSeq: 1, partialBytes: 0 } }));
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
      { workspacePath: '/ws/a', toAgent: 'spir-1', mailboxId: row.id, ageMs: 6000, reason: 'busy' },
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
