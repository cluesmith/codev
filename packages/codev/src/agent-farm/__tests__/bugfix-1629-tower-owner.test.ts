/**
 * Issue #1629 — global.db owner lock (exclusive lock file).
 *
 * A second Tower that opens a live global.db (the #1515 incident: a test Tower
 * whose AGENT_FARM_DIR typo pointed it at production) used to hijack every live
 * shellper and delete the rows. The owner lock makes that second Tower refuse to
 * start. The lock is an exclusive file next to global.db (`<db>.lock`), acquired
 * with an atomic O_EXCL create. These tests pin the decision matrix and the
 * tri-state /health liveness probe, prove the guard fails CLOSED (an inconclusive
 * probe against a live pid is a live owner, never a free DB), prove a dead /
 * stale / corrupt lock self-clears so the legitimate restart is never blocked,
 * cover the bridge-mode non-loopback bind, prove the O_EXCL acquire is atomic
 * against a concurrent second Tower, and pin the boot ordering so the claim can
 * never run after reconcile.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  claimGlobalDbOwnership,
  defaultLockFile,
  ownerIsLive,
  ownershipConflictMessage,
  probeTowerHealth,
  readTowerOwner,
  releaseTowerOwnerIfMine,
  resolveProbeHost,
  writeTowerOwner,
  type HealthProbe,
  type TowerOwner,
} from '../db/tower-owner.js';

const tmpPaths: string[] = [];
const servers: http.Server[] = [];

/** A unique temp lock-file path (not created until a test writes it). */
function tmpLock(): string {
  const p = path.join(os.tmpdir(), `af-1629-${crypto.randomUUID()}.lock`);
  tmpPaths.push(p);
  return p;
}

/** Build an owner record, defaulting fields a given test does not care about. */
function owner(partial: Partial<TowerOwner> & Pick<TowerOwner, 'pid' | 'port'>): TowerOwner {
  return { hostname: 'prod', startedAt: 1, dbDir: '/home/u/.agent-farm', bindHost: '127.0.0.1', ...partial };
}

/** Start a throwaway HTTP server on an ephemeral port with a fixed reply. */
async function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

const towerHealth = (): http.RequestListener => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'healthy', ready: true, uptime: 1 }));
};
const startingUp = (): http.RequestListener => (_req, res) => {
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'STARTING_UP', message: 'Tower is starting up.' }));
};
const garbageHealth = (): http.RequestListener => (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('not a tower');
};
const degraded = (): http.RequestListener => (_req, res) => {
  res.writeHead(500, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'boom' }));
};

