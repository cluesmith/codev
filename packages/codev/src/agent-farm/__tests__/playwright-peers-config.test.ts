/**
 * Spec 1967, plan phase 12: `playwright.peers.config.ts` and its directories
 * (`__tests__/e2e/peers-isolation.ts`), which keep the Peers suites' throwaway Tower apart from a
 * live one.
 *
 * What is proven: the config refuses an unset or live port before it makes anything; loaded twice
 * (as Playwright's main process and then a worker do), it finds one run folder, under the system
 * temp directory; values a caller supplies are never adopted and what they name is never removed
 * (a pre-existing folder, a forged or missing owner marker, a run recorded by another process);
 * the path check refuses the live agent-farm directory, the default socket directory, the real
 * home, anything containing one of them, a symlink to one, and a path outside the system temp
 * directory; and the teardown's removal leaves none of the run's directories. Every directory made
 * here is under the system temp directory and removed after each test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  PEERS_OWNER_FILE,
  PEERS_ROOT_PREFIX,
  PEERS_RUN_VARS,
  checkPeersDir,
  liveDirs,
  ownedPeersDirs,
  peersDirs,
  recordedPeersRun,
  removePeersDirs,
} from './e2e/peers-isolation.js';

const VARS = [...Object.values(PEERS_RUN_VARS), 'TOWER_TEST_PORT'];
const NONCE = '0123456789abcdef0123456789abcdef';
/** A pid that is neither this process nor its parent. */
const OTHER_PID = process.pid + process.ppid + 1;
let saved: Record<string, string | undefined>;
let scratch: string[];

function scratchDir(prefix = 'codev-peers-config-test-'): string {
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), prefix));
  scratch.push(dir);
  return dir;
}

/** A folder a caller made, with a file of their own in it, that the run must never remove. */
function callersFolder(prefix?: string): { root: string; keep: string } {
  const root = scratchDir(prefix);
  const keep = path.join(root, 'keep.txt');
  writeFileSync(keep, 'the caller\'s');
  return { root, keep };
}

beforeEach(() => {
  saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
  for (const name of VARS) delete process.env[name];
  scratch = [];
});

