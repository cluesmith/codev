/**
 * Spec 1658 Phase 9, native Windows only (the on-demand `windows.yml` targeted
 * job runs it; it skips everywhere else). The IDE server lifecycle against a
 * stub server behind `.cmd` shims, no fakes:
 *
 * - Discovery without `--server-path` finds `codev-ide-server.cmd` on `PATH`
 *   (`PATHEXT`).
 * - `spawnIdeServer` passes the version floor and starts the shim through the
 *   shim resolver, for both shapes: an npm-style shim (node runs the entry
 *   directly, as for a real npm install) and a plain `.cmd` (cmd.exe, then
 *   node). The server receives its native-path arguments intact, with the
 *   agent-farm directory deliberately past MAX_PATH.
 * - A below-floor server is refused, names its version and the floor, and
 *   leaves nothing running and no record.
 * - The sidebar install hands the server native `--install-extension` and
 *   `--extensions-dir` paths past MAX_PATH, unaltered.
 * - The forward serves `/ide/?folder=C:\...` with the folder unaltered.
 * - `stopIdeServer` leaves no process behind: not the cmd.exe root, not the
 *   server, not the server's own child.
 * - A server that never listens is refused after the readiness wait with its
 *   whole tree killed and no record (nothing would be left to stop it).
 * - Everything Tower writes is under the agent-farm directory, and the real
 *   (unmocked) agent-farm directory is in the user profile.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIRS = vi.hoisted(() => {
  const root = `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/codev-1658-p9-${process.pid}-${Date.now()}`;
  return { root, agentFarm: `${root}/${'segment-past-max-path-0123456/'.repeat(8)}agent-farm` };
});

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: DIRS.agentFarm };
});

import { spawnIdeServer, stopIdeServer } from '../servers/ide-server.js';
import { forwardIdeHttp } from '../servers/ide-forward.js';
import { getIdeConnectionTokenPath, getIdeRecordPath, readIdeRecord } from '../lib/ide-record.js';
import { IdeServerVersionError } from '../lib/ide-version.js';
import { ensureSidebarInstalled, getIdeExtensionsDir, locateEmbeddedSidebar, readInstalledExtensionVersion } from '../lib/ide-extensions.js';
import { resolveIdeServerPath } from '../commands/ide.js';

const onWindows = process.platform === 'win32';
const FIXTURES = path.join(__dirname, 'fixtures', 'ide');
const SHIMS = [
  { shape: 'npm-style shim', file: 'codev-ide-server.cmd', rootIsServer: true },
  { shape: 'plain .cmd', file: 'codev-ide-server-plain.cmd', rootIsServer: false },
];
const ROOT = path.resolve(DIRS.root);
const AGENT_FARM = path.resolve(DIRS.agentFarm);
const STATE_FILE = path.join(ROOT, 'stub-state.json');
const INSTALL_LOG = path.join(ROOT, 'install-log.jsonl');
const SIDEBAR_ID = 'cluesmith.codev-vscode';

// The stub "installs" whatever these name. The spawn path installs the
// package's embedded sidebar when the build produced one, so they follow it;
// the long-path install test points them at its own manifest.
const EMBEDDED = locateEmbeddedSidebar();
const STUB_ENV = {
  STUB_IDE_STATE_FILE: STATE_FILE,
  STUB_IDE_INSTALL_LOG: INSTALL_LOG,
  STUB_IDE_EXTENSION_ID: EMBEDDED?.id ?? SIDEBAR_ID,
  STUB_IDE_EXTENSION_VERSION: EMBEDDED?.version ?? '9.9.9',
};

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

/**
 * The agent-farm directory production resolves: the real constants module,
 * re-evaluated without the vitest harness's `CODEV_AGENT_FARM_DIR` sandbox
 * override (#1597), which nothing in production sets.
 */
async function productionAgentFarmDir(): Promise<string> {
  const saved = process.env.CODEV_AGENT_FARM_DIR;
  delete process.env.CODEV_AGENT_FARM_DIR;
  try {
    vi.resetModules();
    const actual = await vi.importActual<typeof import('@cluesmith/codev-core/constants')>('@cluesmith/codev-core/constants');
    return actual.AGENT_FARM_DIR;
  } finally {
    if (saved !== undefined) process.env.CODEV_AGENT_FARM_DIR = saved;
  }
}

interface StubState {
  pid: number;
  childPid: number;
  argv: string[];
}

function readState(): StubState | null {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as StubState;
}