afterEach(async () => {
  for (const p of tmpPaths.splice(0)) { try { fs.rmSync(p, { force: true, recursive: true }); } catch { /* gone */ } }
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const alive = () => true;
const dead = () => false;
const probeReturns = (v: HealthProbe) => async () => v;

describe('defaultLockFile — sits beside the active global.db', () => {
  it('is the db path plus .lock', () => {
    expect(defaultLockFile()).toMatch(/\.lock$/);
  });
});

describe('resolveProbeHost — wildcard binds probe loopback, specific binds probe themselves', () => {
  it('maps IPv4/IPv6 wildcard and empty binds to loopback', () => {
    expect(resolveProbeHost('0.0.0.0')).toBe('127.0.0.1');
    expect(resolveProbeHost('::')).toBe('127.0.0.1');
    expect(resolveProbeHost('[::]')).toBe('127.0.0.1'); // validateHost brackets IPv6
    expect(resolveProbeHost('')).toBe('127.0.0.1');
    expect(resolveProbeHost(null)).toBe('127.0.0.1');
  });
  it('keeps a specific bridge host', () => {
    expect(resolveProbeHost('10.0.0.5')).toBe('10.0.0.5');
  });
});

describe('probeTowerHealth — classify the owner port', () => {
  it("is 'tower' for a real Tower payload", async () => {
    expect(await probeTowerHealth('127.0.0.1', await startServer(towerHealth()))).toBe('tower');
  });
  it("is 'tower' for a 503 STARTING_UP (a live Tower mid-boot)", async () => {
    expect(await probeTowerHealth('127.0.0.1', await startServer(startingUp()))).toBe('tower');
  });
  it("is 'gone' for a 200 that is not a Tower payload (recycled-port process)", async () => {
    expect(await probeTowerHealth('127.0.0.1', await startServer(garbageHealth()))).toBe('gone');
  });
  it("is 'gone' when nothing is listening (connection refused)", async () => {
    const port = await startServer(towerHealth());
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    expect(await probeTowerHealth('127.0.0.1', port, 500)).toBe('gone');
  });
  it("is 'unreachable' for a degraded 5xx (a live-but-broken owner, fail closed)", async () => {
    expect(await probeTowerHealth('127.0.0.1', await startServer(degraded()))).toBe('unreachable');
  });
});

describe('claimGlobalDbOwnership — refuse a live owner, claim otherwise', () => {
  it('claims an unowned DB and writes the lock', async () => {
    const lockFile = tmpLock();
    const res = await claimGlobalDbOwnership({ lockFile, pid: 4242, port: 4100, dbDir: '/home/u/.agent-farm' });
    expect(res.ok).toBe(true);
    expect(readTowerOwner(lockFile)).toMatchObject({ pid: 4242, port: 4100, dbDir: '/home/u/.agent-farm', bindHost: '127.0.0.1' });
  });

  it('persists a non-loopback bind host', async () => {
    const lockFile = tmpLock();
    await claimGlobalDbOwnership({ lockFile, pid: 1, port: 4100, dbDir: '/d', bindHost: '10.0.0.5' });
    expect(readTowerOwner(lockFile)?.bindHost).toBe('10.0.0.5');
  });

  it('REFUSES when a live Tower already owns the DB (the incident)', async () => {
    const lockFile = tmpLock();
    const ownerPort = await startServer(towerHealth());
    writeTowerOwner(lockFile, owner({ pid: 999, port: ownerPort, startedAt: Date.now() }));
    const res = await claimGlobalDbOwnership({
      lockFile, pid: 1000, port: ownerPort + 1, dbDir: '/home/u/.agent-farm', deps: { isAlive: alive },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.conflict.pid).toBe(999);
    expect(readTowerOwner(lockFile)?.pid).toBe(999); // untouched
  });

  it('REFUSES (fails closed) when the owner pid is alive but /health is inconclusive', async () => {
    const lockFile = tmpLock();
    writeTowerOwner(lockFile, owner({ pid: 999, port: 4100 }));
    const res = await claimGlobalDbOwnership({
      lockFile, pid: 1000, port: 5000, dbDir: '/d', deps: { isAlive: alive, probe: probeReturns('unreachable') },
    });
    expect(res.ok).toBe(false);
    expect(readTowerOwner(lockFile)?.pid).toBe(999);
  });

  it('self-clears a dead owner (the legitimate restart) and claims', async () => {
    const lockFile = tmpLock();
    writeTowerOwner(lockFile, owner({ pid: 777, port: 4100 }));
    const res = await claimGlobalDbOwnership({ lockFile, pid: 888, port: 5000, dbDir: '/d', deps: { isAlive: dead } });
    expect(res.ok).toBe(true);
    expect(readTowerOwner(lockFile)?.pid).toBe(888);
  });

  it('treats a dead owner as stale even when a non-Tower process now answers its port', async () => {
    const lockFile = tmpLock();
    const ownerPort = await startServer(garbageHealth());
    writeTowerOwner(lockFile, owner({ pid: 777, port: ownerPort }));
    const res = await claimGlobalDbOwnership({ lockFile, pid: 888, port: ownerPort + 1, dbDir: '/d', deps: { isAlive: dead } });
    expect(res.ok).toBe(true);
    expect(readTowerOwner(lockFile)?.pid).toBe(888);
  });

  it('treats a non-Tower process on the owner port as stale (recycled pid)', async () => {
    const lockFile = tmpLock();
    const ownerPort = await startServer(garbageHealth());
    writeTowerOwner(lockFile, owner({ pid: 777, port: ownerPort }));
    const res = await claimGlobalDbOwnership({ lockFile, pid: 888, port: ownerPort + 1, dbDir: '/d', deps: { isAlive: alive } });
    expect(res.ok).toBe(true);
  });

  it('REFUSES a bridge owner on the same port but a different interface', async () => {
    // A live Tower bound to 0.0.0.0:P coexists with our 127.0.0.1:P bind, so the
    // same-address shortcut must NOT fire. The probe (loopback resolves the wildcard)
    // finds the live owner and we refuse. Regression for the CMAP-flagged hijack.
    const lockFile = tmpLock();
    const ownerPort = await startServer(towerHealth());
    writeTowerOwner(lockFile, owner({ pid: 999, port: ownerPort, bindHost: '0.0.0.0' }));
    const res = await claimGlobalDbOwnership({
      lockFile, pid: 1000, port: ownerPort, dbDir: '/d', bindHost: '127.0.0.1', deps: { isAlive: alive },
    });
    expect(res.ok).toBe(false);
    expect(readTowerOwner(lockFile)?.pid).toBe(999);
  });

  it('claims when the recorded owner port AND bind interface equal ours', async () => {
    const lockFile = tmpLock();
    writeTowerOwner(lockFile, owner({ pid: 777, port: 4100, bindHost: '127.0.0.1' }));
    // We bound this exact interface:port ourselves — an identical bind is exclusive,
    // so any prior owner on it is gone; no /health probe is needed and we claim.
    const res = await claimGlobalDbOwnership({
      lockFile, pid: 888, port: 4100, dbDir: '/d', bindHost: '127.0.0.1',
      deps: { isAlive: alive, probe: async () => { throw new Error('probe must not run'); } },
    });
    expect(res.ok).toBe(true);
    expect(readTowerOwner(lockFile)?.pid).toBe(888);
  });

  it('clears a corrupt lock and claims', async () => {
    const lockFile = tmpLock();
    fs.writeFileSync(lockFile, 'not json at all');
    const res = await claimGlobalDbOwnership({ lockFile, pid: 555, port: 4100, dbDir: '/d' });
    expect(res.ok).toBe(true);
    expect(readTowerOwner(lockFile)?.pid).toBe(555);
  });
});

describe('ownerIsLive — decision seam', () => {
  const rec = owner({ pid: 5, port: 4100, bindHost: '127.0.0.1' });

  it('false when the owner port AND bind interface are ours', async () => {
    expect(await ownerIsLive(rec, 4100, '127.0.0.1', { isAlive: alive, probe: probeReturns('tower') })).toBe(false);
  });
  it('does NOT shortcut when the port matches but the bind interface differs', async () => {
    const wildcard = owner({ pid: 5, port: 4100, bindHost: '0.0.0.0' });
    expect(await ownerIsLive(wildcard, 4100, '127.0.0.1', { isAlive: alive, probe: probeReturns('tower') })).toBe(true);
  });
  it('false when the owner pid is dead', async () => {
    expect(await ownerIsLive(rec, 5000, '127.0.0.1', { isAlive: dead, probe: probeReturns('tower') })).toBe(false);
  });
  it('true when pid alive and a Tower answers /health', async () => {
    expect(await ownerIsLive(rec, 5000, '127.0.0.1', { isAlive: alive, probe: probeReturns('tower') })).toBe(true);
  });
  it('true when pid alive and the probe is inconclusive (fail closed)', async () => {
    expect(await ownerIsLive(rec, 5000, '127.0.0.1', { isAlive: alive, probe: probeReturns('unreachable') })).toBe(true);
  });
  it('false when pid alive but the port is gone (refused / non-Tower)', async () => {
    expect(await ownerIsLive(rec, 5000, '127.0.0.1', { isAlive: alive, probe: probeReturns('gone') })).toBe(false);
  });
  it('probes the resolved bind host', async () => {
    const seen: string[] = [];
    const spy = async (host: string): Promise<HealthProbe> => { seen.push(host); return 'gone'; };
    await ownerIsLive(owner({ pid: 5, port: 4100, bindHost: '10.0.0.5' }), 5000, '127.0.0.1', { isAlive: alive, probe: spy });
    await ownerIsLive(owner({ pid: 5, port: 4100, bindHost: '0.0.0.0' }), 5000, '127.0.0.1', { isAlive: alive, probe: spy });
    expect(seen).toEqual(['10.0.0.5', '127.0.0.1']);
  });
});

describe('ownershipConflictMessage — loud and teaching', () => {
  it('names the owner and the AGENT_FARM_DIR vs CODEV_AGENT_FARM_DIR fix', () => {
    const msg = ownershipConflictMessage(owner({ pid: 999, port: 4100 }), '/home/u/.agent-farm');
    expect(msg).toContain('999');
    expect(msg).toContain('4100');
    expect(msg).toContain('/home/u/.agent-farm');
    expect(msg).toContain('CODEV_AGENT_FARM_DIR');
    expect(msg).toContain('Issue #1629');
  });
});

describe('readTowerOwner / releaseTowerOwnerIfMine', () => {
  it('returns null for an absent lock and for a corrupt lock', () => {
    const lockFile = tmpLock();
    expect(readTowerOwner(lockFile)).toBeNull(); // absent
    fs.writeFileSync(lockFile, '{ not valid');
    expect(readTowerOwner(lockFile)).toBeNull(); // corrupt
  });
  it('rethrows a genuine IO error (fails closed)', () => {
    const dir = tmpLock();
    fs.mkdirSync(dir); // a directory at the lock path → readFileSync throws EISDIR
    expect(() => readTowerOwner(dir)).toThrow();
  });
  it('release clears the lock only when the pid matches', () => {
    const lockFile = tmpLock();
    writeTowerOwner(lockFile, owner({ pid: 100, port: 4100 }));
    releaseTowerOwnerIfMine(lockFile, 200); // not ours — no-op
    expect(readTowerOwner(lockFile)?.pid).toBe(100);
    releaseTowerOwnerIfMine(lockFile, 100); // ours — cleared
    expect(readTowerOwner(lockFile)).toBeNull();
  });
});

describe('claimGlobalDbOwnership — atomic against a concurrent second Tower', () => {
  it('the acquire is exclusive and leaves no temp residue (atomic link, no empty window)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-1629-dir-'));
    tmpPaths.push(dir);
    const lockFile = path.join(dir, 'global.db.lock');
    const res = await claimGlobalDbOwnership({ lockFile, pid: 111, port: 4100, dbDir: '/d' });
    expect(res.ok).toBe(true);
    // The held path rejects a second create...
    expect(() => fs.writeFileSync(lockFile, '{}', { flag: 'wx' })).toThrow();
    // ...and the acquire cleaned up its temp: only the lock file remains.
    expect(fs.readdirSync(dir)).toEqual(['global.db.lock']);
  });

  it('a second contender refuses behind the first live claim (no double-claim)', async () => {
    const lockFile = tmpLock();
    const resA = await claimGlobalDbOwnership({ lockFile, pid: 111, port: 4100, dbDir: '/d' });
    const resB = await claimGlobalDbOwnership({
      lockFile, pid: 222, port: 4101, dbDir: '/d', deps: { isAlive: alive, probe: probeReturns('tower') },
    });
    expect(resA.ok).toBe(true);
    expect(resB.ok).toBe(false);
    expect(readTowerOwner(lockFile)?.pid).toBe(111); // A never displaced
  });

  it('takes over a stale lock (dead owner) via unlink + O_EXCL re-create', async () => {
    const lockFile = tmpLock();
    writeTowerOwner(lockFile, owner({ pid: 111, port: 4100, startedAt: 5 }));
    const res = await claimGlobalDbOwnership({ lockFile, pid: 222, port: 4101, dbDir: '/d', deps: { isAlive: dead } });
    expect(res.ok).toBe(true);
    expect(readTowerOwner(lockFile)?.pid).toBe(222);
  });

  it('fails closed under persistent contention instead of forcing the lock', async () => {
    // Simulate a contender rewriting the lock on every attempt: the probe (awaited
    // inside ownerIsLive) rewrites it to a NEW holder, so removeStaleLock — which
    // only unlinks a lock whose content still matches the holder we probed — never
    // fires. After exhausting retries the claim must REFUSE, never force the lock.
    const lockFile = tmpLock();
    writeTowerOwner(lockFile, owner({ pid: 1, port: 4100, startedAt: 1 }));
    let n = 1;
    const churn = async (): Promise<HealthProbe> => {
      n += 1;
      writeTowerOwner(lockFile, owner({ pid: 100 + n, port: 4100, startedAt: n }));
      return 'gone';
    };
    const res = await claimGlobalDbOwnership({
      lockFile, pid: 999, port: 5000, dbDir: '/d', deps: { isAlive: alive, probe: churn },
    });
    expect(res.ok).toBe(false);
    expect(readTowerOwner(lockFile)?.pid).not.toBe(999); // we never forced our own lock
  });
});

