/**
 * Spec 1789 phase 4: every IDE server spawn path runs the version floor and
 * the sidebar install before stopping or replacing anything, spawns with
 * `--extensions-dir`, records the new facts, and is serialized by the
 * lifecycle lock. The port table, process signals and `spawn` are faked; the
 * phase 2 and 3 checks are mocked so each test controls their outcome and
 * timing. AGENT_FARM_DIR is a temp dir, so the real ~/.agent-farm is never
 * touched.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TMP_DIR = vi.hoisted(() => `${process.env.TMPDIR || '/tmp'}/ide-preflight-test-${process.pid}-${Date.now()}`);

const fakes = vi.hoisted(() => ({
  /** port -> listening pids */
  ports: new Map<number, number[]>(),
  events: [] as string[],
  nextPid: 5000,
  spawnCalls: [] as { command: string; args: string[]; env: Record<string, string> }[],
  /** The real writer, for seeding records without logging a lifecycle write. */
  seedRecord: (() => {}) as (record: unknown) => void,
}));

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: TMP_DIR };
});

vi.mock('../utils/port.js', () => ({
  getProcessesOnPort: (port: number) => fakes.ports.get(port) ?? [],
}));

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], opts: { env: Record<string, string> }) => {
      const pid = fakes.nextPid++;
      fakes.events.push('spawn');
      fakes.spawnCalls.push({ command, args, env: opts.env });
      const port = Number(args[args.indexOf('--port') + 1]);
      fakes.ports.set(port, [pid]);
      return { pid, unref: () => {} };
    },
  };
});

const checkVersion = vi.hoisted(() => vi.fn());
const installSidebar = vi.hoisted(() => vi.fn());

vi.mock('../lib/ide-version.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/ide-version.js')>();
  return { ...actual, checkIdeServerVersion: checkVersion };
});

vi.mock('../lib/ide-extensions.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/ide-extensions.js')>();
  return { ...actual, ensureSidebarInstalled: installSidebar };
});

vi.mock('../lib/ide-record.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/ide-record.js')>();
  fakes.seedRecord = actual.writeIdeRecord as (record: unknown) => void;
  return {
    ...actual,
    writeIdeRecord: (record: Parameters<typeof actual.writeIdeRecord>[0]) => {
      fakes.events.push(`write:${record.pid}`);
      actual.writeIdeRecord(record);
    },
  };
});

import {
  spawnIdeServer,
  stopIdeServer,
  ensureIdeServerLive,
  reconcileIdeServer,
  handleIdeApi,
} from '../servers/ide-server.js';
import {
  readIdeRecord,
  deleteIdeRecord,
  getIdeRecordPath,
  type IdeServerRecord,
} from '../lib/ide-record.js';
import { IdeServerVersionError } from '../lib/ide-version.js';
import { IdeSidebarInstallError, getIdeExtensionsDir } from '../lib/ide-extensions.js';

const SERVER_PATH = resolve(TMP_DIR, 'bin', 'codev-ide-server');
const OLD_SERVER_PATH = resolve(TMP_DIR, 'bin', 'old-codev-ide-server');
const EXTENSIONS_DIR = resolve(TMP_DIR, 'ide-extensions');

type LogLine = { level: string; message: string };
let logLines: LogLine[];
const log = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => {
  logLines.push({ level, message });
};

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

function passPreflight(sidebar: { outcome?: string; version?: string | null } = {}): void {
  checkVersion.mockImplementation(async () => {
    fakes.events.push('version');
    return { version: '1.135.0' };
  });
  installSidebar.mockImplementation(async () => {
    fakes.events.push('install');
    return {
      outcome: sidebar.outcome ?? 'skipped',
      version: sidebar.version === undefined ? '3.3.4' : sidebar.version,
      previousVersion: '3.3.4',
    };
  });
}

function recordOn(port: number, pid: number, extra: Partial<IdeServerRecord> = {}): IdeServerRecord {
  return {
    prefix: '/ide/',
    port,
    serverPath: SERVER_PATH,
    pid,
    startedAt: '2026-10-01T00:00:00.000Z',
    serverVersion: '1.135.0',
    extensionsDir: EXTENSIONS_DIR,
    sidebarVersion: '3.3.4',
    ...extra,
  };
}