afterEach(() => {
  // A run this process made and left recorded is removed, checked, before it is forgotten.
  const run = recordedPeersRun();
  if (run !== null && run.ownerPid === process.pid) removePeersDirs();
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
    expect(recordedPeersRun()).toBeNull();
  });

  it('loaded twice, as the main process and then a worker, finds one set of directories under the temp directory', async () => {
    process.env.TOWER_TEST_PORT = '14102';
    const first = await loadConfig();
    const firstEnv = first.webServer && !Array.isArray(first.webServer) ? first.webServer.env : undefined;
    expect(firstEnv).toBeDefined();

    const second = await loadConfig();
    const secondEnv = second.webServer && !Array.isArray(second.webServer) ? second.webServer.env : undefined;
    expect(secondEnv).toEqual(firstEnv);

    const recorded = ownedPeersDirs()!;
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
    const root = path.dirname(recorded.agentFarm);
    expect(path.dirname(root)).toBe(tmp);
    expect(path.basename(root).startsWith(PEERS_ROOT_PREFIX)).toBe(true);
    for (const dir of Object.values(recorded)) expect(path.dirname(dir)).toBe(root);
  });

  it('ignores run values a caller exported, and makes a run of its own', async () => {
    process.env.TOWER_TEST_PORT = '14102';
    const caller = callersFolder(PEERS_ROOT_PREFIX);
    writeFileSync(path.join(caller.root, PEERS_OWNER_FILE), `${OTHER_PID}:${NONCE}`);
    process.env[PEERS_RUN_VARS.root] = caller.root;
    process.env[PEERS_RUN_VARS.owner] = `${OTHER_PID}:${NONCE}`;

    const config = await loadConfig();
    const env = config.webServer && !Array.isArray(config.webServer) ? config.webServer.env : undefined;
    expect(env!.CODEV_AGENT_FARM_DIR.startsWith(caller.root + path.sep)).toBe(false);
    expect(process.env[PEERS_RUN_VARS.root]).not.toBe(caller.root);
    expect(existsSync(caller.keep)).toBe(true);
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
  it('makes one run folder holding three directories and an owner marker, and finds it again in the same process', () => {
    const env: NodeJS.ProcessEnv = {};
    const tmp = scratchDir();
    const first = peersDirs(env, tmp);
    expect(first.created).toBe(true);
    const root = path.dirname(first.dirs.agentFarm);
    expect(env[PEERS_RUN_VARS.root]).toBe(root);
    expect(readFileSync(path.join(root, PEERS_OWNER_FILE), 'utf-8')).toBe(env[PEERS_RUN_VARS.owner]);
    expect(env[PEERS_RUN_VARS.owner]).toMatch(new RegExp(`^${process.pid}:[0-9a-f]{32}$`));
    for (const dir of Object.values(first.dirs)) expect(existsSync(dir)).toBe(true);

    expect(peersDirs(env, tmp)).toEqual({ dirs: first.dirs, created: false });
  });

  it('a worker, a child of the process that made the run, finds the same folder', () => {
    const env: NodeJS.ProcessEnv = {};
    const tmp = scratchDir();
    const main = peersDirs(env, tmp, { pid: 4242, ppid: 1 });
    const worker = peersDirs({ ...env }, tmp, { pid: 5151, ppid: 4242 });
    expect(worker).toEqual({ dirs: main.dirs, created: false });
  });

  it('never adopts a folder a caller supplies, whoever it claims made it, and leaves it as it was', () => {
    const tmp = realpathSync(tmpdir());
    // Recorded by another process: ignored, a run of its own made.
    const other = callersFolder(PEERS_ROOT_PREFIX);
    writeFileSync(path.join(other.root, PEERS_OWNER_FILE), `${OTHER_PID}:${NONCE}`);
    const env: NodeJS.ProcessEnv = { [PEERS_RUN_VARS.root]: other.root, [PEERS_RUN_VARS.owner]: `${OTHER_PID}:${NONCE}` };
    const made = peersDirs(env, tmp);
    expect(made.created).toBe(true);
    expect(env[PEERS_RUN_VARS.root]).not.toBe(other.root);
    removePeersDirs(env);
    expect(existsSync(other.keep)).toBe(true);
    expect(existsSync(path.dirname(made.dirs.agentFarm))).toBe(false);

    // Claiming this process, or its parent, without a marker, with a forged one, or outside the run prefix: refused.
    const unmarked = callersFolder(PEERS_ROOT_PREFIX);
    for (const pid of [process.pid, process.ppid]) {
      expect(() => peersDirs({ [PEERS_RUN_VARS.root]: unmarked.root, [PEERS_RUN_VARS.owner]: `${pid}:${NONCE}` }, tmp)).toThrow(/no owner marker/);
    }
    const forged = callersFolder(PEERS_ROOT_PREFIX);
    writeFileSync(path.join(forged.root, PEERS_OWNER_FILE), `${process.pid}:${'f'.repeat(32)}`);
    expect(() => peersDirs({ [PEERS_RUN_VARS.root]: forged.root, [PEERS_RUN_VARS.owner]: `${process.pid}:${NONCE}` }, tmp)).toThrow(/not this run's/);
    const plain = callersFolder();
    expect(() => peersDirs({ [PEERS_RUN_VARS.root]: plain.root, [PEERS_RUN_VARS.owner]: `${process.pid}:${NONCE}` }, tmp)).toThrow(/not a codev-peers-e2e-\* folder/);
    for (const folder of [unmarked, forged, plain]) expect(existsSync(folder.keep)).toBe(true);
  });

  it('refuses an environment that records only one of the two, or an owner that is not <pid>:<nonce>', () => {
    expect(() => peersDirs({ [PEERS_RUN_VARS.root]: '/tmp/x' })).toThrow(/Only one of/);
    expect(() => peersDirs({ [PEERS_RUN_VARS.owner]: `1:${NONCE}` })).toThrow(/Only one of/);
    expect(() => peersDirs({ [PEERS_RUN_VARS.root]: '/tmp/x', [PEERS_RUN_VARS.owner]: 'me' })).toThrow(/does not read as/);
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
  it('removes exactly the run folder this process made, and leaves none of its directories', () => {
    const env: NodeJS.ProcessEnv = {};
    const { dirs } = peersDirs(env);
    const sibling = scratchDir();
    const removed = removePeersDirs(env);
    expect(removed).toEqual([path.dirname(dirs.agentFarm)]);
    for (const dir of [...Object.values(dirs), ...removed]) expect(existsSync(dir)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(recordedPeersRun(env)).toBeNull();
  });

  it('refuses, removing nothing, a run another process made, even its own child', () => {
    const env: NodeJS.ProcessEnv = {};
    const { dirs } = peersDirs(env);
    expect(() => removePeersDirs(env, liveDirs(), tmpdir(), OTHER_PID)).toThrow(/made by process \d+, not this one/);
    for (const dir of Object.values(dirs)) expect(existsSync(dir)).toBe(true);
    removePeersDirs(env);
  });

  it('refuses, removing nothing, a folder this config did not make', () => {
    const tmp = realpathSync(tmpdir());
    const unmarked = callersFolder(PEERS_ROOT_PREFIX);
    expect(() => removePeersDirs({ [PEERS_RUN_VARS.root]: unmarked.root, [PEERS_RUN_VARS.owner]: `${process.pid}:${NONCE}` }, liveDirs(), tmp)).toThrow(/no owner marker/);
    const nested = path.join(scratchDir(), `${PEERS_ROOT_PREFIX}deeper`);
    mkdirSync(nested);
    writeFileSync(path.join(nested, PEERS_OWNER_FILE), `${process.pid}:${NONCE}`);
    expect(() => removePeersDirs({ [PEERS_RUN_VARS.root]: nested, [PEERS_RUN_VARS.owner]: `${process.pid}:${NONCE}` }, liveDirs(), tmp)).toThrow(/directly under the system temp directory/);
    expect(() => removePeersDirs({ [PEERS_RUN_VARS.root]: liveDirs().agentFarm, [PEERS_RUN_VARS.owner]: `${process.pid}:${NONCE}` })).toThrow();
    expect(existsSync(unmarked.keep)).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });
});
