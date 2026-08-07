/**
 * Cron delivery through the mailbox + gate (Spec 1313, Phase 6) — unit tests.
 *
 * Exercises the registry-free orchestration core `deliverCronMail` against a real
 * GLOBAL_SCHEMA-seeded SQLite DB (the mailbox operations are real — no mocking of the
 * system under test), with the delivery *edges* (live session, profile, gate verdict,
 * write, broadcast) injected as fakes so every branch is deterministic. This proves
 * the two Phase-6 guarantees: a busy screen HOLDS (never a blind write), and a newer
 * run of a task SUPERSEDES its own older held row (no backlog) — all on the single
 * gated path shared with `handleSend`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import { deliverCronMail, CRON_SENDER, type CronTarget } from '../servers/cron-delivery.js';
import type {
  DeliveryPorts,
  DeliverySession,
  DeliveredBroadcast,
} from '../servers/mailbox-delivery.js';
import type { GateProfile, GateVerdict } from '../servers/render-gate.js';

const PROFILE: GateProfile = { app: 'claude', markerPattern: /^❯/, regionEndPatterns: [] };
const CLEAN: GateVerdict = { clean: true, detail: 'empty' };
const BUSY: GateVerdict = { clean: false, reason: 'busy', detail: 'user-text' };

const WS = '/ws/a';
const AGENT = 'main';

/** A minimal DeliverySession fake (records writes). */
function fakeSession(): DeliverySession {
  return {
    bytesWritten: 0,
    info: { cols: 110, rows: 32 },
    command: 'claude',
    launchArgs: [],
    cwd: WS,
    writable: true,
    write: () => true,
  };
}

interface Harness {
  ports: DeliveryPorts;
  broadcasts: DeliveredBroadcast[];
  writes: Array<{ formattedMessage: string; noEnter: boolean }>;
  logs: string[];
  /** Count of onHeldStateChange fires (held-set-change SSE trigger). */
  heldChanges: number;
  setSession(session: DeliverySession | null): void;
  setProfile(p: GateProfile | null): void;
  setVerdict(v: GateVerdict): void;
  now: number;
}

function harness(): Harness {
  let session: DeliverySession | null = fakeSession();
  let profile: GateProfile | null = PROFILE;
  let verdict: GateVerdict = CLEAN;
  const broadcasts: DeliveredBroadcast[] = [];
  const writes: Array<{ formattedMessage: string; noEnter: boolean }> = [];
  const logs: string[] = [];
  const h: Harness = {
    broadcasts,
    writes,
    logs,
    heldChanges: 0,
    now: 1000,
    setSession: (s) => {
      session = s;
    },
    setProfile: (p) => {
      profile = p;
    },
    setVerdict: (v) => {
      verdict = v;
    },
    ports: {
      getSessionForAgent: () => session,
      resolveProfile: () => profile,
      classify: (_session: DeliverySession, _p: GateProfile): Promise<GateVerdict> => Promise.resolve(verdict),
      writeMessage: (_s, formattedMessage, noEnter) => {
        writes.push({ formattedMessage, noEnter });
        return true; // the write landed (Spec 1313: writeMessage reports delivery success)
      },
      broadcast: (f) => broadcasts.push(f),
      onHeldStateChange: () => {
        h.heldChanges++;
      },
      onEscalation: () => {},
      onLiveness: () => {},
      log: (m) => logs.push(m),
      now: () => h.now,
    },
  };
  return h;
}

function target(overrides: Partial<CronTarget> = {}): CronTarget {
  return {
    workspacePath: WS,
    toAgent: AGENT,
    terminalId: 'term-1',
    body: 'CI is red',
    formattedMessage: '[af-cron] CI is red',
    supersedeKey: 'nightly-ci',
    ...overrides,
  };
}