/** A legacy (pre-#1789) record written byte-for-byte as the old Tower wrote it. */
function writeLegacyRecord(port: number, pid: number): void {
  writeFileSync(
    getIdeRecordPath(),
    JSON.stringify({ prefix: '/ide/', port, serverPath: SERVER_PATH, pid, startedAt: '2026-09-01T00:00:00.000Z' }),
  );
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

let killSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mkdirSync(resolve(TMP_DIR, 'bin'), { recursive: true });
  writeFileSync(SERVER_PATH, '#!/bin/sh\n');
  writeFileSync(OLD_SERVER_PATH, '#!/bin/sh\n');
  fakes.ports.clear();
  fakes.events.length = 0;
  fakes.spawnCalls.length = 0;
  logLines = [];
  checkVersion.mockReset();
  installSidebar.mockReset();
  passPreflight();
  // SIGTERM "kills": the pid leaves the port table; signal 0 probes it.
  killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    const alive = [...fakes.ports.values()].some((pids) => pids.includes(pid));
    if (signal === 0) {
      if (!alive) throw new Error('ESRCH');
      return true;
    }
    fakes.events.push(`kill:${pid}`);
    for (const [port, pids] of fakes.ports) {
      fakes.ports.set(port, pids.filter((p) => p !== pid));
    }
    return true;
  }) as typeof process.kill);
});

afterEach(() => {
  killSpy.mockRestore();
  deleteIdeRecord();
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('spawn preflight', () => {
  it('spawns with --extensions-dir and the server env, and records the new facts', async () => {
    const { record, restartRequired } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(restartRequired).toBe(false);
    expect(fakes.events.slice(0, 3)).toEqual(['version', 'install', 'spawn']);
    const { args, env } = fakes.spawnCalls[0];
    expect(argValue(args, '--extensions-dir')).toBe(getIdeExtensionsDir());
    expect(env.PATH.split(':')[0]).toBe(resolve(process.execPath, '..'));
    expect(installSidebar).toHaveBeenCalledWith(SERVER_PATH, expect.objectContaining({ extensionsDir: getIdeExtensionsDir(), log }));
    expect(record).toMatchObject({ serverVersion: '1.135.0', extensionsDir: getIdeExtensionsDir(), sidebarVersion: '3.3.4' });
    expect(readIdeRecord()).toEqual(record);
  });

  it('refuses a below-floor server: nothing spawned, no record written (Scenario 8)', async () => {
    checkVersion.mockRejectedValue(new IdeServerVersionError('IDE server is version 1.100.0, below the supported floor'));

    await expect(spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log)).rejects.toThrow(/below the supported floor/);
    expect(fakes.spawnCalls).toHaveLength(0);
    expect(installSidebar).not.toHaveBeenCalled();
    expect(readIdeRecord()).toBeNull();
  });

  it('refuses on a failed install: nothing spawned, no record written (Scenario 8)', async () => {
    installSidebar.mockRejectedValue(new IdeSidebarInstallError('install failed'));

    await expect(spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log)).rejects.toThrow(/install failed/);
    expect(fakes.spawnCalls).toHaveLength(0);
    expect(readIdeRecord()).toBeNull();
  });

  it('still spawns with --extensions-dir when the embedded vsix is missing (Scenario 16)', async () => {
    passPreflight({ outcome: 'missing-vsix', version: null });

    const { record } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(argValue(fakes.spawnCalls[0].args, '--extensions-dir')).toBe(getIdeExtensionsDir());
    expect(record.sidebarVersion).toBeUndefined();
    expect('sidebarVersion' in JSON.parse(readFileSync(getIdeRecordPath(), 'utf8'))).toBe(false);
  });

  for (const [name, failure] of [
    ['below floor', new IdeServerVersionError('below the supported floor')],
    ['failed install', new IdeSidebarInstallError('install failed')],
  ] as const) {
    it(`a ${name} on a port change leaves the live server running and the record byte-identical (Scenario 19)`, async () => {
      fakes.seedRecord(recordOn(8200, 4100));
      fakes.ports.set(8200, [4100]);
      const before = readFileSync(getIdeRecordPath());
      if (failure instanceof IdeServerVersionError) {
        checkVersion.mockRejectedValue(failure);
      } else {
        installSidebar.mockRejectedValue(failure);
      }

      await expect(spawnIdeServer({ serverPath: SERVER_PATH, port: 8300 }, log)).rejects.toThrow(failure.message);

      expect(fakes.ports.get(8200)).toEqual([4100]);
      expect(fakes.events.some((e) => e.startsWith('kill:'))).toBe(false);
      expect(fakes.spawnCalls).toHaveLength(0);
      expect(readFileSync(getIdeRecordPath()).equals(before)).toBe(true);
    });
  }

  it('a below-floor serverPath against a healthy live server fails and leaves both untouched', async () => {
    fakes.seedRecord(recordOn(8200, 4100));
    fakes.ports.set(8200, [4100]);
    const before = readFileSync(getIdeRecordPath());
    checkVersion.mockRejectedValue(new IdeServerVersionError('below the supported floor'));

    await expect(spawnIdeServer({ serverPath: OLD_SERVER_PATH, port: 8200 }, log)).rejects.toThrow(/below the supported floor/);

    expect(fakes.ports.get(8200)).toEqual([4100]);
    expect(readFileSync(getIdeRecordPath()).equals(before)).toBe(true);
  });

  it('runs the preflight strictly before stopping the server on the old port, and completes', async () => {
    fakes.seedRecord(recordOn(8200, 4100));
    fakes.ports.set(8200, [4100]);

    const { record } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8300 }, log);

    expect(fakes.events.slice(0, 4)).toEqual(['version', 'install', 'kill:4100', 'spawn']);
    expect(record.port).toBe(8300);
    expect(fakes.ports.get(8200)).toEqual([]);
  });
});

