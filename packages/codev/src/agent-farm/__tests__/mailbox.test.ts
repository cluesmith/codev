/**
 * Mailbox repository (Spec 1313) — lifecycle unit tests.
 *
 * Exercises the real repository functions against a real (file-backed) SQLite
 * database seeded from GLOBAL_SCHEMA — no mocking of the system under test. The
 * file-backed DB lets us verify crash/restart recovery by closing and reopening
 * the connection. Timestamps are injected so ordering and age assertions are
 * deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import type { EnqueueInput } from '../db/mailbox.js';

describe('Mailbox repository (Spec 1313)', () => {
  const testDir = resolve(process.cwd(), '.test-mailbox');
  const dbPath = resolve(testDir, 'global.db');
  let db: Database.Database;

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(GLOBAL_SCHEMA);
  });

  afterEach(() => {
    db.close();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
  });

  function input(overrides: Partial<EnqueueInput> = {}): EnqueueInput {
    return {
      workspacePath: '/ws/a',
      toAgent: 'spir-1313',
      body: 'hello world',
      formattedMessage: '[from architect] hello world',
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // enqueue
  // ---------------------------------------------------------------------------

  it('enqueue persists a held row with a generated id, defaults, and injected timestamps', () => {
    const row = mailbox.enqueue(db, input({ reason: 'busy' }), 1000);

    expect(row.id).toMatch(/[0-9a-f-]{36}/);
    expect(row.status).toBe('held');
    expect(row.reason).toBe('busy');
    expect(row.no_enter).toBe(0);
    expect(row.escalated).toBe(0);
    expect(row.created_at).toBe(1000);
    expect(row.updated_at).toBe(1000);
    expect(row.resolved_at).toBeNull();

    // Round-trips through the table byte-for-byte.
    expect(mailbox.getById(db, row.id)).toEqual(row);
  });

  it('enqueue maps optional fields (noEnter → 1, null defaults for from/terminal)', () => {
    const row = mailbox.enqueue(db, input({ noEnter: true }), 1000);
    expect(row.no_enter).toBe(1);
    expect(row.terminal_id).toBeNull();
    expect(row.from_agent).toBeNull();
    expect(row.from_workspace).toBeNull();
    expect(row.supersede_key).toBeNull();
    expect(mailbox.getById(db, row.id)?.no_enter).toBe(1);
  });

  it('getById returns null for an unknown id', () => {
    expect(mailbox.getById(db, 'does-not-exist')).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // listHeld / findHeldForAgent — scoping and ordering
  // ---------------------------------------------------------------------------

  it('listHeld returns only held rows, workspace-scoped, oldest first', () => {
    mailbox.enqueue(db, input({ toAgent: 'a', body: 'first' }), 100);
    mailbox.enqueue(db, input({ toAgent: 'b', body: 'second' }), 200);
    mailbox.enqueue(db, input({ workspacePath: '/ws/other', body: 'elsewhere' }), 150);

    const scoped = mailbox.listHeld(db, '/ws/a');
    expect(scoped.map((r) => r.body)).toEqual(['first', 'second']);

    // Workspace-wide includes the other workspace's held row.
    const all = mailbox.listHeld(db);
    expect(all).toHaveLength(3);
  });

  it('listHeld excludes delivered/dismissed/superseded rows', () => {
    const held = mailbox.enqueue(db, input({ body: 'held' }), 100);
    const delivered = mailbox.enqueue(db, input({ body: 'delivered' }), 200);
    const dismissed = mailbox.enqueue(db, input({ body: 'dismissed' }), 300);
    mailbox.markDelivered(db, delivered.id, 250);
    mailbox.dismiss(db, dismissed.id, 350);

    expect(mailbox.listHeld(db, '/ws/a').map((r) => r.id)).toEqual([held.id]);
  });

  it('findHeldForAgent returns that agent\'s held rows in enqueue order (created_at ASC)', () => {
    // Enqueue out of chronological order to prove the ORDER BY, not insertion order.
    mailbox.enqueue(db, input({ toAgent: 'x', body: 'newer' }), 300);
    mailbox.enqueue(db, input({ toAgent: 'x', body: 'older' }), 100);
    mailbox.enqueue(db, input({ toAgent: 'y', body: 'other-agent' }), 200);

    const forX = mailbox.findHeldForAgent(db, '/ws/a', 'x');
    expect(forX.map((r) => r.body)).toEqual(['older', 'newer']);

    expect(mailbox.findHeldForAgent(db, '/ws/a', 'nobody')).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // State machine: markDelivered / dismiss
  // ---------------------------------------------------------------------------

  it('markDelivered transitions held → delivered, nulls the reason, stamps resolved_at', () => {
    const row = mailbox.enqueue(db, input({ reason: 'busy' }), 1000);
    expect(mailbox.markDelivered(db, row.id, 2000)).toBe(true);

    const after = mailbox.getById(db, row.id)!;
    expect(after.status).toBe('delivered');
    expect(after.reason).toBeNull();
    expect(after.resolved_at).toBe(2000);
    expect(after.updated_at).toBe(2000);
  });

  it('markDelivered is a no-op on an already-terminal row (no re-deliver, no revert)', () => {
    const row = mailbox.enqueue(db, input(), 1000);
    expect(mailbox.markDelivered(db, row.id, 2000)).toBe(true);
    // Second attempt (e.g. a backstop racing a submit trigger) changes nothing.
    expect(mailbox.markDelivered(db, row.id, 3000)).toBe(false);

    const after = mailbox.getById(db, row.id)!;
    expect(after.status).toBe('delivered');
    expect(after.resolved_at).toBe(2000); // not overwritten by the losing call
  });

  it('markDelivered returns false for an unknown id', () => {
    expect(mailbox.markDelivered(db, 'nope', 2000)).toBe(false);
  });

  it('dismiss transitions held → dismissed, preserves the reason, and drops it from the held set', () => {
    const row = mailbox.enqueue(db, input({ reason: 'no-live-pty' }), 1000);
    expect(mailbox.dismiss(db, row.id, 2000)).toBe(true);

    const after = mailbox.getById(db, row.id)!;
    expect(after.status).toBe('dismissed');
    expect(after.reason).toBe('no-live-pty'); // audit trail preserved
    expect(after.resolved_at).toBe(2000);
    expect(mailbox.listHeld(db, '/ws/a')).toEqual([]);
  });

  it('dismiss is a no-op on a delivered row (terminal states are final)', () => {
    const row = mailbox.enqueue(db, input(), 1000);
    mailbox.markDelivered(db, row.id, 2000);
    expect(mailbox.dismiss(db, row.id, 3000)).toBe(false);
    expect(mailbox.getById(db, row.id)?.status).toBe('delivered');
  });

  // ---------------------------------------------------------------------------
  // supersede
  // ---------------------------------------------------------------------------

  it('supersede replaces the held row sharing the key and enqueues the replacement', () => {
    const first = mailbox.enqueue(
      db,
      input({ body: 'run 1', supersedeKey: 'nightly' }),
      1000
    );
    const second = mailbox.supersede(
      db,
      '/ws/a',
      'nightly',
      input({ body: 'run 2' }),
      2000
    );

    expect(mailbox.getById(db, first.id)?.status).toBe('superseded');
    expect(mailbox.getById(db, first.id)?.resolved_at).toBe(2000);
    expect(second.status).toBe('held');
    expect(second.supersede_key).toBe('nightly');

    // Only the replacement remains held.
    expect(mailbox.listHeld(db, '/ws/a').map((r) => r.id)).toEqual([second.id]);
  });

  it('supersede only replaces held rows — a delivered row with the same key is untouched', () => {
    const delivered = mailbox.enqueue(
      db,
      input({ body: 'already out', supersedeKey: 'nightly' }),
      1000
    );
    mailbox.markDelivered(db, delivered.id, 1500);

    const replacement = mailbox.supersede(
      db,
      '/ws/a',
      'nightly',
      input({ body: 'new run' }),
      2000
    );

    // The delivered row keeps its status (history is not rewritten).
    expect(mailbox.getById(db, delivered.id)?.status).toBe('delivered');
    expect(replacement.status).toBe('held');
    expect(mailbox.listHeld(db, '/ws/a').map((r) => r.id)).toEqual([replacement.id]);
  });

  it('supersede with no existing held row is just an enqueue', () => {
    const row = mailbox.supersede(db, '/ws/a', 'fresh-key', input({ body: 'only run' }), 1000);
    expect(row.status).toBe('held');
    expect(mailbox.listHeld(db, '/ws/a')).toHaveLength(1);
  });

  it('supersede is workspace-scoped — a same-key held row in another workspace is not touched', () => {
    const other = mailbox.enqueue(
      db,
      input({ workspacePath: '/ws/other', supersedeKey: 'nightly' }),
      1000
    );
    mailbox.supersede(db, '/ws/a', 'nightly', input(), 2000);
    expect(mailbox.getById(db, other.id)?.status).toBe('held');
  });

  // ---------------------------------------------------------------------------
  // pruneTerminal
  // ---------------------------------------------------------------------------

  it('pruneTerminal removes only terminal rows older than the window; never a held row', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 100 * DAY;

    // Held row, old — must survive.
    const held = mailbox.enqueue(db, input({ body: 'held' }), now - 60 * DAY);
    // Delivered long ago — must be pruned.
    const oldDelivered = mailbox.enqueue(db, input({ body: 'old' }), now - 60 * DAY);
    mailbox.markDelivered(db, oldDelivered.id, now - 40 * DAY);
    // Dismissed recently — must survive a 30-day window.
    const recentDismissed = mailbox.enqueue(db, input({ body: 'recent' }), now - 5 * DAY);
    mailbox.dismiss(db, recentDismissed.id, now - 2 * DAY);

    const deleted = mailbox.pruneTerminal(db, 30, now);
    expect(deleted).toBe(1);

    expect(mailbox.getById(db, held.id)?.status).toBe('held');
    expect(mailbox.getById(db, oldDelivered.id)).toBeNull();
    expect(mailbox.getById(db, recentDismissed.id)?.status).toBe('dismissed');
  });

  it('pruneTerminal never deletes a held row even with a zero-day window', () => {
    const held = mailbox.enqueue(db, input(), 1000);
    const deleted = mailbox.pruneTerminal(db, 0, 10_000_000);
    expect(deleted).toBe(0);
    expect(mailbox.getById(db, held.id)?.status).toBe('held');
  });

  // ---------------------------------------------------------------------------
  // Crash / restart recovery
  // ---------------------------------------------------------------------------

  it('held rows survive a DB close/reopen (Tower crash/restart recovery)', () => {
    const a = mailbox.enqueue(db, input({ toAgent: 'agent-1', body: 'survive me' }), 1000);
    const delivered = mailbox.enqueue(db, input({ body: 'gone before crash' }), 1100);
    mailbox.markDelivered(db, delivered.id, 1200);

    // Simulate a Tower crash + restart: drop the connection, reopen the file.
    db.close();
    db = new Database(dbPath);

    const held = mailbox.listHeld(db);
    expect(held.map((r) => r.id)).toEqual([a.id]);
    expect(held[0].status).toBe('held');
    // The delivered row is still present (terminal, not lost) but no longer held.
    expect(mailbox.getById(db, delivered.id)?.status).toBe('delivered');
  });

  it('a respawned agent (new terminal_id) still finds its predecessor\'s held mail by agent identity', () => {
    // Rows address the agent, not the PTY: mail enqueued against terminal 'old'
    // is discoverable for the same agent regardless of the current terminal.
    mailbox.enqueue(db, input({ toAgent: 'spir-1313', terminalId: 'old-term', body: 'for the agent' }), 1000);
    const found = mailbox.findHeldForAgent(db, '/ws/a', 'spir-1313');
    expect(found).toHaveLength(1);
    expect(found[0].body).toBe('for the agent');
  });

  // ---------------------------------------------------------------------------
  // findEscalatable / markEscalated (Phase 7 — escalation age)
  // ---------------------------------------------------------------------------

  it('findEscalatable returns only held, not-yet-escalated rows older than the age, oldest first', () => {
    const old1 = mailbox.enqueue(db, input({ body: 'old1' }), 1000);
    const old2 = mailbox.enqueue(db, input({ body: 'old2' }), 2000);
    mailbox.enqueue(db, input({ body: 'young' }), 9000);
    // now=10000, age=5000 → cutoff 5000: old1/old2 (created ≤2000) qualify; young (9000) does not.
    const due = mailbox.findEscalatable(db, 5000, 10000);
    expect(due.map((r) => r.id)).toEqual([old1.id, old2.id]); // created_at ASC
    expect(due.map((r) => r.body)).not.toContain('young');
  });

  it('markEscalated flips a held row once (idempotent); findEscalatable then excludes it', () => {
    const row = mailbox.enqueue(db, input(), 1000);
    expect(mailbox.markEscalated(db, row.id, 10000)).toBe(true);
    expect(mailbox.getById(db, row.id)?.escalated).toBe(1);
    expect(mailbox.markEscalated(db, row.id, 10000)).toBe(false); // already escalated → no-op
    expect(mailbox.findEscalatable(db, 5000, 10000)).toHaveLength(0); // excluded once escalated
  });

  it('markEscalated never touches a terminal (delivered) row', () => {
    const row = mailbox.enqueue(db, input(), 1000);
    mailbox.markDelivered(db, row.id, 2000);
    expect(mailbox.markEscalated(db, row.id, 10000)).toBe(false);
    expect(mailbox.getById(db, row.id)?.escalated).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // heldSummaryForWorkspace (Phase 7 — the overview indicator's data source)
  // ---------------------------------------------------------------------------

  it('heldSummaryForWorkspace totals held rows per agent with an escalation flag; delivered rows excluded', () => {
    mailbox.enqueue(db, input({ toAgent: 'spir-1', body: 'a' }), 1000);
    mailbox.enqueue(db, input({ toAgent: 'spir-1', body: 'b' }), 1100);
    const esc = mailbox.enqueue(db, input({ toAgent: 'spir-2', body: 'c' }), 1200);
    mailbox.markEscalated(db, esc.id, 2000);
    const delivered = mailbox.enqueue(db, input({ toAgent: 'spir-1', body: 'd' }), 1300);
    mailbox.markDelivered(db, delivered.id, 1400);

    const summary = mailbox.heldSummaryForWorkspace(db, '/ws/a');
    expect(summary.total).toBe(3); // 2×spir-1 + 1×spir-2 (delivered excluded)
    expect(summary.escalated).toBe(true); // spir-2's row escalated
    const byAgent = new Map(summary.byAgent.map((a) => [a.toAgent, a]));
    expect(byAgent.get('spir-1')).toMatchObject({ count: 2, escalated: false });
    expect(byAgent.get('spir-2')).toMatchObject({ count: 1, escalated: true });
  });

  it('heldSummaryForWorkspace is workspace-scoped and zeroed when nothing is held', () => {
    mailbox.enqueue(db, input({ workspacePath: '/ws/other', toAgent: 'x' }), 1000);
    expect(mailbox.heldSummaryForWorkspace(db, '/ws/a')).toEqual({ total: 0, escalated: false, byAgent: [] });
  });

  it('heldSummaryForWorkspace excludes a PRE-DUE delayed row (scheduled, not stuck), counting it once due', () => {
    // Spec 1313 round 3: a scheduled (pre-due `not_before`) send must not inflate the
    // attention count/indicator — consistent with findHeldForAgent/findEscalatable/findStarvingAgents.
    mailbox.enqueue(db, input({ toAgent: 'spir-1', body: 'now' }), 1000); // eligible (null not_before)
    mailbox.enqueue(db, input({ toAgent: 'spir-1', body: 'later', notBefore: 100000 }), 1000); // pre-due

    // now=2000 (< due 100000): only the eligible row counts.
    const before = mailbox.heldSummaryForWorkspace(db, '/ws/a', 2000);
    expect(before.total).toBe(1);
    expect(before.byAgent).toEqual([{ toAgent: 'spir-1', count: 1, escalated: false }]);

    // At/after its due time the scheduled row becomes eligible and is counted.
    expect(mailbox.heldSummaryForWorkspace(db, '/ws/a', 100000).total).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Spec 1313 round 3 — durable `--delay`: not_before eligibility + escalation start
  // ---------------------------------------------------------------------------

  it('enqueue persists notBefore (a scheduled delayed send); null for a normal send', () => {
    const delayed = mailbox.enqueue(db, input({ notBefore: 5000 }), 1000);
    expect(delayed.not_before).toBe(5000);
    expect(mailbox.getById(db, delayed.id)?.not_before).toBe(5000);

    const normal = mailbox.enqueue(db, input(), 1000);
    expect(normal.not_before).toBeNull();
  });

  it('findHeldForAgent excludes a PRE-DUE delayed row, then includes it once now ≥ its due time', () => {
    mailbox.enqueue(db, input({ toAgent: 'x', body: 'normal' }), 1000);
    mailbox.enqueue(db, input({ toAgent: 'x', body: 'delayed', notBefore: 5000 }), 1000);

    // At now=2000 the delayed row is not yet due → only the normal row is eligible.
    expect(mailbox.findHeldForAgent(db, '/ws/a', 'x', 2000).map((r) => r.body)).toEqual(['normal']);
    // Exactly at the due time it becomes eligible (not_before <= now).
    expect(mailbox.findHeldForAgent(db, '/ws/a', 'x', 5000).map((r) => r.body).sort()).toEqual(['delayed', 'normal']);
    // Past due, still eligible.
    expect(mailbox.findHeldForAgent(db, '/ws/a', 'x', 9000).map((r) => r.body).sort()).toEqual(['delayed', 'normal']);
  });

  it('findHeldForAgent keeps oldest-first among ELIGIBLE rows — a pre-due row does not jump the queue', () => {
    // A delayed row enqueued FIRST (created_at 1000) but due later must not deliver before a
    // normal row enqueued later (created_at 2000) — eligibility is not_before, order is created_at.
    mailbox.enqueue(db, input({ toAgent: 'x', body: 'delayed-first', notBefore: 8000 }), 1000);
    mailbox.enqueue(db, input({ toAgent: 'x', body: 'normal-second' }), 2000);

    // Before the delayed row is due: only the normal row is eligible.
    expect(mailbox.findHeldForAgent(db, '/ws/a', 'x', 3000).map((r) => r.body)).toEqual(['normal-second']);
    // After it comes due: both eligible, oldest created_at first (the delayed row, created at 1000).
    expect(mailbox.findHeldForAgent(db, '/ws/a', 'x', 8000).map((r) => r.body)).toEqual(['delayed-first', 'normal-second']);
  });

  it('findEscalatable never escalates a PRE-DUE delayed row; a due row escalates from its due time, not enqueue time', () => {
    // A delayed row: created_at 1000, due (not_before) 100000. maxAge 5000.
    const delayed = mailbox.enqueue(db, input({ body: 'delayed', notBefore: 100000 }), 1000);
    // At now=50000 the row is 49s old by created_at but NOT yet due → its escalation clock has
    // not started (effective start = max(created_at, not_before) = 100000, which is in the future).
    expect(mailbox.findEscalatable(db, 5000, 50000)).toEqual([]);
    // At now = due + 6000 (past due by more than maxAge) it becomes escalatable.
    expect(mailbox.findEscalatable(db, 5000, 106000).map((r) => r.id)).toEqual([delayed.id]);
    // Just after due but within maxAge → not yet (deliverable-but-stuck for < the window).
    mailbox.markEscalated(db, delayed.id, 106000); // clear it so the next assertion starts fresh
    const delayed2 = mailbox.enqueue(db, input({ body: 'delayed2', notBefore: 100000 }), 1000);
    expect(mailbox.findEscalatable(db, 5000, 102000).map((r) => r.id)).not.toContain(delayed2.id);
  });

  // ---------------------------------------------------------------------------
  // Spec 1313 round 3 — findStarvingAgents (the starvation-alarm data source)
  // ---------------------------------------------------------------------------

  it('findStarvingAgents aggregates ELIGIBLE non-notice held rows per agent (stuckSince = oldest effective start)', () => {
    mailbox.enqueue(db, input({ toAgent: 'a', body: '1', reason: 'busy' }), 1000);
    mailbox.enqueue(db, input({ toAgent: 'a', body: '2', reason: 'busy' }), 3000);
    mailbox.enqueue(db, input({ toAgent: 'b', body: '3', reason: 'no-profile' }), 2000);

    const starving = mailbox.findStarvingAgents(db, 10000);
    const byAgent = new Map(starving.map((s) => [s.toAgent, s]));
    expect(byAgent.get('a')).toMatchObject({ workspacePath: '/ws/a', count: 2, stuckSince: 1000, reason: 'busy' });
    expect(byAgent.get('b')).toMatchObject({ count: 1, stuckSince: 2000, reason: 'no-profile' });
  });

  it('findStarvingAgents excludes PRE-DUE delayed rows (scheduled, not stuck)', () => {
    mailbox.enqueue(db, input({ toAgent: 'a', body: 'stuck', reason: 'busy' }), 1000);
    mailbox.enqueue(db, input({ toAgent: 'sched-only', body: 'later', notBefore: 100000 }), 1000);

    const starving = mailbox.findStarvingAgents(db, 5000);
    expect(starving.map((s) => s.toAgent)).toEqual(['a']); // sched-only has no eligible row yet
    // Once the delayed row is due, its agent joins the starving set.
    expect(mailbox.findStarvingAgents(db, 100000).map((s) => s.toAgent).sort()).toEqual(['a', 'sched-only']);
  });

  it('findStarvingAgents excludes NOTICE rows — a notice can never itself trigger a notice', () => {
    // A pending owner notice is a held row keyed with the notice prefix, addressed to an architect.
    mailbox.supersede(db, '/ws/a', `${mailbox.NOTICE_SUPERSEDE_PREFIX}spir-1`, input({ toAgent: 'main', body: 'starving!' }), 1000);
    // A genuinely starving builder row.
    mailbox.enqueue(db, input({ toAgent: 'spir-1', body: 'held', reason: 'busy' }), 1000);

    const starving = mailbox.findStarvingAgents(db, 10000);
    expect(starving.map((s) => s.toAgent)).toEqual(['spir-1']); // 'main' (the notice recipient) is NOT reported
  });

  // ---------------------------------------------------------------------------
  // Spec 1313 round 3 — dismissHeldForAgent (take-now B) / dismissHeldWithKey (notice clear)
  // ---------------------------------------------------------------------------

  it('dismissHeldForAgent dismisses every held row for an agent (audit-preserving), scoped to workspace+agent', () => {
    const a1 = mailbox.enqueue(db, input({ toAgent: 'gone', body: '1', reason: 'busy' }), 1000);
    const a2 = mailbox.enqueue(db, input({ toAgent: 'gone', body: '2' }), 1100);
    const other = mailbox.enqueue(db, input({ toAgent: 'stays', body: 'keep' }), 1200);
    const elsewhere = mailbox.enqueue(db, input({ workspacePath: '/ws/other', toAgent: 'gone', body: 'other-ws' }), 1300);

    const dismissed = mailbox.dismissHeldForAgent(db, '/ws/a', 'gone', 2000);
    expect(dismissed).toBe(2);
    expect(mailbox.getById(db, a1.id)?.status).toBe('dismissed');
    expect(mailbox.getById(db, a1.id)?.reason).toBe('busy'); // audit trail preserved
    expect(mailbox.getById(db, a1.id)?.resolved_at).toBe(2000);
    expect(mailbox.getById(db, a2.id)?.status).toBe('dismissed');
    expect(mailbox.getById(db, other.id)?.status).toBe('held'); // other agent untouched
    expect(mailbox.getById(db, elsewhere.id)?.status).toBe('held'); // other workspace untouched
  });

  it('dismissHeldForAgent is a no-op when the agent has no held rows', () => {
    mailbox.markDelivered(db, mailbox.enqueue(db, input({ toAgent: 'gone' }), 1000).id, 1500);
    expect(mailbox.dismissHeldForAgent(db, '/ws/a', 'gone', 2000)).toBe(0);
  });

  it('dismissHeldWithKey clears a pending notice (held row with the supersede key); no-op once delivered', () => {
    const key = `${mailbox.NOTICE_SUPERSEDE_PREFIX}spir-1`;
    const notice = mailbox.supersede(db, '/ws/a', key, input({ toAgent: 'main', body: 'notice' }), 1000);
    expect(mailbox.dismissHeldWithKey(db, '/ws/a', key, 2000)).toBe(1);
    expect(mailbox.getById(db, notice.id)?.status).toBe('dismissed');
    // A second clear (already dismissed) or a clear after delivery is a no-op.
    expect(mailbox.dismissHeldWithKey(db, '/ws/a', key, 3000)).toBe(0);
  });
});
