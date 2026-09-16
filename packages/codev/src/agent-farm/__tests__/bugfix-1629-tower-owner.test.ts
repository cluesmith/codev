/**
 * Issue #1629 — global.db owner lock.
 *
 * A second Tower that opens a live global.db (the #1515 incident: a test Tower
 * whose AGENT_FARM_DIR typo pointed it at production) used to hijack every live
 * shellper and delete the rows. The owner lock makes that second Tower refuse to
 * start. These tests pin the decision matrix and the /health-shaped liveness
 * probe, and prove a dead / stale owner self-clears so the legitimate single
 * Tower restart is never blocked.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import Database from 'better-sqlite3';
import { GLOBAL_SCHEMA } from '../db/schema.js';
import {
  claimGlobalDbOwnership,
  ownerIsLive,
  ownershipConflictMessage,
  readTowerOwner,
  releaseTowerOwnerIfMine,
  towerHealthResponds,
  writeTowerOwner,
  type TowerOwner,
} from '../db/tower-owner.js';

/** A fresh in-memory global.db carrying the production schema (incl. tower_owner). */
function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(GLOBAL_SCHEMA);
  return db;
}

const servers: http.Server[] = [];

/** Start a throwaway HTTP server on an ephemeral port with a fixed /health reply. */
async function startServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  return addr.port;
}

/** Answers /health exactly like a real Tower. */
function towerHealth(): http.RequestListener {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'healthy', ready: true, uptime: 1 }));
  };
}