describe('live-port adopt', () => {
  it('adopts a current server without killing it and needs no restart', async () => {
    fakes.seedRecord(recordOn(8200, 4100));
    fakes.ports.set(8200, [4100]);

    const { record, restartRequired } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(restartRequired).toBe(false);
    expect(fakes.spawnCalls).toHaveLength(0);
    expect(fakes.ports.get(8200)).toEqual([4100]);
    expect(record).toMatchObject({ pid: 4100, serverVersion: '1.135.0', extensionsDir: EXTENSIONS_DIR, sidebarVersion: '3.3.4' });
  });

  it('keeps flagging a restart on later starts until the server loads the upgraded sidebar', async () => {
    fakes.seedRecord(recordOn(8200, 4100, { sidebarVersion: '3.3.0' }));
    fakes.ports.set(8200, [4100]);
    passPreflight({ outcome: 'installed' });

    const first = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);
    // The install is already done: this start skips it, yet the live server still runs 3.3.0.
    passPreflight({ outcome: 'skipped' });
    const second = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(first.restartRequired).toBe(true);
    expect(second.restartRequired).toBe(true);
    expect(second.record.sidebarVersion).toBe('3.3.0');
    expect(fakes.ports.get(8200)).toEqual([4100]);
  });

  it('flags a restart when the live server uses a different extensions directory', async () => {
    fakes.seedRecord(recordOn(8200, 4100, { extensionsDir: '/elsewhere/ide-extensions' }));
    fakes.ports.set(8200, [4100]);

    const { restartRequired } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(restartRequired).toBe(true);
  });

  it('keeps flagging a restart on later starts from a different server path, recording the live binary', async () => {
    fakes.seedRecord(recordOn(8200, 4100, { serverPath: OLD_SERVER_PATH, serverVersion: '1.130.0' }));
    fakes.ports.set(8200, [4100]);

    const first = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);
    const second = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(first.restartRequired).toBe(true);
    expect(second.restartRequired).toBe(true);
    // The record (and so `afx ide status`) describes the live process, not the requested binary.
    expect(readIdeRecord()).toMatchObject({
      pid: 4100,
      serverPath: OLD_SERVER_PATH,
      serverVersion: '1.130.0',
      startedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(fakes.spawnCalls).toHaveLength(0);
    expect(fakes.ports.get(8200)).toEqual([4100]);
  });

  it('keeps flagging a restart after the server was upgraded in place at the same path', async () => {
    // `npm i -g @cluesmith/codev-ide` keeps the bin path; the live process still runs 1.130.0.
    fakes.seedRecord(recordOn(8200, 4100, { serverVersion: '1.130.0' }));
    fakes.ports.set(8200, [4100]);

    const first = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);
    const second = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(first.restartRequired).toBe(true);
    expect(second.restartRequired).toBe(true);
    expect(readIdeRecord()).toMatchObject({ pid: 4100, serverPath: SERVER_PATH, serverVersion: '1.130.0' });
    expect(fakes.spawnCalls).toHaveLength(0);
    expect(fakes.ports.get(8200)).toEqual([4100]);
  });

  it('does not flag a restart for a missing embedded sidebar when the server is otherwise current', async () => {
    fakes.seedRecord(recordOn(8200, 4100, { sidebarVersion: undefined }));
    fakes.ports.set(8200, [4100]);
    passPreflight({ outcome: 'missing-vsix', version: null });

    const { restartRequired } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(restartRequired).toBe(false);
  });

  it('keeps the live server default folder when the start names none', async () => {
    fakes.seedRecord(recordOn(8200, 4100, { defaultFolder: '/home/dev/project' }));
    fakes.ports.set(8200, [4100]);

    const kept = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);
    const replaced = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200, defaultFolder: '/home/dev/other' }, log);

    expect(kept.record.defaultFolder).toBe('/home/dev/project');
    expect(replaced.record.defaultFolder).toBe('/home/dev/other');
  });

  it('flags a restart when the sidebar changed, without killing the server', async () => {
    fakes.seedRecord(recordOn(8200, 4100));
    fakes.ports.set(8200, [4100]);
    passPreflight({ outcome: 'installed' });

    const { restartRequired } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(restartRequired).toBe(true);
    expect(fakes.ports.get(8200)).toEqual([4100]);
  });

  it('flags a restart for a legacy record and keeps its absent fields absent', async () => {
    writeLegacyRecord(8200, 4100);
    fakes.ports.set(8200, [4100]);

    const { record, restartRequired } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(restartRequired).toBe(true);
    expect(record.extensionsDir).toBeUndefined();
    expect(record.serverVersion).toBeUndefined();
  });

  it('flags a restart for a stray server with no prior record and records no serverVersion', async () => {
    fakes.ports.set(8200, [4100]);

    const { record, restartRequired } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(restartRequired).toBe(true);
    expect(record.serverVersion).toBeUndefined();
    expect(readIdeRecord()?.serverVersion).toBeUndefined();
    expect(fakes.ports.get(8200)).toEqual([4100]);
  });
});

