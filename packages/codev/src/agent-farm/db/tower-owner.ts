/**
 * global.db owner lock (Issue #1629).
 *
 * The port bind in tower-server.ts is a SAME-PORT mutex only: a second Tower on
 * a DIFFERENT port can still open the same global.db. That is exactly how the
 * incident happened — a test Tower on port 14733 exported `AGENT_FARM_DIR`
 * instead of `CODEV_AGENT_FARM_DIR` (#1515), so it resolved to the production
 * `~/.agent-farm` and opened the live `global.db` (port and DB path are set by
 * independent inputs: the port is a CLI arg, the DB comes from AGENT_FARM_DIR).
 * Its startup reconcile then reconnected every live shellper socket (a shellper
 * holds ONE client), stealing them from the real Tower on 4100, and the
 * stale-row sweep deleted the rows.
 *
 * This module makes the second Tower REFUSE to start instead. The owner record
 * is an exclusive LOCK FILE sitting next to the exact global.db being contended
 * (`<db path>.lock`), so it travels with that file: cross-`CODEV_AGENT_FARM_DIR`
 * isolation is untouched (an isolated DB carries its own lock), and two isolated
 * test Towers on different DB files never share a lock. Acquisition is an atomic
 * `O_EXCL` create — the filesystem itself resolves a race between two starters. A
 * second Tower reads the lock at boot, before reconcile; if a live Tower owns the
 * DB it refuses loudly, otherwise it claims. A dead owner self-clears — a crashed
 * Tower's lock has a dead pid, so the legitimate restart just reclaims.
 *
 * The lock is deliberately NOT a table in global.db: ownership is ephemeral
 * process state (a cleanly-stopped Tower leaves nothing behind), so it needs no
 * durable schema, no migration, and it sits naturally alongside the other
 * runtime artifacts in AGENT_FARM_DIR (`tower.log`, `local-key`).
 */

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getGlobalDbPath } from './index.js';

/** The owner record persisted in the lock file next to global.db. */
export interface TowerOwner {
  /** pid of the Tower process that owns this global.db. */
  pid: number;
  /** Port that Tower is listening on (the liveness probe target). */
  port: number;
  /** Machine the owning Tower runs on (diagnostic only). */
  hostname: string;
  /** When ownership was claimed (epoch ms; also the compare-and-set discriminator). */
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

/** The lock file for the active global.db: the DB path plus `.lock`. */
export function defaultLockFile(): string {
  return `${getGlobalDbPath()}.lock`;
}

/** Serialize an owner record to the lock file's on-disk form. */
function serialize(owner: TowerOwner): string {
  return JSON.stringify(owner);
}

/**
 * Read the owner record from the lock file, or null if the lock is absent or its
 * contents are unusable (corrupt / a partial write from a crashed acquire — the
 * caller clears and reclaims those). A genuine IO error other than "not found"
 * (permission, EISDIR) is rethrown so the boot guard fails CLOSED.
 */
export function readTowerOwner(lockFile: string): TowerOwner | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const o = JSON.parse(raw) as Partial<TowerOwner>;
    if (typeof o.pid !== 'number' || typeof o.port !== 'number') return null;
    return {
      pid: o.pid,
      port: o.port,
      hostname: typeof o.hostname === 'string' ? o.hostname : 'unknown',
      startedAt: typeof o.startedAt === 'number' ? o.startedAt : 0,
      dbDir: typeof o.dbDir === 'string' ? o.dbDir : '',
      bindHost: typeof o.bindHost === 'string' ? o.bindHost : '127.0.0.1',
    };
  } catch {
    return null; // unparseable → treat as a corrupt lock the caller can clear
  }
}

/** Overwrite the lock file with `owner` (non-atomic; for takeover seams / tests). */
export function writeTowerOwner(lockFile: string, owner: TowerOwner): void {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, serialize(owner));
}

/**
 * Remove the lock file, but ONLY if it is still ours (pid match). Best-effort: a
 * hard kill (SIGKILL) never reaches this, and the dead-pid liveness check
 * self-clears the stale lock on the next start regardless. Called on graceful
 * shutdown so the lock reflects reality between a clean stop and the next start.
 */
