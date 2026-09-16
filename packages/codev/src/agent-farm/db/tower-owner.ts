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
              resolve((JSON.parse(body) as { error?: string }).error === 'STARTING_UP' ? 'tower' : 'unreachable');
            } catch {
              resolve('unreachable');
            }
            return;
          }
          // Any other 5xx: a degraded-but-live server may answer 500 rather than a
          // clean /health. Treat as inconclusive (fail closed), never as absent.
          if (res.statusCode && res.statusCode >= 500) {
            resolve('unreachable');
            return;
          }
          // A non-5xx, non-Tower HTTP response — a process answered, but it is not
          // a Tower serving /health (a squatter on a recycled port).
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
  // Wildcard binds (IPv4 0.0.0.0, IPv6 :: / [::] as validateHost brackets it)
  // accept loopback, so probe loopback. A specific host is probed directly.
  if (!bindHost || bindHost === '0.0.0.0' || bindHost === '::' || bindHost === '[::]') return '127.0.0.1';
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
 * - same port AND same bind interface as us: our own `server.listen` succeeded
 *   on that exact interface:port, and an identical bind is exclusive, so no other
 *   process holds it — any prior owner recorded there is gone. Claim. The bind
 *   interface must match: a wildcard bind (`0.0.0.0:P`) and a loopback bind
 *   (`127.0.0.1:P`) COEXIST on the same port, so `port` alone succeeding does not
 *   prove a differently-bound owner is gone — that path falls through to the probe.
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
  myBindHost: string,
  deps: OwnerLivenessDeps = {},
): Promise<boolean> {
  const isAlive = deps.isAlive ?? pidAlive;
  const probe = deps.probe ?? probeTowerHealth;
  if (owner.port === myPort && owner.bindHost === myBindHost) return false;
  if (!isAlive(owner.pid)) return false;
  return (await probe(resolveProbeHost(owner.bindHost), owner.port)) !== 'gone';
}

/** Outcome of {@link claimGlobalDbOwnership}. */
export type ClaimResult =
  | { ok: true }
  | { ok: false; conflict: TowerOwner };

/** True if the message names a SQLite uniqueness/constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string }).code ?? '';
  return code.startsWith('SQLITE_CONSTRAINT') || /UNIQUE|constraint/i.test((err as Error).message);
}

/**
 * Take over a stale owner row with a compare-and-set: the UPDATE only lands if
 * the row STILL matches the `observed` owner we liveness-checked. If a concurrent
 * contender claimed in between, its row differs and 0 rows change — we lost the
 * race and must re-evaluate. Returns whether we won.
 */
function takeOverStaleOwner(db: Database.Database, observed: TowerOwner, next: TowerOwner): boolean {
  const changed = db
    .prepare(
      `UPDATE tower_owner SET pid=@pid, port=@port, hostname=@hostname, started_at=@startedAt,
         db_dir=@dbDir, bind_host=@bindHost
       WHERE id = 1 AND pid = @observedPid AND started_at = @observedStartedAt`,
    )
    .run({ ...next, observedPid: observed.pid, observedStartedAt: observed.startedAt }).changes;
  return changed === 1;
}

/**
 * Boot guard: refuse if the DB already has a LIVE owner, otherwise claim
 * ownership by writing this process's record. A decision plus a record write —
 * the caller decides how to fail loudly (log + exit).
 *
 * Acquisition is atomic against a concurrent second Tower (Codex CMAP): the write
 * is never a blind upsert. An empty table is claimed with a plain INSERT (the
 * singleton PK makes a second inserter lose and re-evaluate), and a stale owner
 * is taken over with a compare-and-set guarded on the row we actually probed. The
 * invariant preserved is "never overwrite a LIVE owner"; two contenders racing
 * for a genuinely unowned DB is resolved to exactly one winner, and the loser
 * refuses behind the winner's (booting, hence live) record.
 */
/**
 * Bound on the read → liveness → write attempts under contention. Each losing
 * attempt means another Tower wrote the row between our read and our conditional
 * write; a handful of retries converges in every realistic case, and exhausting
 * them means the row is churning between many simultaneous starts — where the
 * safe answer is to refuse (fail closed), never to blind-overwrite.
 */
const MAX_CLAIM_ATTEMPTS = 5;

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

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    // Re-mint the record each attempt so started_at reflects when we actually won.
    const mine: TowerOwner = { pid, port, hostname: os.hostname(), startedAt: Date.now(), dbDir, bindHost };
    const existing = readTowerOwner(db);

    if (!existing) {
      // Empty table: claim with a plain INSERT. If a concurrent contender inserted
      // first, the singleton PK makes ours throw — loop to re-evaluate its row.
      try {
        db.prepare(
          `INSERT INTO tower_owner (id, pid, port, hostname, started_at, db_dir, bind_host)
           VALUES (1, @pid, @port, @hostname, @startedAt, @dbDir, @bindHost)`,
        ).run(mine);
        return { ok: true };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        continue; // someone inserted first — re-read and decide
      }
    }

    if (await ownerIsLive(existing, port, bindHost, deps)) {
      return { ok: false, conflict: existing };
    }
    // Stale owner — take over only if the row is STILL the one we probed. A failed
    // CAS means a contender changed it between our read and write: loop and
    // re-evaluate (never blind-overwrite — the new writer may be a live owner).
    if (takeOverStaleOwner(db, existing, mine)) return { ok: true };
  }

  // Persistent contention: the row keeps changing under us. Refuse rather than
  // risk overwriting a live claimant that appeared mid-flight.
  const final = readTowerOwner(db);
  const conflict: TowerOwner = final ?? { pid, port, hostname: os.hostname(), startedAt: Date.now(), dbDir, bindHost };
  return { ok: false, conflict };
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