describe('respawn and boot reconcile', () => {
  it('respawns a dead recorded server with --extensions-dir (Scenario 18)', async () => {
    fakes.seedRecord(recordOn(8200, 4100));

    const port = await ensureIdeServerLive(log);

    expect(port).toBe(8200);
    expect(argValue(fakes.spawnCalls[0].args, '--extensions-dir')).toBe(getIdeExtensionsDir());
    expect(readIdeRecord()?.serverVersion).toBe('1.135.0');
  });

  it('boot reconcile of a dead recorded server completes and spawns with --extensions-dir (Scenario 18)', async () => {
    fakes.seedRecord(recordOn(8200, 4100));

    await reconcileIdeServer(log);

    expect(fakes.spawnCalls).toHaveLength(1);
    expect(argValue(fakes.spawnCalls[0].args, '--extensions-dir')).toBe(getIdeExtensionsDir());
  });

  it('refuses and logs the respawn of a server downgraded below the floor (Scenario 10)', async () => {
    fakes.seedRecord(recordOn(8200, 4100));
    const before = readFileSync(getIdeRecordPath());
    checkVersion.mockRejectedValue(new IdeServerVersionError('IDE server is version 1.100.0, below the supported floor'));

    expect(await ensureIdeServerLive(log)).toBeNull();

    expect(fakes.spawnCalls).toHaveLength(0);
    expect(logLines).toContainEqual({ level: 'WARN', message: expect.stringMatching(/respawn failed: .*below the supported floor/) });
    expect(readFileSync(getIdeRecordPath()).equals(before)).toBe(true);
  });

  it('adopts the live server of a legacy record on boot (Scenario 23)', async () => {
    writeLegacyRecord(8200, 4100);
    fakes.ports.set(8200, [4100]);

    await reconcileIdeServer(log);

    expect(fakes.spawnCalls).toHaveLength(0);
    expect(fakes.ports.get(8200)).toEqual([4100]);
    expect(readIdeRecord()).toMatchObject({ port: 8200, pid: 4100 });
  });
});

