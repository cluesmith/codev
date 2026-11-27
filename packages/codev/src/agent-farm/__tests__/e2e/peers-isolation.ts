/**
 * The directories the Peers suites' throwaway Tower uses (Spec 1967, plan phase 12), and the
 * check that keeps them apart from a live Tower.
 *
 * `playwright.peers.config.ts` makes them and checks them before its Tower starts;
 * `peers-teardown.ts` checks them again and removes them. The config is evaluated again in
 * every Playwright worker, so the directories are recorded in this module's own environment
 * variables the first time: the main process makes them, and each worker, which inherits the
 * variables, finds the same ones.
 *
 * Free of any `@playwright/test` import, so the unit test loads it on its own.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** Where the run records its directories, one variable each. */
export const PEERS_DIR_VARS = {
  agentFarm: 'CODEV_PEERS_E2E_AGENT_FARM_DIR',
  socket: 'CODEV_PEERS_E2E_SOCKET_DIR',
  home: 'CODEV_PEERS_E2E_HOME',
} as const;

export type PeersDirName = keyof typeof PEERS_DIR_VARS;

/** The throwaway Tower's state directory (its database and key), its socket directory and its `HOME`. */
export type PeersDirs = Record<PeersDirName, string>;

const DIR_NAMES = Object.keys(PEERS_DIR_VARS) as PeersDirName[];

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

/** The directories the environment records; `null` when it records none. Some but not all is refused. */
export function recordedPeersDirs(env: NodeJS.ProcessEnv = process.env): PeersDirs | null {
  const recorded = DIR_NAMES.filter((name) => env[PEERS_DIR_VARS[name]]);
  if (recorded.length === 0) return null;
  if (recorded.length !== DIR_NAMES.length) {
    throw new Error(`Only some of ${DIR_NAMES.map((n) => PEERS_DIR_VARS[n]).join(', ')} are set; set none, and the config makes all three.`);
  }
  return Object.fromEntries(DIR_NAMES.map((name) => [name, env[PEERS_DIR_VARS[name]] as string])) as PeersDirs;
}

/**
 * The run's directories: those the environment already records (a worker evaluating the config
 * again), else three new ones under the system temp directory, recorded for the workers.
 */
export function peersDirs(env: NodeJS.ProcessEnv = process.env, tmp: string = tmpdir()): { dirs: PeersDirs; created: boolean } {
  const recorded = recordedPeersDirs(env);
  if (recorded !== null) return { dirs: recorded, created: false };
  const base = realpathSync(tmp);
  const dirs = {} as PeersDirs;
  for (const name of DIR_NAMES) {
    dirs[name] = mkdtempSync(path.join(base, `codev-peers-e2e-${name}-`));
    env[PEERS_DIR_VARS[name]] = dirs[name];
  }
  return { dirs, created: true };
}

/** Remove the directories the environment records, each checked again first. Returns what was removed. */
export function removePeersDirs(env: NodeJS.ProcessEnv = process.env, live: LiveDirs = liveDirs(), tmp: string = tmpdir()): string[] {
  const dirs = recordedPeersDirs(env);
  if (dirs === null) return [];
  const checked = DIR_NAMES.map((name) => checkPeersDir(dirs[name], live, tmp));
  for (const dir of checked) rmSync(dir, { recursive: true, force: true });
  return checked;
}
