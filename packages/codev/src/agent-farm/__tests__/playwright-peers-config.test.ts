/**
 * Spec 1967, plan phase 12: `playwright.peers.config.ts` and its directories
 * (`__tests__/e2e/peers-isolation.ts`), which keep the Peers suites' throwaway Tower apart from a
 * live one.
 *
 * What is proven: the config refuses an unset or live port before it makes anything; loaded twice
 * (as Playwright's main process and then a worker do), it finds one set of directories, all under
 * the system temp directory; the path check refuses the live agent-farm directory, the default
 * socket directory, the real home, anything containing one of them, a symlink to one, and a path
 * outside the system temp directory; and the teardown's removal leaves none of the directories.
 * Every directory made here is under the system temp directory and removed after each test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  PEERS_DIR_VARS,
  checkPeersDir,
  liveDirs,
  peersDirs,
  recordedPeersDirs,
  removePeersDirs,
} from './e2e/peers-isolation.js';

const VARS = [...Object.values(PEERS_DIR_VARS), 'TOWER_TEST_PORT'];
let saved: Record<string, string | undefined>;
let scratch: string[];

function scratchDir(): string {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), 'codev-peers-config-test-'));
  scratch.push(dir);
  return dir;
}

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
  scratch = [];
});

afterEach(() => {
  // Anything a test left recorded in the real environment is removed, checked, before it is forgotten.
  if (recordedPeersDirs() !== null) removePeersDirs();
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  return (await import('../../../playwright.peers.config.js')).default;
}

describe('playwright.peers.config.ts', () => {
  it.each([
    ['unset', undefined],
    ['the live port', '4100'],
    ['not a port', 'abc'],
    ['out of range', '70000'],
  ])('refuses with TOWER_TEST_PORT %s, before it makes any directory', async (_label, port) => {
    if (port !== undefined) process.env.TOWER_TEST_PORT = port;
    await expect(loadConfig()).rejects.toThrow(/TOWER_TEST_PORT must be set to a throwaway Tower port/);
    expect(recordedPeersDirs()).toBeNull();
  });

  it('loaded twice, as the main process and then a worker, finds one set of directories under the temp directory', async () => {
    process.env.TOWER_TEST_PORT = '14102';
    const first = await loadConfig();
    const firstEnv = first.webServer && !Array.isArray(first.webServer) ? first.webServer.env : undefined;
    expect(firstEnv).toBeDefined();

    const second = await loadConfig();
    const secondEnv = second.webServer && !Array.isArray(second.webServer) ? second.webServer.env : undefined;
    expect(secondEnv).toEqual(firstEnv);

    const recorded = recordedPeersDirs()!;
    expect(firstEnv).toMatchObject({
      CODEV_AGENT_FARM_DIR: recorded.agentFarm,
      SHELLPER_SOCKET_DIR: recorded.socket,
      HOME: recorded.home,
      CODEV_TOWER_KEY: '',
    });
    const tmp = realpathSync(tmpdir());
    for (const dir of Object.values(recorded)) {
      expect(existsSync(dir)).toBe(true);
      expect(dir.startsWith(tmp + path.sep)).toBe(true);
    }
    expect(new Set(Object.values(recorded)).size).toBe(3);
  });

  it('starts a fresh Tower on the port given, never reusing one, with no global setup', async () => {
    process.env.TOWER_TEST_PORT = '14102';
    const config = await loadConfig();
    const server = config.webServer && !Array.isArray(config.webServer) ? config.webServer : null;
    expect(server).toMatchObject({ port: 14102, reuseExistingServer: false });
    expect(server!.command).toContain('tower-server.js 14102');
    expect(config.globalSetup).toBeUndefined();
    expect(config.globalTeardown).toMatch(/peers-teardown\.ts$/);
  });
});

describe('peersDirs', () => {
  it('makes three directories once, records them, and finds the same ones when asked again', () => {
    const env: NodeJS.ProcessEnv = {};
    const tmp = scratchDir();
    const first = peersDirs(env, tmp);
    expect(first.created).toBe(true);
    const again = peersDirs(env, tmp);
    expect(again).toEqual({ dirs: first.dirs, created: false });
    expect(env[PEERS_DIR_VARS.agentFarm]).toBe(first.dirs.agentFarm);
  });

  it('refuses an environment that records only some of them', () => {
    expect(() => peersDirs({ [PEERS_DIR_VARS.agentFarm]: '/tmp/x' })).toThrow(/Only some of/);
  });
});

describe('checkPeersDir', () => {
  it('refuses the live agent-farm directory, the default socket directory, the real home and a path outside the temp directory', () => {
    const live = liveDirs();
    expect(() => checkPeersDir(live.agentFarm)).toThrow();
    expect(() => checkPeersDir(live.socket)).toThrow();
    expect(() => checkPeersDir(homedir())).toThrow();
    expect(() => checkPeersDir('/usr/local')).toThrow(/not under the system temp directory/);
  });

  it('refuses a directory that is or contains a live one, even under the temp directory', () => {
    // A home under the temp directory, so the containment rule is what refuses, not the temp rule.
    const root = scratchDir();
    const home = path.join(root, 'home');
    const live = liveDirs(home);
    mkdirSync(live.agentFarm, { recursive: true });
    mkdirSync(live.socket, { recursive: true });

    expect(() => checkPeersDir(live.agentFarm, live)).toThrow(/is or contains the live agent-farm directory/);
    expect(() => checkPeersDir(live.socket, live)).toThrow(/is or contains the default shellper socket directory/);
    expect(() => checkPeersDir(home, live)).toThrow(/is or contains the live agent-farm directory|is or contains the real home/);
    expect(() => checkPeersDir(root, live)).toThrow(/is or contains/);
  });

  it('refuses a symlink to a live directory, by where it leads', () => {
    const root = scratchDir();
    const live = liveDirs(path.join(root, 'home'));
    mkdirSync(live.agentFarm, { recursive: true });
    const link = path.join(root, 'innocent-looking');
    symlinkSync(live.agentFarm, link);
    expect(() => checkPeersDir(link, live)).toThrow(/is or contains the live agent-farm directory/);
  });

  it('accepts a throwaway directory under the temp directory and returns it resolved', () => {
    const root = scratchDir();
    const live = liveDirs(path.join(root, 'home'));
    const dir = path.join(root, 'throwaway');
    mkdirSync(dir);
    expect(checkPeersDir(dir, live)).toBe(realpathSync(dir));
  });
});

describe('removePeersDirs', () => {
  it('removes exactly the recorded directories, and leaves none of them', () => {
    const env: NodeJS.ProcessEnv = {};
    const { dirs } = peersDirs(env);
    const sibling = scratchDir();
    const removed = removePeersDirs(env);
    expect(removed.sort()).toEqual(Object.values(dirs).map((d) => realpathSync(path.dirname(d)) + path.sep + path.basename(d)).sort());
    for (const dir of Object.values(dirs)) expect(existsSync(dir)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it('removes nothing, and refuses, when a recorded directory is not a throwaway one', () => {
    const env: NodeJS.ProcessEnv = {
      [PEERS_DIR_VARS.agentFarm]: liveDirs().agentFarm,
      [PEERS_DIR_VARS.socket]: scratchDir(),
      [PEERS_DIR_VARS.home]: scratchDir(),
    };
    expect(() => removePeersDirs(env)).toThrow();
    expect(existsSync(env[PEERS_DIR_VARS.socket]!)).toBe(true);
  });
});
