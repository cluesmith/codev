/**
 * The directories the Peers suites' throwaway Tower uses (Spec 1967, plan phase 12), and the
 * check that keeps them apart from a live Tower.
 *
 * `playwright.peers.config.ts` makes them and checks them before its Tower starts;
 * `peers-teardown.ts` checks them again and removes them.
 *
 * **One run folder, owned.** Playwright's main process makes one new folder under the system
 * temp directory, holding the three directories and an owner marker written by exclusive create:
 * the process's pid and a random nonce. The folder and the marker's text are recorded in this
 * module's environment variables, because the config is evaluated again in every worker, which
 * inherits them.
 *
 * Who reuses it: the same process evaluating the config again, and a Playwright worker whose
 * parent made it, each only when the marker matches. A worker is told apart from the main process
 * by what Playwright gives it before the config is evaluated: an IPC channel to its parent (it is
 * forked) and `TEST_WORKER_INDEX` (`processHost.js`, `workerMain.js`, Playwright 1.59). The main
 * process, started from a shell, has no channel, so it never adopts a recorded run, whoever the
 * values name as its maker: it makes a folder of its own and leaves theirs untouched. A worker
 * that finds no run made by its parent fails rather than making one. Removal happens only in the
 * process that made the folder, after the marker and path checks, so a folder this run did not
 * make is never removed.
 *
 * Free of any `@playwright/test` import, so the unit test loads it on its own.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** Where the run records its folder and its owner marker's text. */
export const PEERS_RUN_VARS = {
  root: 'CODEV_PEERS_E2E_ROOT',
  owner: 'CODEV_PEERS_E2E_OWNER',
} as const;

/** The run folder's name begins with this, directly under the system temp directory. */
export const PEERS_ROOT_PREFIX = 'codev-peers-e2e-';

/** The owner marker inside the run folder. */
export const PEERS_OWNER_FILE = '.owner';

/** The three directories inside the run folder, by name. */
const SUBDIRS = { agentFarm: 'agent-farm', socket: 'socket', home: 'home' } as const;

export type PeersDirName = keyof typeof SUBDIRS;

/** The throwaway Tower's state directory (its database and key), its socket directory and its `HOME`. */
export type PeersDirs = Record<PeersDirName, string>;

const DIR_NAMES = Object.keys(SUBDIRS) as PeersDirName[];

/** The process asking: its own pid, its parent's, and whether it is a Playwright worker (whose parent is the main process). */
export interface PeersProcess {
  pid: number;
  ppid: number;
  isWorker: boolean;
}

function thisProcess(): PeersProcess {
  // Forked with an IPC channel and given its index before it evaluates the config; a process
  // started from a shell has no channel.
  const isWorker = process.env.TEST_WORKER_INDEX !== undefined && typeof process.send === 'function';
  return { pid: process.pid, ppid: process.ppid, isWorker };
}

/** A run as the environment records it. */
export interface PeersRun {
  root: string;
  owner: string;
  ownerPid: number;
}

/** What the throwaway Tower must never be given: a live Tower's directories, and the real home. */
export interface LiveDirs {
  agentFarm: string;
  socket: string;
  home: string;
}

/** The live Tower's default directories under a home: `~/.agent-farm` and `~/.codev/run`. */
export function liveDirs(home: string = homedir()): LiveDirs {
  return { agentFarm: path.join(home, '.agent-farm'), socket: path.join(home, '.codev', 'run'), home };
}

/** A path with its symlinks resolved as far as it exists, so two spellings of one place compare equal. */
function resolvedPath(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...rest);
}

/** Is `child` strictly inside `parent`? */
function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Refuse a directory the throwaway Tower may not use, and return it resolved when it may. It
 * must be under the system temp directory, and must not be or contain the live agent-farm
 * directory (which holds the live `global.db`), the default socket directory or the real home.
 */
export function checkPeersDir(dir: string, live: LiveDirs = liveDirs(), tmp: string = tmpdir()): string {
  const real = resolvedPath(dir);
  const tmpReal = resolvedPath(tmp);
  if (!isInside(real, tmpReal)) {
    throw new Error(`${dir} is not under the system temp directory (${tmpReal}): the Peers suites use throwaway directories only.`);
  }
  const guarded: Array<[string, string]> = [
    ['the live agent-farm directory', live.agentFarm],
    ['the default shellper socket directory', live.socket],
    ['the real home', live.home],
  ];
  for (const [what, livePath] of guarded) {
    const liveReal = resolvedPath(livePath);
    if (real === liveReal || isInside(liveReal, real)) {
      throw new Error(`${dir} is or contains ${what} (${liveReal}): the Peers suites never use a live Tower's files.`);
    }
  }
  return real;
}

