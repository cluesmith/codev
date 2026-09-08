/**
 * E2E regression for #1515: a spawned test Tower must not touch the real
 * `~/.agent-farm`.
 *
 * The scenario the issue describes, reproduced with a stand-in for the
 * developer's home directory: two cloud configs exist — a canary at the
 * *real-shaped* path (`$HOME/.agent-farm/cloud-config.json`) and a separate one
 * in the isolated `CODEV_AGENT_FARM_DIR` the Tower is pointed at. Driving a
 * full tunnel disconnect must consume the isolated config and leave the
 * real-shaped canary untouched.
 *
 * Without the fix `AGENT_FARM_DIR` resolves from `homedir()`, the Tower reads
 * and deletes the canary, and the assertions below fail — which is exactly what
 * happened to a live Tower on 2026-08-17.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';
import { waitForPort } from './helpers/tower-test-utils.js';

const TOWER_SERVER_PATH = resolve(
  import.meta.dirname,
  '../../../dist/agent-farm/servers/tower-server.js',
);
const PORT = 14915;
const START_TIMEOUT = 20_000;

const CANARY_HOME_CONFIG = {
  tower_id: 'canary-real-tower-id',
  tower_name: 'canary-real-tower',
  api_key: 'ctk_CanaryRealKey1234567890',
  server_url: 'https://cloud.example.invalid',
};
const ISOLATED_CONFIG = {
  tower_id: 'isolated-test-tower-id',
  tower_name: 'isolated-test-tower',
  api_key: 'ctk_IsolatedTestKey12345678',
  server_url: 'https://cloud.example.invalid',
};

const dirs: string[] = [];
let proc: ChildProcess | null = null;

function makeDir(prefix: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  if (proc) {
    proc.kill('SIGTERM');
    await new Promise<void>((done) => {
      proc!.on('exit', () => done());
      setTimeout(() => { proc!.kill('SIGKILL'); done(); }, 2000);
    });
  }
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('#1515 spawned Tower cannot reach the real agent-farm dir', () => {
  it('consumes the isolated cloud config and leaves the real-shaped canary intact', async () => {
    // A stand-in for the developer's home, with the canary the bug destroyed.
    const fakeHome = makeDir('codev-1515-home-');
    const fakeHomeAgentFarm = resolve(fakeHome, '.agent-farm');
    mkdirSync(fakeHomeAgentFarm, { recursive: true });
    const canaryPath = resolve(fakeHomeAgentFarm, 'cloud-config.json');
    writeFileSync(canaryPath, JSON.stringify(CANARY_HOME_CONFIG), { mode: 0o600 });
    writeFileSync(resolve(fakeHomeAgentFarm, 'local-key'), ensureLocalKey(), { mode: 0o600 });

    // The throwaway dir the Tower is actually pointed at.
    const isolated = makeDir('codev-1515-af-');
    writeFileSync(resolve(isolated, 'cloud-config.json'), JSON.stringify(ISOLATED_CONFIG), { mode: 0o600 });
    writeFileSync(resolve(isolated, 'local-key'), ensureLocalKey(), { mode: 0o600 });

    const socketDir = mkdtempSync('/tmp/codev-sock-1515-');
    dirs.push(socketDir);

    proc = spawn('node', [TOWER_SERVER_PATH, String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        HOME: fakeHome,
        NODE_ENV: 'test',
        AF_TEST_DB: `test-${PORT}.db`,
        SHELLPER_SOCKET_DIR: socketDir,
        CODEV_AGENT_FARM_DIR: isolated,
        // This test owns a fake cloud config, so it may exercise the real
        // disconnect path that the defence-in-depth guard otherwise refuses.
        CODEV_ALLOW_TEST_CLOUD_MUTATION: '1',
      },
    });

    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));

    expect(await waitForPort(PORT, START_TIMEOUT), `Tower did not start. stderr: ${stderr}`).toBe(true);

    const headers = { [TOWER_KEY_HEADER]: ensureLocalKey() };

    // The Tower must be reading the ISOLATED config, not the canary.
    const status = await fetch(`http://127.0.0.1:${PORT}/api/tunnel/status`, { headers });
    expect(status.ok).toBe(true);
    const statusBody = await status.json() as { registered: boolean; towerId?: string };
    expect(statusBody.registered).toBe(true);
    expect(statusBody.towerId).toBe(ISOLATED_CONFIG.tower_id);
    expect(statusBody.towerId).not.toBe(CANARY_HOME_CONFIG.tower_id);

    // Drive the destructive path.
    const disconnect = await fetch(`http://127.0.0.1:${PORT}/api/tunnel/disconnect`, {
      method: 'POST',
      headers,
    });
    expect(disconnect.ok).toBe(true);

    // The isolated config is gone — the disconnect really ran.
    expect(existsSync(resolve(isolated, 'cloud-config.json'))).toBe(false);

    // The real-shaped canary is untouched, byte for byte.
    expect(existsSync(canaryPath)).toBe(true);
    expect(JSON.parse(readFileSync(canaryPath, 'utf-8'))).toEqual(CANARY_HOME_CONFIG);

    // And all of this Tower's state landed in the isolated dir.
    const isolatedFiles = readdirSync(isolated);
    expect(isolatedFiles).toContain(`test-${PORT}.db`);
    expect(readdirSync(fakeHomeAgentFarm)).not.toContain(`test-${PORT}.db`);
  }, 60_000);
});
