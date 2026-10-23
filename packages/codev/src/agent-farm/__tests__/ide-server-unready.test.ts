/**
 * Spec 1658 Phase 9 (sibling-site fix, architect ruling 2026-10-23): a Codev
 * IDE server that never starts listening is stopped before the start fails,
 * because no record is written and nothing could stop it later (the leak dates
 * from #1668/#1789). POSIX, with a real process: the shared stub server in
 * never-listen mode behind a shebang launcher, plus the stub's own child, both
 * gone afterwards. Windows runs the same case through `.cmd` shims in
 * `ide-server-stub.windows.test.ts`.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TMP_DIR = vi.hoisted(() => `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/ide-unready-${process.pid}-${Date.now()}`);

vi.mock('@cluesmith/codev-core/constants', async (importActual) => {
  const actual = await importActual<typeof import('@cluesmith/codev-core/constants')>();
  return { ...actual, AGENT_FARM_DIR: TMP_DIR };
});

// The readiness wait, shortened so the test does not sit out the production 15 s.
vi.mock('../lib/ide-version.js', async (importActual) => {
  const actual = await importActual<typeof import('../lib/ide-version.js')>();
  return { ...actual, IDE_READY_TIMEOUT_MS: 1_500 };
});

import { spawnIdeServer } from '../servers/ide-server.js';
import { readIdeRecord } from '../lib/ide-record.js';
import { locateEmbeddedSidebar } from '../lib/ide-extensions.js';

const onWindows = process.platform === 'win32';
const STUB = path.join(__dirname, 'fixtures', 'ide', 'stub-ide-server.mjs');
const ROOT = path.resolve(TMP_DIR);
const LAUNCHER = path.join(ROOT, 'codev-ide-server');
const STATE_FILE = path.join(ROOT, 'stub-state.json');
const EMBEDDED = locateEmbeddedSidebar();
const STUB_ENV = {
  STUB_IDE_STATE_FILE: STATE_FILE,
  STUB_IDE_NO_LISTEN: '1',
  STUB_IDE_EXTENSION_ID: EMBEDDED?.id ?? 'cluesmith.codev-vscode',
  STUB_IDE_EXTENSION_VERSION: EMBEDDED?.version ?? '0.0.0',
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

describe.skipIf(onWindows)('a Codev IDE server that never listens (POSIX)', () => {
  beforeAll(() => {
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(LAUNCHER, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" "$@"\n`, { mode: 0o755 });
    Object.assign(process.env, STUB_ENV);
  });

  afterEach(() => {
    fs.rmSync(STATE_FILE, { force: true });
  });

  afterAll(() => {
    for (const key of Object.keys(STUB_ENV)) delete process.env[key];
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('is stopped before the start fails: no process left, no record, the error says so', async () => {
    const attempt = spawnIdeServer({ serverPath: LAUNCHER, port: await freePort() }, () => {});
    await expect(attempt).rejects.toThrow(/did not start listening.*the server process was stopped/);

    const stub = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as { pid: number; childPid: number };
    const deadline = Date.now() + 5_000;
    let alive = [stub.pid, stub.childPid].filter(isAlive);
    while (alive.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      alive = alive.filter(isAlive);
    }
    expect(alive).toEqual([]);
    expect(readIdeRecord()).toBeNull();
  }, 30_000);
});
