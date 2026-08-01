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
});
