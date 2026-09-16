/**
 * global.db owner lock (Issue #1629).
 *
 * The port bind in tower-server.ts is a SAME-PORT mutex only: a second Tower on
 * a DIFFERENT port can still open the same global.db. That is exactly how the
 * incident happened — a test Tower on port 14733 exported `AGENT_FARM_DIR`
 * instead of `CODEV_AGENT_FARM_DIR` (#1515), so it resolved to the production
 * `~/.agent-farm` and opened the live `global.db`. Its startup reconcile then
 * reconnected every live shellper socket (a shellper holds ONE client), stealing
 * them from the real Tower on 4100, and the stale-row sweep deleted the rows.
 *
 * This module makes the second Tower REFUSE to start instead. The owner record
 * is a singleton row IN global.db, so it travels with the exact file being
 * contended: cross-`CODEV_AGENT_FARM_DIR` isolation is untouched (an isolated DB
 * carries no production owner row), and the check needs no side files. A second
 * Tower reads the row at boot, before reconcile; if a live Tower owns the DB it
 * refuses loudly, otherwise it claims ownership. A dead owner self-clears — a
 * crashed Tower's row has a dead pid, so the legitimate restart just reclaims.
 */

import http from 'node:http';
import os from 'node:os';
import type Database from 'better-sqlite3';

/** The singleton owner record persisted in global.db's `tower_owner` table. */
export interface TowerOwner {
  /** pid of the Tower process that owns this global.db. */
  pid: number;
  /** Port that Tower is listening on (the liveness probe target). */
  port: number;
  /** Host the owning Tower runs on (diagnostic only). */
  hostname: string;
  /** When ownership was claimed (epoch ms). */
  startedAt: number;
  /** Resolved AGENT_FARM_DIR the owner opened — surfaced in the conflict error. */
  dbDir: string;
}

/** Read the singleton owner record, or null if none exists / the read fails. */
export function readTowerOwner(db: Database.Database): TowerOwner | null {
  try {
    const row = db
      .prepare('SELECT pid, port, hostname, started_at AS startedAt, db_dir AS dbDir FROM tower_owner WHERE id = 1')
      .get() as TowerOwner | undefined;
    return row ?? null;
  } catch {
    // Table may not exist yet (pre-migration) — treat as unowned.
    return null;
  }
}

/** Upsert the singleton owner record to `owner`. */
export function writeTowerOwner(db: Database.Database, owner: TowerOwner): void {
  db.prepare(
    `INSERT INTO tower_owner (id, pid, port, hostname, started_at, db_dir)
     VALUES (1, @pid, @port, @hostname, @startedAt, @dbDir)
     ON CONFLICT(id) DO UPDATE SET
       pid = excluded.pid,
       port = excluded.port,
       hostname = excluded.hostname,
       started_at = excluded.started_at,
       db_dir = excluded.db_dir`,
  ).run(owner);
}

/**
 * Clear the owner record, but ONLY if it is still ours (pid match). Best-effort:
 * a hard kill (SIGKILL) never reaches this, and the dead-pid liveness check
 * self-clears the stale row on the next start regardless. Called on graceful
 * shutdown so the record reflects reality between a clean stop and the next
 * start.
 */
export function releaseTowerOwnerIfMine(db: Database.Database, pid: number): void {
  try {
    db.prepare('DELETE FROM tower_owner WHERE id = 1 AND pid = ?').run(pid);
  } catch {
    // Table gone / DB closing — nothing to release.
  }
}

/** Whether a pid is a live process (SIGnal 0 probe, same as processExists). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * True iff a genuine Tower answers `GET /health` on 127.0.0.1:`port`. `/health`
 * is unauthenticated (server-utils allowlist), so no shared key is needed. The
 * response must parse as JSON and report `status: 'healthy'` — an unrelated
 * process that happens to hold the port and answer with garbage does NOT count,
 * so a recycled pid whose port was reused never masquerades as a live owner.
 */
export function towerHealthResponds(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(false);
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // A tower /health payload is small; cap the read so a chatty non-tower
          // process on the port can't stream unboundedly.
          if (body.length > 64_000) {
            res.destroy();
            resolve(false);
          }
        });
        res.on('end', () => {
          try {
            resolve((JSON.parse(body) as { status?: string }).status === 'healthy');
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** Injectable liveness seams — real implementations by default; fakes in tests. */
export interface OwnerLivenessDeps {
  isAlive?: (pid: number) => boolean;
  probe?: (port: number) => Promise<boolean>;
}

/**
 * Decide whether the recorded owner is a live Tower this process must yield to.
 *
 * - `owner.port === myPort`: we already hold this port (our own `server.listen`
 *   succeeded before this runs), so no other process is serving it — any prior
 *   owner recorded on it is gone. Claim.
 * - dead owner pid: stale (a crashed Tower / a clean stop that outran the
 *   release). Claim — this is the self-clearing legitimate restart.
 * - live pid + a Tower answering `/health` on the owner's port: a real Tower
 *   owns this DB. Refuse.
 */
export async function ownerIsLive(
  owner: TowerOwner,
  myPort: number,
  deps: OwnerLivenessDeps = {},
): Promise<boolean> {
  const isAlive = deps.isAlive ?? pidAlive;
  const probe = deps.probe ?? towerHealthResponds;
  if (owner.port === myPort) return false;
  if (!isAlive(owner.pid)) return false;
  return probe(owner.port);
}

/** Outcome of {@link claimGlobalDbOwnership}. */
export type ClaimResult =
  | { ok: true }
  | { ok: false; conflict: TowerOwner };

/**
 * Boot guard: refuse if the DB already has a LIVE owner, otherwise claim
 * ownership by writing this process's record. A pure decision plus a record
 * write — the caller decides how to fail loudly (log + exit).
 */
export async function claimGlobalDbOwnership(opts: {
  db: Database.Database;
  pid: number;
  port: number;
  dbDir: string;
  deps?: OwnerLivenessDeps;
}): Promise<ClaimResult> {
  const { db, pid, port, dbDir, deps } = opts;
  const existing = readTowerOwner(db);
  if (existing && (await ownerIsLive(existing, port, deps))) {
    return { ok: false, conflict: existing };
  }
  writeTowerOwner(db, { pid, port, hostname: os.hostname(), startedAt: Date.now(), dbDir });
  return { ok: true };
}

/**
 * The loud, teaching error for a refused start. Names the live owner (pid/port/
 * host) and the shared DB, and — because the misconfiguration that triggered the
 * incident was a mistyped env var — spells out the `AGENT_FARM_DIR` vs
 * `CODEV_AGENT_FARM_DIR` fix.
 */
export function ownershipConflictMessage(conflict: TowerOwner, dbDir: string): string {
  return [
    `Refusing to start: this global.db is already owned by a live Tower.`,
    `  owner pid ${conflict.pid} on port ${conflict.port} (host ${conflict.hostname})`,
    `  shared database dir: ${dbDir}`,
    `A second Tower opening a live global.db hijacks and deletes its shellper sessions (Issue #1629).`,
    `If you meant to run an isolated test Tower, set CODEV_AGENT_FARM_DIR (NOT AGENT_FARM_DIR) to a throwaway directory (#1515).`,
    `Otherwise stop the existing Tower first ('afx tower stop'), or investigate pid ${conflict.pid} if you believe it is stale.`,
  ].join('\n');
}