describe.runIf(onWindows)('Phase 9: IDE server lifecycle against .cmd stubs on a real Windows host', () => {
  let tower: http.Server;
  let towerPort: number;

  beforeAll(async () => {
    expect(AGENT_FARM.length).toBeGreaterThan(260);
    fs.mkdirSync(AGENT_FARM, { recursive: true });
    Object.assign(process.env, STUB_ENV);
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

  afterEach(() => {
    delete process.env.STUB_IDE_VERSION;
    delete process.env.STUB_IDE_NO_LISTEN;
    Object.assign(process.env, STUB_ENV);
    fs.rmSync(STATE_FILE, { force: true });
  });

  afterAll(async () => {
    for (const key of Object.keys(STUB_ENV)) delete process.env[key];
    await new Promise<void>((resolve) => tower.close(() => resolve()));
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('discovery without --server-path finds the .cmd shim on PATH (PATHEXT)', async () => {
    const found = await resolveIdeServerPath({ env: { Path: FIXTURES, PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD' } });
    expect(found?.toLowerCase()).toBe(path.join(FIXTURES, 'codev-ide-server.cmd').toLowerCase());
  });

  it('the sidebar install gets native paths past MAX_PATH, unaltered', async () => {
    const embedded = path.join(ROOT, 'embedded');
    fs.mkdirSync(embedded, { recursive: true });
    fs.writeFileSync(path.join(embedded, 'codev-vscode.vsix'), 'stub');
    fs.writeFileSync(path.join(embedded, 'manifest.json'), JSON.stringify({ id: SIDEBAR_ID, version: '9.9.9' }));
    const extensionsDir = getIdeExtensionsDir();
    expect(extensionsDir.length).toBeGreaterThan(260);
    process.env.STUB_IDE_EXTENSION_ID = SIDEBAR_ID;
    process.env.STUB_IDE_EXTENSION_VERSION = '9.9.9';

    const result = await ensureSidebarInstalled(path.join(FIXTURES, 'codev-ide-server-plain.cmd'), {
      extensionsDir,
      embeddedDir: embedded,
      log,
    });
    expect(result.outcome).toBe('installed');
    expect(readInstalledExtensionVersion(extensionsDir, SIDEBAR_ID)).toBe('9.9.9');
    const argv = JSON.parse(fs.readFileSync(INSTALL_LOG, 'utf-8').trim().split('\n').pop() as string) as string[];
    expect(argv).toEqual(['--install-extension', path.join(embedded, 'codev-vscode.vsix'), '--force', '--extensions-dir', extensionsDir]);
  }, 60_000);

  it('a below-floor server is refused with its version and the floor; nothing runs, no record', async () => {
    process.env.STUB_IDE_VERSION = '1.127.9';
    const port = await freePort();
    const attempt = spawnIdeServer({ serverPath: path.join(FIXTURES, 'codev-ide-server.cmd'), port }, log);
    await expect(attempt).rejects.toBeInstanceOf(IdeServerVersionError);
    await expect(attempt).rejects.toThrow(/version 1\.127\.9.*1\.128\.0/);
    expect(readIdeRecord()).toBeNull();
    expect(readState()).toBeNull();
  }, 60_000);

  it('a server that never listens is refused, its tree killed, no record', async () => {
    process.env.STUB_IDE_NO_LISTEN = '1';
    const port = await freePort();
    const attempt = spawnIdeServer({ serverPath: path.join(FIXTURES, 'codev-ide-server-plain.cmd'), port }, log);
    await expect(attempt).rejects.toThrow(/did not start listening/);
    const stub = readState();
    expect(stub).not.toBeNull();
    const lingering = await waitFor(() => {
      const alive = [(stub as StubState).pid, (stub as StubState).childPid].filter(isAlive);
      if (alive.length === 0) return [];
      return null;
    }, 5_000);
    expect(lingering).toEqual([]);
    expect(readIdeRecord()).toBeNull();
  }, 60_000);

  it.each(SHIMS)('$shape: spawns, forwards a native ?folder path, and stops with nothing left running', async (shim) => {
    const port = await freePort();
    const serverPath = path.join(FIXTURES, shim.file);
    const { record } = await spawnIdeServer({ serverPath, port }, log);
    expect(record.port).toBe(port);
    expect(record.serverVersion).toBe('1.128.0');

    const stub = (await waitFor(readState, 10_000)) as StubState;
    expect(stub).not.toBeNull();
    console.log(`STUB-TREE ${shim.shape} root=${record.pid} server=${stub.pid} child=${stub.childPid}`);
    expect(record.pid === stub.pid).toBe(shim.rootIsServer);

    // Native paths past MAX_PATH reached the server unaltered.
    const tokenPath = getIdeConnectionTokenPath();
    expect(tokenPath.length).toBeGreaterThan(260);
    expect(stub.argv[stub.argv.indexOf('--connection-token-file') + 1]).toBe(tokenPath);
    expect(stub.argv[stub.argv.indexOf('--extensions-dir') + 1]).toBe(getIdeExtensionsDir());

    // Everything Tower writes is under the agent-farm directory, in the profile.
    for (const written of [tokenPath, getIdeRecordPath(), getIdeExtensionsDir()]) {
      expect(written.startsWith(AGENT_FARM)).toBe(true);
    }
    expect((await productionAgentFarmDir()).toLowerCase().startsWith(path.resolve(os.homedir()).toLowerCase())).toBe(true);

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