/** Answers with 200 but not a Tower payload (an unrelated process on the port). */
function garbageHealth(): http.RequestListener {
  return (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not a tower');
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

const alive = () => true;
const dead = () => false;

describe('towerHealthResponds — only a Tower-shaped /health counts', () => {
  it('is true for a real Tower payload', async () => {
    const port = await startServer(towerHealth());
    expect(await towerHealthResponds(port)).toBe(true);
  });

  it('is false for a 200 that is not a Tower payload (recycled-port process)', async () => {
    const port = await startServer(garbageHealth());
    expect(await towerHealthResponds(port)).toBe(false);
  });

  it('is false when nothing is listening on the port', async () => {
    // An ephemeral port we immediately free — nothing answers.
    const port = await startServer(towerHealth());
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    expect(await towerHealthResponds(port, 300)).toBe(false);
  });
});

describe('claimGlobalDbOwnership — refuse a live owner, claim otherwise', () => {
  it('claims an unowned DB and persists our record', async () => {
    const db = freshDb();
    const res = await claimGlobalDbOwnership({ db, pid: 4242, port: 4100, dbDir: '/home/u/.agent-farm' });
    expect(res.ok).toBe(true);
    const owner = readTowerOwner(db);
    expect(owner).toMatchObject({ pid: 4242, port: 4100, dbDir: '/home/u/.agent-farm' });
  });

  it('REFUSES when a live Tower already owns the DB (the incident)', async () => {
    const db = freshDb();
    const ownerPort = await startServer(towerHealth()); // the real Tower on 4100
    writeTowerOwner(db, {
      pid: 999, port: ownerPort, hostname: 'prod', startedAt: Date.now(), dbDir: '/home/u/.agent-farm',
    });
    // The second Tower runs on a DIFFERENT port and mistakenly opened this DB.
    const res = await claimGlobalDbOwnership({
      db, pid: 1000, port: ownerPort + 1, dbDir: '/home/u/.agent-farm',
      deps: { isAlive: alive },
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.conflict.pid).toBe(999);
    // The record is untouched — the refused Tower must NOT overwrite the live owner.
    expect(readTowerOwner(db)?.pid).toBe(999);
  });

  it('self-clears a dead owner (the legitimate restart) and claims', async () => {
    const db = freshDb();
    writeTowerOwner(db, {
      pid: 777, port: 4100, hostname: 'prod', startedAt: 1, dbDir: '/home/u/.agent-farm',
    });
    const res = await claimGlobalDbOwnership({
      db, pid: 888, port: 5000, dbDir: '/home/u/.agent-farm',
      deps: { isAlive: dead },
    });
    expect(res.ok).toBe(true);
    expect(readTowerOwner(db)?.pid).toBe(888); // reclaimed by us
  });

  it('treats a dead owner as stale even when a non-Tower process now answers its port', async () => {
    // Architect's explicit case: old owner pid is dead, but something ELSE now
    // listens on owner.port and answers /health with garbage. Still stale → claim.
    const db = freshDb();
    const ownerPort = await startServer(garbageHealth());
    writeTowerOwner(db, {
      pid: 777, port: ownerPort, hostname: 'prod', startedAt: 1, dbDir: '/home/u/.agent-farm',
    });
    const res = await claimGlobalDbOwnership({
      db, pid: 888, port: ownerPort + 1, dbDir: '/home/u/.agent-farm',
      deps: { isAlive: dead },
    });
    expect(res.ok).toBe(true);
    expect(readTowerOwner(db)?.pid).toBe(888);
  });

  it('treats a live-but-non-Tower process on the owner port as stale (recycled pid)', async () => {
    // Owner pid happens to be alive (recycled to an unrelated process) and the
    // recorded port is held by a non-Tower service. The Tower-shaped /health
    // check rejects it, so we claim rather than deadlock behind a phantom owner.
    const db = freshDb();
    const ownerPort = await startServer(garbageHealth());
    writeTowerOwner(db, {
      pid: 777, port: ownerPort, hostname: 'prod', startedAt: 1, dbDir: '/home/u/.agent-farm',
    });
    const res = await claimGlobalDbOwnership({
      db, pid: 888, port: ownerPort + 1, dbDir: '/home/u/.agent-farm',
      deps: { isAlive: alive },
    });
    expect(res.ok).toBe(true);
  });

  it('claims when the recorded owner port equals ours (we already hold the port)', async () => {
    const db = freshDb();
    writeTowerOwner(db, {
      pid: 777, port: 4100, hostname: 'prod', startedAt: 1, dbDir: '/home/u/.agent-farm',
    });
    // isAlive would say true, but we bound this port ourselves — any prior owner
    // on it is gone, so no /health probe is needed and we claim.
    const res = await claimGlobalDbOwnership({
      db, pid: 888, port: 4100, dbDir: '/home/u/.agent-farm',
      deps: { isAlive: alive, probe: async () => { throw new Error('probe must not run'); } },
    });
    expect(res.ok).toBe(true);
    expect(readTowerOwner(db)?.pid).toBe(888);
  });
});

describe('ownerIsLive — decision seam', () => {
  const owner: TowerOwner = { pid: 5, port: 4100, hostname: 'h', startedAt: 1, dbDir: '/d' };

  it('false when the owner port is ours', async () => {
    expect(await ownerIsLive(owner, 4100, { isAlive: alive, probe: async () => true })).toBe(false);
  });
  it('false when the owner pid is dead', async () => {
    expect(await ownerIsLive(owner, 5000, { isAlive: dead, probe: async () => true })).toBe(false);
  });
  it('true when pid alive and a Tower answers /health', async () => {
    expect(await ownerIsLive(owner, 5000, { isAlive: alive, probe: async () => true })).toBe(true);
  });
  it('false when pid alive but /health is not Tower-shaped', async () => {
    expect(await ownerIsLive(owner, 5000, { isAlive: alive, probe: async () => false })).toBe(false);
  });
});

describe('ownershipConflictMessage — loud and teaching', () => {
  it('names the owner and the AGENT_FARM_DIR vs CODEV_AGENT_FARM_DIR fix', () => {
    const msg = ownershipConflictMessage(
      { pid: 999, port: 4100, hostname: 'prod', startedAt: 1, dbDir: '/home/u/.agent-farm' },
      '/home/u/.agent-farm',
    );
    expect(msg).toContain('999');
    expect(msg).toContain('4100');
    expect(msg).toContain('/home/u/.agent-farm');
    expect(msg).toContain('CODEV_AGENT_FARM_DIR');
    expect(msg).toContain('Issue #1629');
  });
});

describe('releaseTowerOwnerIfMine — pid-scoped', () => {
  it('clears the record only when the pid matches', () => {
    const db = freshDb();
    writeTowerOwner(db, { pid: 100, port: 4100, hostname: 'h', startedAt: 1, dbDir: '/d' });

    releaseTowerOwnerIfMine(db, 200); // not ours — no-op
    expect(readTowerOwner(db)?.pid).toBe(100);

    releaseTowerOwnerIfMine(db, 100); // ours — cleared
    expect(readTowerOwner(db)).toBeNull();
  });
});
