/**
 * Alarm treatment for bounded-patience mail (Issue #1481).
 *
 * A `--interrupt-after` row is held mail that has PROMISED to resolve itself at a known instant.
 * Two rules follow, and both have a way of going wrong that is worse than the noise they
 * prevent:
 *
 *   - suppressing it before its deadline must not suppress the AGENT. A recipient with one armed
 *     row and five ordinary starving ones must still raise its owner notice, or the feature would
 *     silently hide exactly the incident the alarm exists for;
 *   - suppression must end the moment the promise does. Past the deadline, and immediately after
 *     a SKIPPED force (restart, offline, replaced session), the row is ordinary stuck mail again.
 *
 * The first half drives the SQL directly. The second half drives the real drainer against the
 * production `makeDeliveryPorts` binding and a seeded registry (the pattern established by
 * Issue #1477), so what is asserted is the notice an owner would actually receive.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import type { ArchitectState, Builder } from '../types.js';

let db: Database.Database | null = null;

// One shared in-memory global.db (Issue #1118): the registry reads in state.ts and the notice
// enqueue in mailbox-wiring.ts must see the same rows, exactly as they do in production.
vi.mock('../db/index.js', () => {
  const ensure = () => {
    if (!db) {
      db = new Database(':memory:');
      db.exec(GLOBAL_SCHEMA);
    }
    return db;
  };
  return { getDb: ensure, getGlobalDb: ensure, closeDb: () => {}, closeGlobalDb: () => {} };
});

const { getGlobalDb } = await import('../db/index.js');
const { setArchitectByName, upsertBuilder } = await import('../state.js');
const { makeDeliveryPorts } = await import('../servers/mailbox-wiring.js');
const { MailboxDrainer } = await import('../servers/mailbox-delivery.js');
const mailbox = await import('../db/mailbox.js');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pir-1481-alarms-')));
const WS = root;
const AGENT = 'pir-1481';

afterAll(() => {
  db?.close();
  db = null;
  rmSync(root, { recursive: true, force: true });
});

describe('Issue #1481 — starvation and escalation clocks', () => {
  let plain: Database.Database;
  const NOW = 1_000_000;

  beforeEach(() => {
    plain = new Database(':memory:');
    plain.exec(GLOBAL_SCHEMA);
  });
  afterEach(() => plain.close());

  const add = (
    id: string,
    opts: { createdAt?: number; interruptAt?: number | null; outcome?: string | null } = {},
  ): string => {
    const row = mailbox.enqueue(
      plain,
      {
        workspacePath: WS,
        toAgent: AGENT,
        body: id,
        formattedMessage: id,
        interruptAt: opts.interruptAt ?? null,
      },
      opts.createdAt ?? NOW - 600_000,
    );
    if (opts.outcome !== undefined) {
      plain.prepare('UPDATE mailbox SET interrupt_outcome = ? WHERE id = ?').run(opts.outcome, row.id);
    }
    return row.id;
  };

  const starving = (now = NOW) => mailbox.findStarvingAgents(plain, now).map((a) => a.toAgent);

  it('an ARMED pre-deadline row is not starving — it will resolve itself', () => {
    add('armed', { interruptAt: NOW + 60_000 });
    expect(starving()).toEqual([]);
  });

  it('but it never suppresses the AGENT: ordinary held mail still alarms', () => {
    // The failure this rules out is a per-recipient skip, which would hide five genuinely stuck
    // messages behind one row that happens to have a deadline.
    add('armed', { interruptAt: NOW + 60_000 });
    add('ordinary');
    const agents = mailbox.findStarvingAgents(plain, NOW);
    expect(agents.map((a) => a.toAgent)).toEqual([AGENT]);
    expect(agents[0].count).toBe(1); // the armed row is excluded, the ordinary one is not
    expect(agents[0].stuckSince).toBe(NOW - 600_000); // and the age is the ORDINARY row's
  });

  it('past its deadline the armed row participates like any other stuck mail', () => {
    add('armed', { interruptAt: NOW - 1_000 });
    expect(starving()).toEqual([AGENT]);
  });

  it('a SKIPPED force ends the suppression at once, whatever the deadline says', () => {
    // The dangerous case: a restart retires a force whose deadline is still an hour away. If
    // suppression keyed on the deadline rather than on the outcome, that row would stay invisible
    // to the alarm for an hour with nothing left to resolve it.
    add('armed', { interruptAt: NOW + 3_600_000, outcome: 'skipped-restart' });
    expect(starving()).toEqual([AGENT]);
  });

  it('a claimed row is gone from the held set entirely', () => {
    const id = add('armed', { interruptAt: NOW - 1_000 });
    mailbox.claimForForcedInterrupt(plain, id, 'claimed', NOW);
    expect(starving()).toEqual([]);
    expect(mailbox.listHeld(plain, WS)).toEqual([]);
  });

  it('prior-partial uncertainty alone does not lift the pre-deadline suppression', () => {
    const id = add('armed', { interruptAt: NOW + 60_000 });
    mailbox.markInterruptPriorPartial(plain, id, NOW);
    expect(starving()).toEqual([]); // still armed, still self-resolving
  });

  it('the escalation clock runs from the deadline while armed', () => {
    add('armed', { createdAt: NOW - 600_000, interruptAt: NOW + 10_000 });
    // 10 minutes old, but not yet deliverable-but-stuck by this feature's definition.
    expect(mailbox.findEscalatable(plain, 60_000, NOW)).toEqual([]);
    // 61 s past the deadline it escalates, exactly like an ordinary row 61 s past creation.
    expect(mailbox.findEscalatable(plain, 60_000, NOW + 71_000).map((r) => r.body)).toEqual(['armed']);
  });

  it('and reverts to the ordinary clock once the force is skipped', () => {
    add('armed', { createdAt: NOW - 600_000, interruptAt: NOW + 3_600_000, outcome: 'skipped-offline' });
    expect(mailbox.findEscalatable(plain, 60_000, NOW).map((r) => r.body)).toEqual(['armed']);
  });

  it('escalationStart() agrees with the SQL that selected the row', () => {
    // Two expressions for one rule is one more than ideal — the drainer reports an age it did
    // not compute in SQL. They are pinned against each other here so they cannot drift.
    const cases = [
      { createdAt: NOW - 600_000, interruptAt: null, outcome: undefined },
      { createdAt: NOW - 600_000, interruptAt: NOW + 10_000, outcome: undefined },
      { createdAt: NOW - 600_000, interruptAt: NOW - 10_000, outcome: undefined },
      { createdAt: NOW - 600_000, interruptAt: NOW + 10_000, outcome: 'skipped-restart' },
    ];
    for (const [i, c] of cases.entries()) {
      const id = add(`case-${i}`, c);
      const row = mailbox.getById(plain, id)!;
      const fromSql = plain
        .prepare(
          "SELECT MAX(created_at, COALESCE(not_before, created_at), " +
            "CASE WHEN interrupt_outcome = 'armed' THEN COALESCE(interrupt_at, created_at) ELSE created_at END) AS s " +
            'FROM mailbox WHERE id = ?',
        )
        .get(id) as { s: number };
      expect(mailbox.escalationStart(row)).toBe(fromSql.s);
    }
  });

  it('held COUNTS are unchanged — bounded-patience mail is held, not scheduled', () => {
    add('armed', { interruptAt: NOW + 60_000 });
    add('ordinary');
    // Both are deliverable right now, so both belong in the attention count. Only the ALARM
    // distinguishes them, because only the alarm is a claim about being stuck.
    expect(mailbox.heldSummaryForWorkspace(plain, WS, NOW).total).toBe(2);
    expect(mailbox.findHeldForAgent(plain, WS, AGENT, NOW)).toHaveLength(2);
  });
});

describe('Issue #1481 — the owner notice through the production wiring', () => {
  const logs: Array<{ level: string; message: string }> = [];
  const ports = () => makeDeliveryPorts((level, message) => logs.push({ level, message }));
  let drainer: InstanceType<typeof MailboxDrainer>;

  /** Register a builder whose worktree places it in WS, plus the architect that owns it. */
  function seedRegistry(): void {
    const architect: ArchitectState = { name: 'main', cmd: 'claude', startedAt: '2026-01-01T00:00:00.000Z' };
    setArchitectByName(WS, 'main', architect);
    const worktree = join(WS, '.builders', AGENT);
    mkdirSync(worktree, { recursive: true });
    const builder: Builder = {
      id: AGENT,
      name: AGENT,
      status: 'implementing',
      phase: 'implement',
      worktree,
      branch: `builder/${AGENT}`,
      type: 'spec',
      spawnedByArchitect: 'main',
    };
    upsertBuilder(builder);
  }

  /** The still-held notice rows about the starving agent — what the owner would receive. */
  const notices = (): number =>
    mailbox
      .listHeld(getGlobalDb(), WS)
      .filter((r) => r.supersede_key === `${mailbox.NOTICE_SUPERSEDE_PREFIX}${AGENT}`).length;

  const add = (body: string, interruptAt: number | null, ageMs = 600_000): string =>
    mailbox.enqueue(
      getGlobalDb(),
      { workspacePath: WS, toAgent: AGENT, body, formattedMessage: body, interruptAt },
      Date.now() - ageMs,
    ).id;

  beforeEach(() => {
    getGlobalDb().exec('DELETE FROM mailbox');
    logs.length = 0;
    seedRegistry();
    // Small thresholds so a row aged by its created_at is immediately overdue; the notice pass
    // itself is what is under test, not the durations.
    drainer = new MailboxDrainer({ intervalMs: 1_000_000, escalationMs: 1_000, ownerNoticeMs: 2_000 });
    drainer.start(ports(), getGlobalDb());
  });

  afterEach(() => drainer?.stop());

  it('raises no owner notice for an agent whose only held mail is a pending escalation', async () => {
    add('armed', Date.now() + 60_000);

    await drainer.tick();

    expect(notices()).toBe(0);
    expect(drainer.notifiedOwnerAgents).toEqual([]);
  });

  it('still raises one when the SAME agent also has ordinary stuck mail', async () => {
    add('armed', Date.now() + 60_000);
    add('ordinary', null);

    await drainer.tick();

    expect(notices()).toBe(1);
  });

  it('raises one for a bounded-patience row whose deadline has passed', async () => {
    // Past the deadline the promise is broken — either the force could not run or it is late,
    // and in both cases a human should hear about it.
    add('overdue', Date.now() - 10_000);

    await drainer.tick();

    expect(notices()).toBe(1);
  });

  it('raises one as soon as a restart retires the force, deadline notwithstanding', async () => {
    const id = add('armed', Date.now() + 3_600_000);
    mailbox.disarmInterruptsOnRestart(getGlobalDb(), Date.now());
    expect(mailbox.getById(getGlobalDb(), id)!.interrupt_outcome).toBe('skipped-restart');

    await drainer.tick();

    expect(notices()).toBe(1);
  });

  it('clears a standing notice once only pending escalations remain', async () => {
    const ordinary = add('ordinary', null);
    add('armed', Date.now() + 60_000);
    await drainer.tick();
    expect(notices()).toBe(1);

    // The ordinary mail drains; the armed row is all that is left, and it is not starving.
    mailbox.markDelivered(getGlobalDb(), ordinary);
    await drainer.tick();

    expect(notices()).toBe(0); // the standing notice was dismissed as moot
    expect(drainer.notifiedOwnerAgents).toEqual([]); // and the episode guard was released
  });
});
