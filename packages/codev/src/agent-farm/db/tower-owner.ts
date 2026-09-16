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
  /** Machine the owning Tower runs on (diagnostic only). */
  hostname: string;
  /** When ownership was claimed (epoch ms). */
  startedAt: number;
  /** Resolved AGENT_FARM_DIR the owner opened — surfaced in the conflict error. */
  dbDir: string;
  /**
   * Interface the owner listens on — the liveness probe's target host. Default
   * `127.0.0.1`; bridge mode may bind a specific non-loopback host, and probing
   * loopback would then miss it (a false "gone" → hijack). `0.0.0.0`/`::` are
   * resolved back to loopback for the probe.
   */
  bindHost: string;
}

/** Read the singleton owner record, or null if none exists. */
export function readTowerOwner(db: Database.Database): TowerOwner | null {
  try {
    const row = db
      .prepare('SELECT pid, port, hostname, started_at AS startedAt, db_dir AS dbDir, bind_host AS bindHost FROM tower_owner WHERE id = 1')
      .get() as TowerOwner | undefined;
    return row ?? null;
  } catch (err) {
    // Only "no such table" (a pre-migration / bare DB) is a legitimate "unowned"
    // read — and even that is unreachable in production, since ensureGlobalDatabase
    // always creates tower_owner before getGlobalDb() returns. Any OTHER error
    // (SQLITE_BUSY, corruption) must NOT be swallowed: this is the one guard that
    // stops data loss, so it fails CLOSED — the caller's boot catch exits.
    if ((err as Error).message.includes('no such table')) return null;
    throw err;
  }
}

/** Upsert the singleton owner record to `owner`. */
export function writeTowerOwner(db: Database.Database, owner: TowerOwner): void {
  db.prepare(
    `INSERT INTO tower_owner (id, pid, port, hostname, started_at, db_dir, bind_host)
     VALUES (1, @pid, @port, @hostname, @startedAt, @dbDir, @bindHost)
     ON CONFLICT(id) DO UPDATE SET
       pid = excluded.pid,
       port = excluded.port,
       hostname = excluded.hostname,
       started_at = excluded.started_at,
       db_dir = excluded.db_dir,
       bind_host = excluded.bind_host`,
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
 * The three distinguishable states of the owner's `/health` port.
 * - `tower`: a live Tower answered — a healthy 200, OR a 503 `STARTING_UP` while
 *   its readiness gate holds requests mid-boot. Both mean a live Tower owns it.
 * - `gone`: proof the owner is NOT here — the connection was refused (port free),
 *   or a non-Tower process answered (a squatter on a recycled port/pid). Claim.
 * - `unreachable`: inconclusive — a timeout or transport error. A live Tower
 *   under load (its `/health` shells out to `ps -A`) or mid-boot can miss the
 *   budget, so this must NOT be read as "gone". The caller treats it as live.
 */
export type HealthProbe = 'tower' | 'gone' | 'unreachable';

/**
 * Probe `GET /health` on 127.0.0.1:`port` (unauthenticated per server-utils).
 *
 * The budget is generous by default: `/health` calls `getInstances()` and shells
 * out to `ps -A` (a 5s timeout of its own), so under the incident's load — 60+
 * shellpers, a busy event loop — a tight budget would time out and be misread as
 * "no Tower here", failing OPEN on the one guard that prevents data loss. Only
 * paid on the conflict path (a live pid on a different port), so it costs nothing
 * on the common restart.
 */
export function probeTowerHealth(host: string, port: number, timeoutMs = 6000): Promise<HealthProbe> {
  return new Promise<HealthProbe>((resolve) => {
    const req = http.request(
      { hostname: host, port, path: '/health', method: 'GET', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // A tower /health payload is small; cap the read so a chatty non-tower
          // process on the port can't stream unboundedly.
          if (body.length > 64_000) {
            res.destroy();
            resolve('gone');
          }
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve((JSON.parse(body) as { status?: string }).status === 'healthy' ? 'tower' : 'gone');
            } catch {
              resolve('gone');
            }
            return;
          }
          if (res.statusCode === 503) {
            // The readiness gate answers 503 {"error":"STARTING_UP"} while a live
            // Tower boots — a live owner, not an absent one.
            try {
              resolve((JSON.parse(body) as { error?: string }).error === 'STARTING_UP' ? 'tower' : 'gone');
            } catch {
              resolve('gone');
            }
            return;
          }
          // Some other HTTP status — a process answered, but it is not a Tower.
          resolve('gone');
        });
      },
    );
    req.on('error', (err) => {
      // ECONNREFUSED = nothing is listening on the port, so the recorded owner is
      // not serving it (a live Tower always holds its port) → gone. Any other
      // transport error is inconclusive → unreachable (fail closed).
      resolve((err as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'gone' : 'unreachable');
    });
    req.on('timeout', () => {
      req.destroy();
      resolve('unreachable');
    });
    req.end();
  });
}

/**
 * Resolve the host to probe from the owner's recorded bind interface. A wildcard
 * bind (`0.0.0.0` / `::`) accepts loopback, so probe `127.0.0.1`; a specific
 * bridge host is probed directly (probing loopback would falsely read 'gone').
 */
export function resolveProbeHost(bindHost: string | null | undefined): string {
  if (!bindHost || bindHost === '0.0.0.0' || bindHost === '::') return '127.0.0.1';
  return bindHost;
}

/** Injectable liveness seams — real implementations by default; fakes in tests. */
export interface OwnerLivenessDeps {
  isAlive?: (pid: number) => boolean;
  probe?: (host: string, port: number) => Promise<HealthProbe>;
}

/**
 * Decide whether the recorded owner is a live Tower this process must yield to.
 *
 * - `owner.port === myPort`: we already hold this port (our own `server.listen`
 *   succeeded before this runs), so no other process is serving it — any prior
 *   owner recorded on it is gone. Claim.
 * - dead owner pid: stale (a crashed Tower / a clean stop that outran the
 *   release). Claim — this is the self-clearing legitimate restart.
 * - live pid: probe the owner's port. Only a `gone` result (connection refused,
 *   or a non-Tower response) proves the owner is absent → claim. A `tower`
 *   response, OR an `unreachable` inconclusive probe against a still-live pid, is
 *   treated as a live owner → refuse. This fails CLOSED: a loaded or mid-boot
 *   Tower whose `/health` misses the budget is never mistaken for a free DB.
 */
export async function ownerIsLive(
  owner: TowerOwner,
  myPort: number,
  deps: OwnerLivenessDeps = {},
): Promise<boolean> {
  const isAlive = deps.isAlive ?? pidAlive;
  const probe = deps.probe ?? probeTowerHealth;
  if (owner.port === myPort) return false;
  if (!isAlive(owner.pid)) return false;
  return (await probe(resolveProbeHost(owner.bindHost), owner.port)) !== 'gone';
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
  /** Interface this Tower listens on (default `127.0.0.1`); persisted as the probe target. */
  bindHost?: string;
  deps?: OwnerLivenessDeps;
}): Promise<ClaimResult> {
  const { db, pid, port, dbDir, deps } = opts;
  const bindHost = opts.bindHost ?? '127.0.0.1';
  const existing = readTowerOwner(db);
  if (existing && (await ownerIsLive(existing, port, deps))) {
    return { ok: false, conflict: existing };
  }
  writeTowerOwner(db, { pid, port, hostname: os.hostname(), startedAt: Date.now(), dbDir, bindHost });
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
