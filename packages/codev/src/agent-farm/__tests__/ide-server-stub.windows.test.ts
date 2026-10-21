/**
 * Spec 1658 Phase 9, native Windows only (the on-demand `windows.yml` targeted
 * job runs it; it skips everywhere else). The IDE server lifecycle against a
 * stub server behind a plain `.cmd` shim, no fakes:
 *
 * - `spawnIdeServer` starts the shim through the shim resolver (cmd.exe, then
 *   node), and the server receives its native-path arguments intact.
 * - The forward serves `/ide/?folder=C:\...` with the folder unaltered.
 * - `stopIdeServer` leaves no process behind: not the cmd.exe root, not the
 *   server, not the server's own child.
 *
 * Discovery without `--server-path` and the version floor arrive with #1789
 * and are tested once it merges.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_DIR = vi.hoisted(() => `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/codev-1658-p9-${process.pid}-${Date.now()}`);

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: TMP_DIR };
});

import { spawnIdeServer, stopIdeServer } from '../servers/ide-server.js';
import { forwardIdeHttp } from '../servers/ide-forward.js';
import { getIdeConnectionTokenPath, getIdeRecordPath, readIdeRecord } from '../lib/ide-record.js';

const onWindows = process.platform === 'win32';
const SHIM = path.join(__dirname, 'fixtures', 'ide', 'codev-ide-server.cmd');
const AGENT_FARM = path.resolve(TMP_DIR);
const STATE_FILE = path.join(AGENT_FARM, 'stub-state.json');

const log = (level: string, message: string): void => {
  console.log(`[${level}] ${message}`);
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(read: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return read();
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      let port = 0;
      if (addr && typeof addr !== 'string') port = addr.port;
      probe.close(() => resolve(port));
    });
  });
}

function get(port: number, urlPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface StubState {
  pid: number;
  childPid: number;
  argv: string[];
}

describe.runIf(onWindows)('Phase 9: IDE server lifecycle against a .cmd stub on a real Windows host', () => {
  let tower: http.Server;
  let towerPort: number;

  beforeAll(async () => {
    fs.mkdirSync(AGENT_FARM, { recursive: true });
    process.env.STUB_IDE_STATE_FILE = STATE_FILE;
    tower = http.createServer((req, res) => {
      forwardIdeHttp(req, res, log);
    });
    towerPort = await new Promise<number>((resolve) => {
      tower.listen(0, '127.0.0.1', () => {
        const addr = tower.address();
        if (addr && typeof addr !== 'string') resolve(addr.port);
      });
    });
  });

  afterAll(async () => {
    delete process.env.STUB_IDE_STATE_FILE;
    await new Promise<void>((resolve) => tower.close(() => resolve()));
    fs.rmSync(AGENT_FARM, { recursive: true, force: true });
  });

  it('spawns, forwards a native ?folder path, and stops with nothing left running', async () => {
    const port = await freePort();
    const record = await spawnIdeServer({ serverPath: SHIM, port }, log);
    expect(record.port).toBe(port);

    const state = await waitFor<StubState>(() => {
      if (!fs.existsSync(STATE_FILE)) return null;
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as StubState;
    }, 10_000);
    expect(state).not.toBeNull();
    const stub = state as StubState;
    console.log(`STUB-TREE root=${record.pid} server=${stub.pid} child=${stub.childPid}`);

    // The native token path reached the server unaltered, and Tower's files
    // live under the (temp) agent-farm directory.
    const tokenIndex = stub.argv.indexOf('--connection-token-file');
    expect(stub.argv[tokenIndex + 1]).toBe(getIdeConnectionTokenPath());
    expect(getIdeConnectionTokenPath().startsWith(AGENT_FARM)).toBe(true);
    expect(getIdeRecordPath().startsWith(AGENT_FARM)).toBe(true);
    const profile = fs.realpathSync.native(os.homedir()).toLowerCase();
    expect(fs.realpathSync.native(AGENT_FARM).toLowerCase().startsWith(profile)).toBe(true);

    const folderUrl = `/ide/?folder=${encodeURIComponent('C:\\Users\\dev\\My Repo')}`;
    const res = await get(towerPort, folderUrl);
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { url: string }).url).toBe(folderUrl);

    const stopped = await stopIdeServer(log);
    expect(stopped).toEqual({ stopped: true, port });
    expect(readIdeRecord()).toBeNull();

    const lingering = await waitFor(() => {
      const alive = [record.pid, stub.pid, stub.childPid].filter(isAlive);
      if (alive.length === 0) return [];
      return null;
    }, 5_000);
    expect(lingering).toEqual([]);
  }, 60_000);
});
