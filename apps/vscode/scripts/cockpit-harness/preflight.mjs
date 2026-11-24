// Pre-flight gates for the cockpit harness. Each gate throws a Refusal naming itself; the harness
// runs gates 1 and 2 before it creates anything, and stops (tearing down what it started) on any
// later refusal. Gate numbers match the plan's *Verification harness → Pre-flight* list.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listenerPids, openFiles, run } from './procs.mjs';

export const OWNER_TOWER_PORT = 4100;
export const REFUSAL_EXIT_CODE = 2;
/** macOS sun_path is 104 bytes including the NUL. */
export const MAX_SOCKET_PATH = 103;
/** The longest name Tower gives a shellper socket: `shellper-<uuid>.sock`. */
export const SHELLPER_SOCKET_NAME_LENGTH = 'shellper-00000000-0000-0000-0000-000000000000.sock'.length;

export class Refusal extends Error {
  constructor(gate, message) {
    super(`pre-flight gate ${gate} refused: ${message}`);
    this.gate = gate;
  }
}

/**
 * The real path of `p`, even when `p` (or its tail) does not exist yet: the longest existing
 * ancestor is resolved and the rest appended, so a symlinked ancestor cannot hide where a
 * not-yet-created directory will land.
 */
export function realpathLoose(p) {
  const abs = path.resolve(p);
  let head = abs;
  const tail = [];
  while (!fs.existsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  return path.join(fs.realpathSync(head), ...tail);
}

/** True when `child` is `parent` or inside it (both already real paths). */
export function isWithin(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Gate 1: the port is set, numeric, not the owner's Tower, and nothing listens on it. */
export function gatePort(label, raw) {
  if (raw === undefined || raw === '') throw new Refusal(1, `${label} is not set`);
  if (!/^\d+$/.test(String(raw))) throw new Refusal(1, `${label}=${raw} is not numeric`);
  const port = Number(raw);
  if (port === OWNER_TOWER_PORT) throw new Refusal(1, `${label}=${port} is the owner's Tower port`);
  if (port < 1024 || port > 65535) throw new Refusal(1, `${label}=${port} is outside 1024-65535`);
  const listeners = listenerPids(port);
  if (listeners.length) throw new Refusal(1, `${label}=${port} already has a listener (pid ${listeners.join(', ')})`);
  return port;
}

/**
 * Gate 2: the agent-farm dir and the shellper socket dir resolve under the session scratchpad and
 * are not the owner's `~/.agent-farm` or `~/.codev/run`; and a shellper socket path fits the
 * platform's Unix-socket limit when addressed through `socketDir` as given.
 *
 * `socketLinkTarget` is set when the harness is about to create `socketDir` as a short symlink:
 * the link must not exist yet, and its target is what has to resolve under the scratchpad.
 */
export function gateDirs({ scratch, agentFarmDir, socketDir, socketLinkTarget }) {
  const home = fs.realpathSync(os.homedir());
  const ownerDirs = [path.join(home, '.agent-farm'), path.join(home, '.codev')];
  const scratchReal = fs.realpathSync(scratch);
  if (socketLinkTarget && fs.existsSync(socketDir)) throw new Refusal(2, `socket link ${socketDir} already exists`);
  for (const [label, dir] of [['CODEV_AGENT_FARM_DIR', agentFarmDir], ['SHELLPER_SOCKET_DIR', socketDir]]) {
    if (!dir) throw new Refusal(2, `${label} is not set`);
    const real = realpathLoose(label === 'SHELLPER_SOCKET_DIR' && socketLinkTarget ? socketLinkTarget : dir);
    for (const owner of ownerDirs) {
      if (isWithin(real, owner)) throw new Refusal(2, `${label}=${dir} resolves into the owner's ${owner}`);
    }
    if (!isWithin(real, scratchReal) || real === scratchReal) {
      throw new Refusal(2, `${label}=${dir} resolves to ${real}, outside the scratchpad ${scratchReal}`);
    }
  }
  const longest = path.join(socketDir, 'x').length - 1 + SHELLPER_SOCKET_NAME_LENGTH;
  if (longest > MAX_SOCKET_PATH) {
    throw new Refusal(2, `SHELLPER_SOCKET_DIR=${socketDir} gives ${longest}-byte socket paths (limit ${MAX_SOCKET_PATH})`);
  }
}

/** The `.db` files `pid` has open (WAL and SHM companions excluded). */
export function openDbFiles(pid) {
  return [...new Set(openFiles(pid).filter((n) => n.endsWith('.db')))];
}

/**
 * Gate 3: the fixture driver and the isolated Tower agree on the database file. `driver` is what
 * the driver resolved in its own environment, from the branch's built dist.
 */
export function gateDbAgreement({ driver, agentFarmDir, towerPid }) {
  const expectedDir = realpathLoose(agentFarmDir);
  if (realpathLoose(driver.agentFarmDir) !== expectedDir) {
    throw new Refusal(3, `driver AGENT_FARM_DIR ${driver.agentFarmDir} is not the isolated ${expectedDir}`);
  }
  const towerDbs = openDbFiles(towerPid).map(realpathLoose);
  if (towerDbs.length !== 1) {
    throw new Refusal(3, `isolated Tower (pid ${towerPid}) has ${towerDbs.length} .db files open: ${towerDbs.join(', ') || 'none'}`);
  }
  const driverDb = realpathLoose(driver.globalDbPath);
  if (driverDb !== towerDbs[0]) {
    throw new Refusal(3, `driver would write ${driverDb}; the isolated Tower opened ${towerDbs[0]}`);
  }
  return towerDbs[0];
}

/**
 * Gate 4: the only listener on `port` is the PID the harness spawned, and the Tower there answers
 * with the isolated key (and rejects any other key on a key-gated route).
 */
export async function gateListener({ port, pid, key }) {
  const listeners = listenerPids(port);
  if (listeners.length !== 1 || listeners[0] !== pid) {
    throw new Refusal(4, `listener on ${port} is pid ${listeners.join(', ') || 'none'}, not the harness's ${pid}`);
  }
  const base = `http://127.0.0.1:${port}`;
  const version = await fetch(`${base}/api/version`, { headers: { 'codev-tower-key': key } });
  if (!version.ok) throw new Refusal(4, `GET /api/version with the isolated key answered ${version.status}`);
  const body = await version.json();
  if (typeof body.version !== 'string') throw new Refusal(4, `GET /api/version body has no version: ${JSON.stringify(body)}`);
  const keyed = await fetch(`${base}/api/workspaces`, { headers: { 'codev-tower-key': key } });
  if (!keyed.ok) throw new Refusal(4, `GET /api/workspaces with the isolated key answered ${keyed.status}`);
  await keyed.body?.cancel();
  const wrong = await fetch(`${base}/api/workspaces`, { headers: { 'codev-tower-key': 'not-the-isolated-key' } });
  await wrong.body?.cancel();
  if (wrong.status !== 401) throw new Refusal(4, `GET /api/workspaces with a wrong key answered ${wrong.status}, not 401`);
  return body.version;
}

/**
 * Gate 5: the serve-web profile pins the extension to the isolated Tower with auto-start off, and
 * `afx`, `porch` and `codev` resolve to the recording stubs in the serve-web environment.
 */
export function gateVscodeProfile({ settingsPath, port, env, stubsDir }) {
  if (!fs.existsSync(settingsPath)) throw new Refusal(5, `${settingsPath} does not exist`);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  if (settings['codev.towerPort'] !== port) {
    throw new Refusal(5, `codev.towerPort is ${settings['codev.towerPort']}, not ${port}`);
  }
  if (settings['codev.autoStartTower'] !== false) {
    throw new Refusal(5, `codev.autoStartTower is ${settings['codev.autoStartTower']}, not false`);
  }
  for (const tool of ['afx', 'porch', 'codev']) {
    const r = run('/bin/sh', ['-c', `command -v ${tool}`], { env });
    const resolved = r.stdout.trim();
    if (r.status !== 0 || path.dirname(resolved) !== stubsDir) {
      throw new Refusal(5, `${tool} resolves to '${resolved || 'nothing'}', not the stub in ${stubsDir}`);
    }
  }
}

/**
 * Gate 6: the isolated Tower's overview for `workspace` lists exactly the expected builders (by
 * role id, with their `spawnedByArchitect`) and the expected architects.
 */
/**
 * Gate 6, fleet half: Tower's `/api/workspaces` lists each `{ path, active }` exactly so. The
 * Tower and Cockpit views list only what this route returns, and Tower drops workspaces under temp
 * roots, so a fixture it hides would render an empty fleet rather than fail.
 */
export async function gateFleet({ port, key, workspaces }) {
  const res = await fetch(`http://127.0.0.1:${port}/api/workspaces`, { headers: { 'codev-tower-key': key } });
  if (!res.ok) throw new Refusal(6, `GET /api/workspaces answered ${res.status}`);
  const listed = new Map(((await res.json()).workspaces ?? []).map((w) => [w.path, w.active]));
  for (const want of workspaces) {
    if (!listed.has(want.path)) {
      throw new Refusal(6, `/api/workspaces does not list ${want.path} (it lists ${JSON.stringify([...listed.keys()])})`);
    }
    if (listed.get(want.path) !== want.active) {
      throw new Refusal(6, `/api/workspaces lists ${want.path} as ${listed.get(want.path) ? 'active' : 'dormant'}, expected ${want.active ? 'active' : 'dormant'}`);
    }
  }
}

export async function gateOverview({ port, key, workspace, builders, architects }) {
  const url = `http://127.0.0.1:${port}/api/overview?workspace=${encodeURIComponent(workspace)}`;
  const res = await fetch(url, { headers: { 'codev-tower-key': key } });
  if (!res.ok) throw new Refusal(6, `GET /api/overview for ${workspace} answered ${res.status}`);
  const data = await res.json();
  const got = (data.builders ?? [])
    .map((b) => ({ roleId: b.roleId, spawnedByArchitect: b.spawnedByArchitect }))
    .sort((a, b) => a.roleId.localeCompare(b.roleId));
  const want = [...builders].sort((a, b) => a.roleId.localeCompare(b.roleId));
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Refusal(6, `overview builders for ${workspace} are ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  const gotArchitects = (data.architects ?? []).map((a) => a.name).sort();
  if (JSON.stringify(gotArchitects) !== JSON.stringify([...architects].sort())) {
    throw new Refusal(6, `overview architects for ${workspace} are ${JSON.stringify(gotArchitects)}, expected ${JSON.stringify(architects)}`);
  }
  return data;
}