describe('serialization', () => {
  /** Hold every preflight at the version check until released. */
  function gatePreflight(): () => void {
    const gate = deferred();
    checkVersion.mockImplementation(async () => {
      fakes.events.push('version');
      await gate.promise;
      return { version: '1.135.0' };
    });
    return gate.release;
  }

  it('two overlapping starts produce one spawn and non-interleaved record writes (Scenario 20)', async () => {
    const release = gatePreflight();

    const first = spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);
    const second = spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);
    await new Promise((r) => setTimeout(r, 20));
    // Without the lock both would be past their liveness check by now.
    expect(fakes.events).toEqual(['version']);
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(fakes.spawnCalls).toHaveLength(1);
    expect(b.record.pid).toBe(a.record.pid);
    const pid = a.record.pid;
    expect(fakes.events).toEqual(['version', 'install', 'spawn', `write:${pid}`, 'version', 'install', `write:${pid}`]);
  });

  it('a start plus a respawn produce one spawn, and the start acts on the respawn result', async () => {
    fakes.seedRecord(recordOn(8200, 4100));
    const release = gatePreflight();

    const respawn = ensureIdeServerLive(log);
    const start = spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);
    await new Promise((r) => setTimeout(r, 20));
    expect(fakes.events).toEqual(['version']);
    release();
    const [port, started] = await Promise.all([respawn, start]);

    expect(port).toBe(8200);
    expect(fakes.spawnCalls).toHaveLength(1);
    const respawnedPid = fakes.ports.get(8200)?.[0];
    // The queued start re-read the record the respawn wrote and adopted that server.
    expect(started.record.pid).toBe(respawnedPid);
    expect(started.restartRequired).toBe(false);
    expect(started.record.extensionsDir).toBe(getIdeExtensionsDir());
  });

  it('a respawn queued behind a stop re-reads the record and does not resurrect the server', async () => {
    fakes.seedRecord(recordOn(8200, 4100));
    fakes.ports.set(8200, [4100]);
    const release = gatePreflight();
    // Hold the lock with a start, queue a stop, then a respawn after the server dies.
    const start = spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);
    const stop = stopIdeServer(log);
    fakes.ports.set(8200, []);
    const respawn = ensureIdeServerLive(log);
    release();
    await start;
    await stop;

    expect(await respawn).toBeNull();
    expect(fakes.spawnCalls).toHaveLength(1);
    expect(readIdeRecord()).toBeNull();
  });

  it('a failed operation releases the lock for the next one', async () => {
    checkVersion.mockRejectedValueOnce(new IdeServerVersionError('below the supported floor'));

    await expect(spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log)).rejects.toThrow();
    passPreflight();
    const { record } = await spawnIdeServer({ serverPath: SERVER_PATH, port: 8200 }, log);

    expect(record.port).toBe(8200);
  });
});

describe('/api/ide', () => {
  async function post(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const server = http.createServer((req, res) => {
      handleIdeApi(req, res, log);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/ide`, { method: 'POST', body: JSON.stringify(body) });
      return { status: response.status, json: (await response.json()) as Record<string, unknown> };
    } finally {
      server.close();
    }
  }

  it('POST passes restartRequired and the new record fields', async () => {
    fakes.ports.set(8200, [4100]);

    const { status, json } = await post({ serverPath: SERVER_PATH, port: 8200 });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, port: 8200, pid: 4100, restartRequired: true });
  });

  it('POST of a fresh spawn reports restartRequired false with the recorded versions', async () => {
    const { json } = await post({ serverPath: SERVER_PATH, port: 8200 });

    expect(json).toMatchObject({
      ok: true,
      restartRequired: false,
      serverVersion: '1.135.0',
      sidebarVersion: '3.3.4',
      extensionsDir: getIdeExtensionsDir(),
    });
  });

  it('POST of a below-floor server returns the floor error', async () => {
    checkVersion.mockRejectedValue(new IdeServerVersionError('below the supported floor'));

    const { status, json } = await post({ serverPath: SERVER_PATH, port: 8200 });

    expect(status).toBe(500);
    expect(String(json.error)).toMatch(/below the supported floor/);
  });
});