describe('boot ordering — the guard runs before anything touches shared state', () => {
  // The guard is only a backstop if it runs FIRST. A future reorder of
  // bootSequence() would silently restore the incident, and the wiring is
  // impractical to drive in isolation, so pin the source order (same technique as
  // send-architect-identity.test.ts). claimGlobalDbOwnership must precede every
  // step that touched production state in the incident.
  const fullSrc = fs.readFileSync(path.resolve(import.meta.dirname, '../servers/tower-server.ts'), 'utf-8');
  const src = fullSrc.slice(fullSrc.indexOf('async function bootSequence'));
  const claimAt = src.indexOf('claimGlobalDbOwnership({'); // the CALL site, not the import

  it('claims ownership before reconcileTerminalSessions', () => {
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(src.indexOf('reconcileTerminalSessions('));
  });
  it('claims ownership before runBootConsolidation', () => {
    expect(claimAt).toBeLessThan(src.indexOf('runBootConsolidation('));
  });
  it('claims ownership before killOrphanedShellpers', () => {
    expect(claimAt).toBeLessThan(src.indexOf('killOrphanedShellpers('));
  });
  it('exits the process when ownership is refused', () => {
    const guardBlock = src.slice(claimAt, claimAt + 800);
    expect(guardBlock).toContain('ownershipConflictMessage');
    expect(guardBlock).toContain('process.exit(1)');
  });
});