export function releaseTowerOwnerIfMine(lockFile: string, pid: number): void {
  try {
    const cur = readTowerOwner(lockFile);
    if (cur && cur.pid === pid) fs.rmSync(lockFile, { force: true });
  } catch {
    // Lock gone / unreadable — nothing to release.
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
 * Probe `GET /health` on `host`:`port` (unauthenticated per server-utils).
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
 * bind (`0.0.0.0` / `::` / bracketed `[::]` as validateHost emits) accepts
 * loopback, so probe `127.0.0.1`; a specific bridge host is probed directly
 * (probing loopback would falsely read 'gone').
 */
export function resolveProbeHost(bindHost: string | null | undefined): string {
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
 *   (`127.0.0.1:P`) COEXIST on the same port, so `port` alone matching does not
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

/**
 * Bound on the acquire attempts under contention. Each losing attempt means
 * another Tower held or rewrote the lock between our checks; a handful of retries
 * converges in every realistic case, and exhausting them means the lock is
 * churning between many simultaneous starts — where the safe answer is to refuse
 * (fail closed), never to force the lock.
 */
const MAX_CLAIM_ATTEMPTS = 5;

/**
 * Atomically acquire the lock: write the FULL record to a unique temp file, then
 * hard-link it onto the lock path. `link()` is atomic and fails with EEXIST if
 * the path is already taken, and — unlike `writeFile({flag:'wx'})` — the linked
 * file already has its complete content, so a concurrent reader never sees an
 * empty/partial lock it could misclassify as corrupt and delete mid-write. The
 * temp is always cleaned up (the hard link keeps the inode alive at the lock path).
 * Returns whether we won the link.
 */
function tryAcquire(lockFile: string, owner: TowerOwner): boolean {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const tmp = `${lockFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, serialize(owner));
  try {
    fs.linkSync(tmp, lockFile);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* temp already gone */ }
  }
}

/**
 * Remove a stale lock, but ONLY if it still names the holder we probed (a
 * compare-and-set on pid + startedAt). If a contender rewrote it in between, the
 * content differs and we do NOT remove it — we loop and re-evaluate. Returns
 * whether we removed it.
 */
function removeStaleLock(lockFile: string, observed: TowerOwner): boolean {
  const cur = readTowerOwner(lockFile);
  if (!cur || cur.pid !== observed.pid || cur.startedAt !== observed.startedAt) return false;
  try {
    fs.rmSync(lockFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Boot guard: refuse if the DB already has a LIVE owner, otherwise claim
 * ownership by writing the lock file. A decision plus a lock write — the caller
 * decides how to fail loudly (log + exit).
 *
 * Acquisition is atomic against a concurrent second Tower: {@link tryAcquire}
 * writes a full temp file and hard-links it onto the path, so the filesystem
 * resolves a two-starter race (one link wins, the other gets EEXIST) with no
 * empty-file window. A stale lock (dead / absent owner) is cleared with a
 * compare-and-set on its contents and the link retried; the invariant preserved
 * is "never remove a LIVE owner's lock". Under persistent churn the claim refuses
 * rather than forcing the lock.
 */
export async function claimGlobalDbOwnership(opts: {
  /** Lock file path; defaults to the active global.db's `.lock` sibling. */
  lockFile?: string;
  pid: number;
  port: number;
  dbDir: string;
  /** Interface this Tower listens on (default `127.0.0.1`); persisted as the probe target. */
  bindHost?: string;
  deps?: OwnerLivenessDeps;
}): Promise<ClaimResult> {
  const lockFile = opts.lockFile ?? defaultLockFile();
  const { pid, port, dbDir, deps } = opts;
  const bindHost = opts.bindHost ?? '127.0.0.1';
  let lastSeen: TowerOwner | null = null;

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const mine: TowerOwner = { pid, port, hostname: os.hostname(), startedAt: Date.now(), dbDir, bindHost };

    // Atomic acquire: full-content temp + hard link (see tryAcquire).
    if (tryAcquire(lockFile, mine)) return { ok: true };

    // Lock exists — evaluate the current holder.
    const existing = readTowerOwner(lockFile);
    if (!existing) {
      // Corrupt / vanished under us — clear it and retry the atomic acquire.
      try { fs.rmSync(lockFile, { force: true }); } catch { /* already gone */ }
      continue;
    }
    lastSeen = existing;
    if (await ownerIsLive(existing, port, bindHost, deps)) {
      return { ok: false, conflict: existing };
    }
    // Stale — remove ONLY if the lock still names the holder we probed, then loop
    // to re-attempt the atomic acquire (the link is the serialization point). A
    // failed CAS means a contender rewrote it: loop and re-evaluate, never force.
    removeStaleLock(lockFile, existing);
  }

  // Persistent contention: the lock keeps changing under us. Refuse rather than
  // risk forcing over a live claimant that appeared mid-flight. Name a real
  // contender we observed, never ourselves (Claude CMAP).
  const conflict: TowerOwner = readTowerOwner(lockFile) ?? lastSeen ?? {
    pid: -1, port, hostname: 'unknown (lock contended)', startedAt: Date.now(), dbDir, bindHost,
  };
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
