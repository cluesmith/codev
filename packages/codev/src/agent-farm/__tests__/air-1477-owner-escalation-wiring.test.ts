/**
 * Owner-resolution WIRING for the starvation alarm (Issue #1477, refs Spec 1313 round 3).
 *
 * `escalateHeldToOwner` is the glue between the drainer's `noticeOverdue` pass and the live
 * registry: it decides WHO hears that a builder's mail is stuck, and enqueues the notice. The
 * resolver underneath (`resolveAgentInRegistry`) and the drainer→port contract are both covered
 * elsewhere; the invocation layer between them was not — `send-delivery.test.ts` only ever stubs
 * `ports.escalateHeldToOwner`, so nothing exercised the real binding.
 *
 * These tests drive it through its production seam — the exported `makeDeliveryPorts`, which is
 * deliberately safe to call before Tower is up — against a seeded global.db registry and the real
 * `state.js` / `tower-messages.js` / `db/mailbox.js` code. Only the DB singleton is substituted
 * (an in-memory GLOBAL_SCHEMA database), so the architect-skip guard, the spawning-architect →
 * `main` → first-registered fallback chain, and the supersede-keyed coalescing are all exercised
 * as they run in production.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import type { ArchitectState, Builder } from '../types.js';

let db: Database.Database | null = null;

// The single shared global.db (Issue #1118): getDb() and getGlobalDb() both return it, so
// state.ts (registry reads/writes) and mailbox-wiring.ts (notice enqueue) see the same rows.
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
const { makeDeliveryPorts, formatOwnerNoticeBody } = await import('../servers/mailbox-wiring.js');
const { getMailboxDrainer } = await import('../servers/mailbox-wiring.js');
const { listHeld, getById, NOTICE_SUPERSEDE_PREFIX } = await import('../db/mailbox.js');
const mailbox = await import('../db/mailbox.js');
import type { HeldOwnerNoticeInfo } from '../servers/mailbox-delivery.js';

/** A real directory, so `normalizeWorkspacePath`'s realpathSync resolves on both sides. */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'air-1477-escalate-')));
const WS = root;

afterAll(() => {
  db?.close();
  db = null;
  rmSync(root, { recursive: true, force: true });
});

function architect(name: string): ArchitectState {
  return { name, cmd: 'claude', startedAt: new Date().toISOString() };
}

/** Register a builder whose worktree places it in WS (upsertBuilder derives the workspace). */
function registerBuilder(id: string, spawnedByArchitect?: string): Builder {
  const worktree = join(WS, '.builders', id);
  mkdirSync(worktree, { recursive: true });
  const builder: Builder = {
    id,
    name: id,
    status: 'implementing',
    phase: 'implement',
    worktree,
    branch: `builder/${id}`,
    type: 'spec',
    spawnedByArchitect,
  };
  upsertBuilder(builder);
  return builder;
}

const logs: Array<{ level: string; message: string }> = [];
const ports = () => makeDeliveryPorts((level, message) => logs.push({ level, message }));

function info(overrides: Partial<HeldOwnerNoticeInfo> = {}): HeldOwnerNoticeInfo {
  return {
    workspacePath: WS,
    toAgent: 'air-1477',
    reason: 'busy',
    detail: 'no-region-end',
    ageMs: 7 * 60_000,
    heldCount: 3,
    streak: 41,
    ...overrides,
  };
}

/** The still-held notice rows about `toAgent` (what the owner would actually receive). */
function notices(toAgent: string) {
  return listHeld(getGlobalDb(), WS).filter((r) => r.supersede_key === `${NOTICE_SUPERSEDE_PREFIX}${toAgent}`);
}