describe('deliverCronMail', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  it('delivers to a clean, render-verified empty prompt (outcome=delivered)', async () => {
    const h = harness();
    h.setVerdict(CLEAN);

    const result = await deliverCronMail(h.ports, db, target());

    expect(result.outcome).toBe('delivered');
    expect(result.reason).toBeNull();
    expect(result.mailboxId).not.toBeNull();
    // The exact formatted bytes were written, with a trailing Enter (noEnter=false).
    expect(h.writes).toEqual([{ formattedMessage: '[af-cron] CI is red', noEnter: false }]);
    // Persisted row is delivered; nothing left held.
    expect(mailbox.getById(db, result.mailboxId!)?.status).toBe('delivered');
    expect(mailbox.listHeld(db, WS)).toHaveLength(0);
    // The delivered broadcast carries the cron sender identity.
    expect(h.broadcasts).toHaveLength(1);
    expect(h.broadcasts[0].from.agent).toBe(CRON_SENDER);
    expect(h.broadcasts[0].content).toBe('CI is red');
  });

  it('holds on a busy line — never a blind write (outcome=held, reason=busy)', async () => {
    const h = harness();
    h.setVerdict(BUSY);

    const result = await deliverCronMail(h.ports, db, target());

    expect(result.outcome).toBe('held');
    expect(result.reason).toBe('busy');
    // No bytes written to the PTY, no delivered broadcast.
    expect(h.writes).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
    const held = mailbox.listHeld(db, WS);
    expect(held).toHaveLength(1);
    expect(held[0].status).toBe('held');
    expect(held[0].reason).toBe('busy');
    expect(held[0].from_agent).toBe(CRON_SENDER);
    expect(held[0].supersede_key).toBe('nightly-ci');
    // A new held row entered the set → the indicator-refresh port fired (Phase 7).
    expect(h.heldChanges).toBeGreaterThanOrEqual(1);
  });

  it('holds when there is no live PTY (outcome=held, reason=no-live-pty)', async () => {
    const h = harness();
    h.setSession(null); // recipient known but offline

    const result = await deliverCronMail(h.ports, db, target({ terminalId: null }));

    expect(result.outcome).toBe('held');
    expect(result.reason).toBe('no-live-pty');
    expect(h.writes).toHaveLength(0);
    expect(mailbox.listHeld(db, WS)).toHaveLength(1);
  });

  it('holds when no classifier profile resolves (outcome=held, reason=no-profile)', async () => {
    const h = harness();
    h.setProfile(null); // wrapper/boot screen — unknown app

    const result = await deliverCronMail(h.ports, db, target());

    expect(result.outcome).toBe('held');
    expect(result.reason).toBe('no-profile');
    expect(h.writes).toHaveLength(0);
    expect(mailbox.listHeld(db, WS)).toHaveLength(1);
  });

  it('a newer run supersedes its own older held row — no backlog (outcome=superseded)', async () => {
    const h = harness();
    h.setVerdict(BUSY);

    const first = await deliverCronMail(h.ports, db, target({ body: 'run 1', formattedMessage: '[af-cron] run 1' }));
    expect(first.outcome).toBe('held');

    const second = await deliverCronMail(h.ports, db, target({ body: 'run 2', formattedMessage: '[af-cron] run 2' }));
    expect(second.outcome).toBe('superseded');
    expect(second.reason).toBe('busy');

    // The prior run's row is superseded; exactly one row remains held (the newer run).
    expect(mailbox.getById(db, first.mailboxId!)?.status).toBe('superseded');
    const held = mailbox.listHeld(db, WS);
    expect(held).toHaveLength(1);
    expect(held[0].id).toBe(second.mailboxId);
    expect(held[0].body).toBe('run 2');
  });

  it('a newer run that finds the line clear delivers, dropping the stale held row', async () => {
    const h = harness();

    h.setVerdict(BUSY);
    const first = await deliverCronMail(h.ports, db, target({ body: 'stale', formattedMessage: '[af-cron] stale' }));
    expect(first.outcome).toBe('held');

    // Line clears before the next run: the newer message delivers and the stale one
    // is superseded (never delivered) — the "no backlog" guarantee.
    h.setVerdict(CLEAN);
    const second = await deliverCronMail(h.ports, db, target({ body: 'fresh', formattedMessage: '[af-cron] fresh' }));

    expect(second.outcome).toBe('delivered');
    expect(mailbox.getById(db, first.mailboxId!)?.status).toBe('superseded');
    expect(mailbox.getById(db, second.mailboxId!)?.status).toBe('delivered');
    expect(h.writes).toEqual([{ formattedMessage: '[af-cron] fresh', noEnter: false }]);
    expect(mailbox.listHeld(db, WS)).toHaveLength(0);
  });

  it('distinct tasks do not supersede each other (independent supersede keys)', async () => {
    const h = harness();
    h.setVerdict(BUSY);

    await deliverCronMail(h.ports, db, target({ supersedeKey: 'task-a', body: 'a' }));
    await deliverCronMail(h.ports, db, target({ supersedeKey: 'task-b', body: 'b' }));

    // Two different tasks → two independent held rows, neither superseding the other.
    const held = mailbox.listHeld(db, WS);
    expect(held).toHaveLength(2);
    expect(held.map((r) => r.body).sort()).toEqual(['a', 'b']);
  });
});
