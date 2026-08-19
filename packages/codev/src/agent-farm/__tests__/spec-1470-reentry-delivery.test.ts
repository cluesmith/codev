/**
 * Spec 1470, Phase 8 — re-entry delivery (spec tests 34 and 35).
 *
 * ## What is actually at risk
 *
 * The automatic refresh schedules its re-entry BEFORE it clears, so by the time
 * the clear lands the builder's only route back is that queued message. If it is
 * lost, the builder does not fail — it sits cleared and idle, looking exactly
 * like a builder that is working. That is the failure mode the whole feature is
 * shaped around, and these two tests pin the two ways it could happen:
 *
 *  - test 34: Tower restarts inside the delay window;
 *  - test 35: the builder's terminal is busy when the re-entry comes due.
 *
 * Both are exercised against a real file-backed SQLite database seeded from the
 * production schema, with injected timestamps. The file backing matters: a
 * restart is simulated by closing and reopening the connection, which an
 * in-memory database cannot express — it would vanish on close and the test
 * would prove the opposite of what it claims.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import type { EnqueueInput } from '../db/mailbox.js';
import { deliverAgentMail } from '../servers/mailbox-delivery.js';
import type { DeliveryPorts, DeliverySession } from '../servers/mailbox-delivery.js';
import type { GateVerdict } from '../servers/render-gate.js';
import { DEFAULT_REENTRY_DELAY_SECONDS } from '../commands/reset/constants.js';

describe('Spec 1470 — automatic re-entry delivery', () => {
  const testDir = resolve(process.cwd(), '.test-1470-reentry');
  const dbPath = resolve(testDir, 'global.db');
  let db: Database.Database;

  const WORKSPACE = '/ws/subject';
  const BUILDER = 'builder-spir-9001';
  const T0 = 1_800_000_000_000;
  const DELAY_MS = DEFAULT_REENTRY_DELAY_SECONDS * 1000;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(GLOBAL_SCHEMA);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // Already closed by a restart simulation.
    }
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  /** The re-entry exactly as the refresh queues it: delayed, to the builder. */
  function reentry(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
    return {
      workspacePath: WORKSPACE,
      toAgent: BUILDER,
      body: '/porch-resume',
      formattedMessage: '[automatic context refresh] resume from porch next',
      notBefore: T0 + DELAY_MS,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Spec test 34 — survives a Tower restart
  // -------------------------------------------------------------------------

  describe('spec test 34 — the re-entry survives a Tower restart', () => {
    it('is still pending after the process that scheduled it is gone', () => {
      const row = mailbox.enqueue(db, reentry(), T0);
      expect(row.not_before).toBe(T0 + DELAY_MS);

      // The restart. Everything in memory — timers, registries, the scheduling
      // process itself — is gone; only what was persisted at REQUEST time
      // remains.
      db.close();
      db = new Database(dbPath);

      const survived = mailbox.getById(db, row.id);
      expect(survived, 'the re-entry did not survive the restart').not.toBeNull();
      expect(survived!.status).toBe('held');
      expect(survived!.body).toBe('/porch-resume');
    });

    it('becomes deliverable at its due time, not before', () => {
      mailbox.enqueue(db, reentry(), T0);
      db.close();
      db = new Database(dbPath);

      // One millisecond early: still not deliverable. Asserted because a
      // restart that reset `not_before` to null would deliver instantly, and
      // an instant delivery is precisely the race the delay exists to avoid —
      // the re-entry would land while the clear is still in flight.
      const early = mailbox.findHeldForAgent(db, WORKSPACE, BUILDER, T0 + DELAY_MS - 1);
      expect(early, 'delivered before its due time after a restart').toEqual([]);

      const due = mailbox.findHeldForAgent(db, WORKSPACE, BUILDER, T0 + DELAY_MS);
      expect(due).toHaveLength(1);
      expect(due[0].body).toBe('/porch-resume');
    });

    it('a pre-due re-entry does not escalate while it is still waiting', () => {
      // Escalation means "this looks stuck, tell a human". A re-entry inside
      // its own delay window is not stuck, and a false escalation on every
      // single refresh would train its reader to ignore the signal.
      mailbox.enqueue(db, reentry(), T0);
      db.close();
      db = new Database(dbPath);

      const escalatable = mailbox.findEscalatable(db, 1000, T0 + DELAY_MS - 1);
      expect(escalatable.map(r => r.to_agent)).toEqual([]);
    });

    it('DOES escalate once it has been deliverable-but-stuck for the window', () => {
      // The paired positive. Without it, the negative above would also pass
      // against a system that never escalates anything at all.
      mailbox.enqueue(db, reentry(), T0);
      db.close();
      db = new Database(dbPath);

      const stuckFor = 60_000;
      const escalatable = mailbox.findEscalatable(db, stuckFor, T0 + DELAY_MS + stuckFor + 1);
      expect(escalatable.map(r => r.to_agent)).toEqual([BUILDER]);
    });
  });

  // -------------------------------------------------------------------------
  // Spec test 35 — held, not dropped, while the terminal is busy
  // -------------------------------------------------------------------------

  describe('spec test 35 — a busy terminal holds the re-entry', () => {
    /**
     * Ports driving the REAL delivery path, with the gate verdict as the only
     * variable.
     *
     * The first version of this test enqueued a row already marked
     * `reason: 'busy'` and read it back — which proves `enqueue` stores what it
     * is given and would have passed even if production delivered onto busy
     * terminals. Codex caught it. The claim is about the DECISION, so the
     * decision has to be exercised.
     */
    function portsWith(verdict: GateVerdict, writes: string[]): DeliveryPorts {
      const session = {
        bytesWritten: 1,
        info: { cols: 80, rows: 24 },
        command: 'claude',
        launchArgs: [],
        cwd: WORKSPACE,
        writable: true,
        write: () => true,
      } as unknown as DeliverySession;

      return {
        getSessionForAgent: () => session,
        resolveProfile: () => ({ markerPattern: /›/, regionEndPatterns: [] }) as never,
        classify: async () => verdict,
        writeMessage: (_s, formatted) => {
          writes.push(formatted);
          return true;
        },
        broadcast: () => {},
        log: () => {},
        onHeldStateChange: () => {},
        onEscalation: () => {},
        onLiveness: () => {},
        now: () => T0 + DELAY_MS,
      } as unknown as DeliveryPorts;
    }

    it('a BUSY gate holds the re-entry: nothing is written, the row stays held', async () => {
      const row = mailbox.enqueue(db, reentry(), T0);
      const writes: string[] = [];

      const outcome = await deliverAgentMail(
        portsWith({ clean: false, reason: 'busy', detail: 'user-text' }, writes),
        db,
        WORKSPACE,
        BUILDER,
      );

      // Nothing delivered, and — the part that matters — nothing WRITTEN. A
      // re-entry written onto a busy prompt fuses with whatever the builder was
      // typing.
      expect(writes, 'wrote onto a busy terminal').toEqual([]);
      expect(outcome.delivered).toEqual([]);
      expect(outcome.reason).toBe('busy');

      const after = mailbox.getById(db, row.id);
      expect(after!.status, 'a busy gate must HOLD, never drop').toBe('held');
      expect(after!.reason).toBe('busy');
      expect(after!.resolved_at).toBeNull();
    });

    it('a CLEAN gate delivers it', async () => {
      // The paired positive. Without it the test above would pass equally well
      // against a delivery path that never delivers anything at all.
      const row = mailbox.enqueue(db, reentry(), T0);
      const writes: string[] = [];

      const outcome = await deliverAgentMail(
        portsWith({ clean: true, detail: 'empty' } as GateVerdict, writes),
        db,
        WORKSPACE,
        BUILDER,
      );

      expect(writes).toHaveLength(1);
      expect(writes[0]).toContain('resume from porch next');
      expect(outcome.delivered).toEqual([row.id]);
      expect(mailbox.getById(db, row.id)!.status).toBe('delivered');
    });

    it('a PRE-DUE re-entry is not delivered even onto a clean prompt', async () => {
      // The delay is a lower bound the gate must not override: an early
      // delivery is the race the whole schedule-before-clear ordering exists to
      // avoid.
      mailbox.enqueue(db, reentry(), T0);
      const writes: string[] = [];
      const ports = portsWith({ clean: true, detail: 'empty' } as GateVerdict, writes);
      (ports as { now: () => number }).now = () => T0 + DELAY_MS - 1;

      const outcome = await deliverAgentMail(ports, db, WORKSPACE, BUILDER);

      expect(writes, 'delivered a re-entry before its due time').toEqual([]);
      expect(outcome.delivered).toEqual([]);
    });

    it('is delivered once, and is no longer deliverable afterwards', () => {
      const row = mailbox.enqueue(db, reentry(), T0);
      const now = T0 + DELAY_MS;

      expect(mailbox.findHeldForAgent(db, WORKSPACE, BUILDER, now)).toHaveLength(1);
      expect(mailbox.markDelivered(db, row.id, now)).toBe(true);

      // A second delivery would re-enter an already-resumed builder mid-task.
      expect(mailbox.findHeldForAgent(db, WORKSPACE, BUILDER, now)).toEqual([]);
      expect(mailbox.getById(db, row.id)!.status).toBe('delivered');
    });

    it('survives a restart while held for a busy terminal', () => {
      // The two failure modes composed: Tower restarts while the re-entry is
      // already being held. Tested because each is only ever exercised alone,
      // and "held" plus "restart" is the state a real refresh most plausibly
      // hits — the builder is busy precisely because it is finishing the work
      // the boundary follows.
      const row = mailbox.enqueue(db, reentry({ reason: 'busy' }), T0);
      db.close();
      db = new Database(dbPath);

      const after = mailbox.getById(db, row.id);
      expect(after, 'a held re-entry was lost across a restart').not.toBeNull();
      expect(after!.status).toBe('held');
      expect(mailbox.findHeldForAgent(db, WORKSPACE, BUILDER, T0 + DELAY_MS)).toHaveLength(1);
    });

    it('is addressed to the agent, so it survives the terminal changing', () => {
      // The re-entry outlives the PTY it was queued against: a refresh clears
      // the session, and the builder may come back on a different terminal id.
      // Addressing by terminal rather than agent would strand it.
      const row = mailbox.enqueue(db, reentry({ terminalId: 'pty-before-clear' }), T0);
      db.close();
      db = new Database(dbPath);

      const found = mailbox.findHeldForAgent(db, WORKSPACE, BUILDER, T0 + DELAY_MS);
      expect(found).toHaveLength(1);
      expect(found[0].id).toBe(row.id);
      expect(found[0].to_agent).toBe(BUILDER);
    });
  });
});