/** The run the environment records; `null` when it records none. One variable without the other is refused. */
export function recordedPeersRun(env: NodeJS.ProcessEnv = process.env): PeersRun | null {
  const root = env[PEERS_RUN_VARS.root];
  const owner = env[PEERS_RUN_VARS.owner];
  if (!root && !owner) return null;
  if (!root || !owner) {
    throw new Error(`Only one of ${PEERS_RUN_VARS.root} and ${PEERS_RUN_VARS.owner} is set; the config sets both itself.`);
  }
  const match = /^([1-9][0-9]*):[0-9a-f]{32}$/.exec(owner);
  if (!match) throw new Error(`${PEERS_RUN_VARS.owner} does not read as <pid>:<nonce>; the config sets it itself.`);
  return { root, owner, ownerPid: Number(match[1]) };
}

function dirsUnder(root: string): PeersDirs {
  return Object.fromEntries(DIR_NAMES.map((name) => [name, path.join(root, SUBDIRS[name])])) as PeersDirs;
}

/**
 * Confirm a recorded run folder is one this module made: directly under the system temp
 * directory, named with the run prefix, and holding an owner marker whose text is the recorded
 * one. Returns the folder resolved.
 */
function confirmMade(run: PeersRun, tmp: string): string {
  const real = resolvedPath(run.root);
  if (path.dirname(real) !== resolvedPath(tmp) || !path.basename(real).startsWith(PEERS_ROOT_PREFIX)) {
    throw new Error(`${run.root} is not a ${PEERS_ROOT_PREFIX}* folder directly under the system temp directory: not one this config made.`);
  }
  let marker: string;
  try {
    marker = readFileSync(path.join(real, PEERS_OWNER_FILE), 'utf-8');
  } catch {
    throw new Error(`${run.root} has no owner marker: not a folder this config made.`);
  }
  if (marker !== run.owner) throw new Error(`${run.root}'s owner marker is not this run's: not a folder this config made.`);
  return real;
}

/**
 * The run's directories. A run recorded by this process (the config evaluated again), or, in a
 * Playwright worker, by its parent, is reused once its marker is confirmed; a worker that finds no
 * run made by its parent is refused. The main process otherwise makes a new run folder and records
 * it, replacing any values it inherited and leaving whatever they name untouched.
 */
export function peersDirs(
  env: NodeJS.ProcessEnv = process.env,
  tmp: string = tmpdir(),
  proc: PeersProcess = thisProcess(),
): { dirs: PeersDirs; created: boolean } {
  const recorded = recordedPeersRun(env);
  if (recorded !== null && recorded.ownerPid === proc.pid) {
    return { dirs: dirsUnder(confirmMade(recorded, tmp)), created: false };
  }
  if (proc.isWorker) {
    if (recorded === null || recorded.ownerPid !== proc.ppid) {
      throw new Error('A Playwright worker found no Peers run made by its parent: the main process makes the run before any worker starts.');
    }
    return { dirs: dirsUnder(confirmMade(recorded, tmp)), created: false };
  }
  const root = mkdtempSync(path.join(realpathSync(tmp), PEERS_ROOT_PREFIX));
  const owner = `${proc.pid}:${randomBytes(16).toString('hex')}`;
  writeFileSync(path.join(root, PEERS_OWNER_FILE), owner, { flag: 'wx', mode: 0o600 });
  for (const name of DIR_NAMES) mkdirSync(path.join(root, SUBDIRS[name]));
  env[PEERS_RUN_VARS.root] = root;
  env[PEERS_RUN_VARS.owner] = owner;
  return { dirs: dirsUnder(root), created: true };
}

/**
 * The directories of the run this process made; `null` when none is recorded. A run recorded by
 * another process, or whose folder this module did not make, is refused.
 */
export function ownedPeersDirs(env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir(), pid: number = process.pid): PeersDirs | null {
  const run = recordedPeersRun(env);
  if (run === null) return null;
  if (run.ownerPid !== pid) {
    throw new Error(`The recorded Peers run was made by process ${run.ownerPid}, not this one (${pid}): it is left in place.`);
  }
  return dirsUnder(confirmMade(run, tmp));
}

/**
 * Remove the run folder this process made, its directories checked again first, and forget it.
 * Returns what was removed. Anything not provably this run's is refused and left in place.
 */
export function removePeersDirs(
  env: NodeJS.ProcessEnv = process.env,
  live: LiveDirs = liveDirs(),
  tmp: string = tmpdir(),
  pid: number = process.pid,
): string[] {
  const dirs = ownedPeersDirs(env, tmp, pid);
  if (dirs === null) return [];
  for (const name of DIR_NAMES) checkPeersDir(dirs[name], live, tmp);
  const root = checkPeersDir(path.dirname(dirs.agentFarm), live, tmp);
  rmSync(root, { recursive: true, force: true });
  delete env[PEERS_RUN_VARS.root];
  delete env[PEERS_RUN_VARS.owner];
  return [root];
}