describe('Issue #1477 — escalateHeldToOwner owner-resolution wiring', () => {
  beforeEach(() => {
    if (db) db.close();
    db = null;
    getGlobalDb(); // recreate a clean schema for this test
    logs.length = 0;
  });

  it('never raises a notice about a starving ARCHITECT — not even to a different architect', () => {
    setArchitectByName(WS, 'main', architect('main'));
    setArchitectByName(WS, 'zeta', architect('zeta'));

    // The starving agent IS an architect. Without the skip, `zeta` would resolve an owner
    // (`main`, a DIFFERENT agent, so the self-notify guard would not catch it) and the alarm
    // would become mail about mail. `afx status` covers the starving-architect case instead.
    expect(ports().escalateHeldToOwner!(info({ toAgent: 'zeta' }))).toBe(false);
    // The degenerate single-architect case is silent too. (NB: it is stopped by this same
    // architect-skip guard, not by the later `owner.agent === info.toAgent` one — under the real
    // resolver that second guard is unreachable, since resolving to an architect requires it to be
    // registered, which the skip already caught. No test here claims to cover it.)
    expect(ports().escalateHeldToOwner!(info({ toAgent: 'main' }))).toBe(false);
    expect(listHeld(getGlobalDb(), WS)).toHaveLength(0);
  });

  it('routes the notice to the starving builder\'s SPAWNING architect (affinity beats main)', () => {
    setArchitectByName(WS, 'main', architect('main'));
    setArchitectByName(WS, 'alpha', architect('alpha'));
    registerBuilder('air-1477', 'alpha');

    const payload = info();
    expect(ports().escalateHeldToOwner!(payload)).toBe(true);

    const [notice] = notices('air-1477');
    expect(notice).toBeDefined();
    expect(notice.to_agent).toBe('alpha');
    expect(notice.from_agent).toBe('af-mailbox');
    expect(notice.status).toBe('held'); // gate-delivered like any other mail, never forced
    // The row carries the tested operator-facing body, and the PTY bytes wrap it.
    expect(notice.body).toBe(formatOwnerNoticeBody(payload));
    expect(notice.formatted_message).toContain(notice.body);
    expect(logs.some((l) => l.level === 'WARN' && l.message.includes('STARVATION notice → alpha'))).toBe(true);
  });

  it('falls back to `main` when the spawning architect is no longer registered', () => {
    setArchitectByName(WS, 'main', architect('main'));
    setArchitectByName(WS, 'zeta', architect('zeta'));
    registerBuilder('air-1477', 'ghost'); // spawner has since been removed

    expect(ports().escalateHeldToOwner!(info())).toBe(true);
    expect(notices('air-1477')[0].to_agent).toBe('main');
  });

  it('falls back to the workspace\'s first architect (getArchitects\' id order) when there is no `main`', () => {
    // Registered zeta-then-alpha on purpose: `resolveRegistryArchitect` takes `architects[0]`
    // from `getArchitects`, which is `ORDER BY id` — LEXICOGRAPHIC, not insertion order.
    //
    // This asserts what ships, and what ships is not quite what the surrounding prose promises:
    // the doc comments say "first registered", and both `loadState`
    // (`ORDER BY (id != 'main'), started_at`) and the LIVE resolver (`entry.architects.values()`,
    // registration order) implement it that way. Only this REGISTRY fallback sorts by id, so an
    // offline hold can name a different architect than a live send would. That divergence is a
    // production question, not something a test-only change should quietly fix — the test pins
    // current behaviour so the discrepancy is visible rather than silent.
    setArchitectByName(WS, 'zeta', architect('zeta'));
    setArchitectByName(WS, 'alpha', architect('alpha'));
    registerBuilder('air-1477'); // legacy row: no spawning architect recorded

    expect(ports().escalateHeldToOwner!(info())).toBe(true);
    expect(notices('air-1477')[0].to_agent).toBe('alpha');
  });

  it('no-ops (and logs why) when no architect is registered, leaving the alarm to retry', () => {
    registerBuilder('air-1477', 'alpha');

    // Returning false is load-bearing: the drainer arms its once-per-episode guard only on
    // `true`, so a no-op here retries next tick rather than silencing the episode.
    expect(ports().escalateHeldToOwner!(info())).toBe(false);
    expect(listHeld(getGlobalDb(), WS)).toHaveLength(0);
    expect(logs.some((l) => l.message.includes('no architect to notify'))).toBe(true);
  });

  it('coalesces repeat escalations onto ONE pending notice via the supersede key', () => {
    setArchitectByName(WS, 'main', architect('main'));
    registerBuilder('air-1477', 'main');
    registerBuilder('air-1500', 'main');

    expect(ports().escalateHeldToOwner!(info({ heldCount: 3 }))).toBe(true);
    const stale = notices('air-1477')[0].id;
    expect(ports().escalateHeldToOwner!(info({ heldCount: 9 }))).toBe(true);
    // A different starving agent gets its OWN key, so it is not collapsed into the first.
    expect(ports().escalateHeldToOwner!(info({ toAgent: 'air-1500' }))).toBe(true);

    const pending = notices('air-1477');
    expect(pending).toHaveLength(1);
    expect(pending[0].id).not.toBe(stale);
    expect(pending[0].body).toContain('9 messages held'); // the freshest metadata wins
    expect(notices('air-1500')).toHaveLength(1);

    // Audit-preserving: the replaced notice is `superseded`, not deleted, and the architect's
    // pending set stays at exactly one notice per starving agent.
    expect(getById(getGlobalDb(), stale)?.status).toBe('superseded');
    expect(listHeld(getGlobalDb(), WS)).toHaveLength(2);
  });

  it('schedules a prompt gated drain for the RESOLVED owner, so the notice is not left to the backstop', () => {
    setArchitectByName(WS, 'main', architect('main'));
    setArchitectByName(WS, 'alpha', architect('alpha'));
    registerBuilder('air-1477', 'alpha');
    // Spy on the module's drainer singleton — the same instance `escalateHeldToOwner` reaches via
    // `ensureDrainer()`. Without this the glue is invisible: the drainer is never started in a unit
    // test, so `scheduleDrain` no-ops and deleting the call would leave every other test green.
    const scheduleDrain = vi.spyOn(getMailboxDrainer(), 'scheduleDrain').mockResolvedValue();

    expect(ports().escalateHeldToOwner!(info())).toBe(true);

    // The drain targets the OWNER (who must read the notice), never the starving agent.
    expect(scheduleDrain).toHaveBeenCalledWith(WS, 'alpha');
    scheduleDrain.mockRestore();
  });

  it('clearHeldOwnerNotice dismisses the pending notice once the starvation is over', () => {
    setArchitectByName(WS, 'main', architect('main'));
    registerBuilder('air-1477', 'main');
    const port = ports();

    port.escalateHeldToOwner!(info());
    const noticeId = notices('air-1477')[0].id;

    // A notice about a DIFFERENT starving agent must survive: the clear is keyed to one agent.
    registerBuilder('air-1500', 'main');
    port.escalateHeldToOwner!(info({ toAgent: 'air-1500' }));
    const otherNoticeId = notices('air-1500')[0].id;

    // Ordinary mail to the same architect must survive too.
    const ordinary = mailbox.enqueue(getGlobalDb(), {
      workspacePath: WS,
      toAgent: 'main',
      body: 'unrelated',
      formattedMessage: 'unrelated',
    });

    port.clearHeldOwnerNotice!(WS, 'air-1477');
    expect(getById(getGlobalDb(), noticeId)?.status).toBe('dismissed');
    expect(getById(getGlobalDb(), otherNoticeId)?.status).toBe('held');
    expect(getById(getGlobalDb(), ordinary.id)?.status).toBe('held');
  });

  it('resolves the owner within the STARVING agent\'s workspace, not some other one', () => {
    // Issue #1118: one global.db serves every workspace, and the same builder id can live in two.
    // A notice must be raised against `info.workspacePath`'s registry and enqueued there.
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'air-1477-escalate-other-')));
    try {
      setArchitectByName(WS, 'alpha', architect('alpha'));
      setArchitectByName(other, 'beta', architect('beta'));
      registerBuilder('air-1477', 'alpha');
      // A same-id builder in the OTHER workspace, spawned by that workspace's architect.
      mkdirSync(join(other, '.builders', 'air-1477'), { recursive: true });
      upsertBuilder({
        id: 'air-1477',
        name: 'air-1477',
        status: 'implementing',
        phase: 'implement',
        worktree: join(other, '.builders', 'air-1477'),
        branch: 'builder/air-1477',
        type: 'spec',
        spawnedByArchitect: 'beta',
      });

      expect(ports().escalateHeldToOwner!(info())).toBe(true);

      const [notice] = notices('air-1477');
      expect(notice.to_agent).toBe('alpha'); // WS's architect, never `other`'s beta
      expect(notice.workspace_path).toBe(WS);
      expect(listHeld(getGlobalDb(), other)).toHaveLength(0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
