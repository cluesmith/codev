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
  setSession(agent: string, session: DeliverySession | null): void;
  setProfile(p: GateProfile | null): void;
  setVerdict(v: GateVerdict): void;
  now: number;
}

function harness(): Harness {
  const sessions = new Map<string, DeliverySession | null>();
  let profile: GateProfile | null = PROFILE;
  let verdict: GateVerdict = CLEAN;
  const broadcasts: DeliveredBroadcast[] = [];
  const writes: Array<{ formattedMessage: string; noEnter: boolean }> = [];
  const logs: string[] = [];
  const h: Harness = {
    broadcasts,
    writes,
    logs,
    now: 1000,
    setSession: (agent, s) => sessions.set(agent, s),
    setProfile: (p) => {
      profile = p;
    },
    setVerdict: (v) => {
      verdict = v;
    },
    ports: {
      getSessionForAgent: (_ws, agent) => sessions.get(agent) ?? null,
      resolveProfile: () => profile,
      classify: (_snap: RingSnapshot, _p: GateProfile): Promise<GateVerdict> => Promise.resolve(verdict),
      writeMessage: (_s, formattedMessage, noEnter) => writes.push({ formattedMessage, noEnter }),
      broadcast: (f) => broadcasts.push(f),
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

    expect(out).toEqual({ delivered: [], reason: 'busy' });
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
