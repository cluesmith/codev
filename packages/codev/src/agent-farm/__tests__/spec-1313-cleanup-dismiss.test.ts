/**
 * `afx cleanup` dismisses a removed agent's held mail (Spec 1313 round 3, take-now B).
 *
 * The terminal-row prune only removes delivered/superseded/dismissed rows — never held ones —
 * so a cleaned-up agent's orphaned held mail would otherwise pin its `heldCount`/escalated (and
 * the starvation alarm) forever. `cleanupBuilder` calls
 * `dismissHeldForAgent(getGlobalDb(), normalizeWorkspacePath(config.workspaceRoot), builder.id)`.
 *
 * These tests exercise that exact seam against a real GLOBAL_SCHEMA DB and the REAL
 * `normalizeWorkspacePath` (a real temp dir, so `realpathSync` resolves), proving the fix clears
 * the very surfaces the maintainer cited — `heldSummaryForWorkspace` and `findStarvingAgents` —
 * and that the workspace-path round-trip (store side ↔ cleanup side) matches. The full
 * `cleanupBuilder` (git worktree + forge + state removal) is out of scope here by the same
 * re-implementation convention `cleanup-preserve-status.test.ts` uses.
 *
 * Issue #1477: the INVOCATION half — that `afx cleanup` actually reaches this seam, with the
 * normalized workspace path and the canonical builder id — is covered by
 * `air-1477-cleanup-dismiss-invocation.test.ts`, which drives the real exported `cleanup()`.
 * Keep the split in mind before extending either file: this one owns the seam's semantics, that
 * one owns the wiring that calls it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import * as mailbox from '../db/mailbox.js';
import { normalizeWorkspacePath } from '../utils/workspace-path.js';

describe('afx cleanup dismisses held mail (Spec 1313 round 3, take-now B)', () => {
  let db: Database.Database;
  let workspaceRoot: string;
  let ws: string; // normalized workspace path — what the mailbox stores under

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GLOBAL_SCHEMA);
    workspaceRoot = fs.mkdtempSync(join(tmpdir(), 'cleanup-dismiss-'));
    ws = normalizeWorkspacePath(workspaceRoot); // the store side normalizes identically
  });

  afterEach(() => {
    db.close();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  const enqueue = (toAgent: string, overrides: Partial<mailbox.EnqueueInput> = {}, now = 1000) =>
    mailbox.enqueue(db, { workspacePath: ws, toAgent, body: 'hi', formattedMessage: 'M', ...overrides }, now);

  it('dismisses the removed agent\'s held rows so it stops pinning heldCount + starvation, leaving others intact', async () => {
    const g1 = enqueue('spir-gone', { reason: 'busy' }, 1000);
    const g2 = enqueue('spir-gone', { reason: 'busy' }, 1100);
    enqueue('spir-stays', { reason: 'no-profile' }, 1200);

    // Before cleanup: the removed agent contributes to the workspace held total + starvation set.
    expect(mailbox.heldSummaryForWorkspace(db, ws).total).toBe(3);
    expect(mailbox.findStarvingAgents(db, 9999).map((s) => s.toAgent).sort()).toEqual(['spir-gone', 'spir-stays']);

    // The exact seam cleanupBuilder runs (workspace normalized the same way the store keyed it).
    const dismissed = mailbox.dismissHeldForAgent(db, normalizeWorkspacePath(workspaceRoot), 'spir-gone', 2000);
    expect(dismissed).toBe(2);

    // Audit-preserving soft transition (not a delete).
    expect(mailbox.getById(db, g1.id)?.status).toBe('dismissed');
    expect(mailbox.getById(db, g1.id)?.reason).toBe('busy');
    expect(mailbox.getById(db, g2.id)?.status).toBe('dismissed');

    // After cleanup: the removed agent no longer pins heldCount or the starvation alarm.
    const summary = mailbox.heldSummaryForWorkspace(db, ws);
    expect(summary.total).toBe(1); // only spir-stays remains
    expect(summary.byAgent.map((a) => a.toAgent)).toEqual(['spir-stays']);
    expect(mailbox.findStarvingAgents(db, 9999).map((s) => s.toAgent)).toEqual(['spir-stays']);
  });

  it('is a harmless no-op when the removed agent had no held mail', async () => {
    enqueue('spir-stays', {}, 1000);
    expect(mailbox.dismissHeldForAgent(db, normalizeWorkspacePath(workspaceRoot), 'spir-never-had-mail', 2000)).toBe(0);
    expect(mailbox.heldSummaryForWorkspace(db, ws).total).toBe(1); // untouched
  });
});
