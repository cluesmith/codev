#!/usr/bin/env node
// Cockpit verification harness: an isolated Tower + an isolated VS Code (serve-web, or the VS Code
// Server binary Tower's IDE support runs) with the branch's vsix installed, for rendered
// verification that never touches the owner's Tower (:4100), agent-farm dir, socket dir or IDE.
// See README.md.
//
//   node harness.mjs build-vsix         build the branch vsix into the harness root
//   node harness.mjs start              pre-flight, isolated Tower, `empty` fixture, VS Code, tripwire
//   node harness.mjs seed <scenario>    seed a fixture scenario, then assert gate 6 on its overview
//   node harness.mjs check              re-run gates 3-5 and prove the extension runs against the Tower
//   node harness.mjs stop               kill only the harness's own PIDs; remove the runtime dirs
//   node harness.mjs tower-down|tower-up  stop / restart the isolated Tower only (reconnect check)
//   node harness.mjs vscode-restart     restart the isolated VS Code only (no lingering extension hosts);
//                                       with COCKPIT_PRE_COCKPIT=1 the install has no Cockpit container
//   node harness.mjs verify <script>    run a scripted Cockpit verification (cockpit-verify.mjs)
//   node harness.mjs selftest           prove every refusal and the tripwire
//
// Inputs (environment): COCKPIT_SCRATCH (the session scratchpad), COCKPIT_TOWER_PORT,
// COCKPIT_WEB_PORT; optional CODEV_AGENT_FARM_DIR / SHELLPER_SOCKET_DIR overrides (still gated);
// COCKPIT_VSCODE=serve-web (default) | ide-server, the latter with COCKPIT_IDE_SERVER_BIN;
// COCKPIT_BASELINE, a snapshot file `verify dashboard` compares against; COCKPIT_PRE_COCKPIT=1 on
// vscode-restart, for `verify profile-seed` only.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OWNER_TOWER_PORT, REFUSAL_EXIT_CODE, Refusal, gateDbAgreement, gateDirs, gateFleet, gateListener, gateOverview,
  gatePort, gateVscodeProfile, isWithin,
} from './preflight.mjs';
import { descendants, isAlive, killPids, listenerPids, processTable, run, tcpOn, unixSocketHolders } from './procs.mjs';
import { CODEV_DIST, REPO, SCENARIOS, expectedOverview } from './fixtures.mjs';
import { TRIPWIRE_EXIT_CODE, sample } from './tripwire.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUBS = path.join(HERE, 'stubs');
const VSCODE_APP = path.join(REPO, 'apps/vscode');
const TOWER_SERVER = path.join(CODEV_DIST, 'agent-farm/servers/tower-server.js');
const CODE_BIN = process.env.COCKPIT_CODE_BIN || '/usr/local/bin/code';
/** How the isolated VS Code is served: `serve-web` (default) or `ide-server`. */
const VSCODE_MODES = ['serve-web', 'ide-server'];
/** The base path Tower's IDE support serves under; ide-server mode mirrors it. */
const IDE_BASE_PATH = '/ide';
const REAL_HOME = os.homedir();
const PLAYWRIGHT_BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(REAL_HOME, 'Library/Caches/ms-playwright');
/** The vsix's inputs: what has to be unchanged since build-vsix for the install to be "the branch's". */
const VSIX_INPUTS = ['apps/vscode', ':(exclude)apps/vscode/scripts/cockpit-harness', 'packages', 'pnpm-lock.yaml'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Layout and environment
// ---------------------------------------------------------------------------------------------

/** Every path the harness owns, under `<scratch>/cockpit-harness`. */
function layout(scratch) {
  const root = path.join(scratch, 'cockpit-harness');
  const vscode = path.join(root, 'vscode');
  return {
    scratch, root, vscode,
    af: path.join(root, 'af'),
    run: path.join(root, 'run'),
    home: path.join(root, 'home'),
    towerTmp: path.join(root, 'tmp'),
    pids: path.join(root, 'pids'),
    logs: path.join(root, 'logs'),
    shots: path.join(root, 'shots'),
    vscodeCli: path.join(root, 'cache', 'vscode-cli'),
    vscodeServer: path.join(vscode, 'server'),
    vscodeUser: path.join(vscode, 'user'),
    vscodeExt: path.join(vscode, 'ext'),
    vscodeToken: path.join(vscode, 'connection-token'),
    browserProfile: path.join(root, 'browser-profile'),
    state: path.join(root, 'state.json'),
    tripMarker: path.join(root, 'tripwire.tripped'),
    stubLog: path.join(root, 'logs', 'stub-calls.jsonl'),
    requestLog: path.join(root, 'logs', 'tower-requests.jsonl'),
    vsix: path.join(root, 'codev-vscode.vsix'),
    vsixMeta: path.join(root, 'codev-vscode.vsix.json'),
  };
}

/**
 * Runtime dirs `stop` removes (plus the fixtures dir, recorded in the state). Logs, screenshots,
 * the vsix and the VS Code server cache stay.
 */
const RUNTIME_DIRS = ['af', 'run', 'home', 'towerTmp', 'pids', 'vscode', 'browserProfile'];

/** The basename prefix of the fixtures dir `start` creates (`mkdtemp`) under the per-user temp dir. */
const FIXTURES_PREFIX = 'cockpit-fixtures-';
/** The marker `start` writes in the fixtures dir it creates, holding that run's token. */
const FIXTURES_MARKER = '.cockpit-harness-fixtures';

/**
 * Where the fixture workspaces live: a fresh dir under the real per-user temp dir, NOT the
 * scratchpad. Tower's `/api/workspaces` drops every workspace under `/tmp`, `/private/tmp` or its
 * own `os.tmpdir()` (`isTempDirectory`, tower-instances.ts), and the session scratchpad is under
 * `/private/tmp`, so fixtures there never reach the fleet the Tower and Cockpit views list. The
 * isolated Tower's own TMPDIR points into the scratchpad (`towerTmp`), so this dir is not its temp
 * dir. Refuses a parent that the Tower would still hide, or that lies in the owner's dirs.
 */
function fixturesParent() {
  const parent = fs.realpathSync(os.tmpdir());
  if (['/tmp', '/private/tmp'].some((t) => isWithin(parent, t))) {
    throw new Refusal(2, `the per-user temp dir ${parent} is under /tmp, where the isolated Tower hides workspaces; set TMPDIR to a per-user temp dir outside it`);
  }
  for (const owner of [path.join(REAL_HOME, '.agent-farm'), path.join(REAL_HOME, '.codev')]) {
    if (isWithin(parent, owner)) throw new Refusal(2, `the fixtures parent ${parent} is inside the owner's ${owner}`);
  }
  return parent;
}

/** Create the fixtures dir and its marker; returns the state fields that record them. */
function createFixturesDir() {
  const dir = fs.mkdtempSync(path.join(fixturesParent(), FIXTURES_PREFIX));
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, FIXTURES_MARKER), `${token}\n`, { flag: 'wx' });
  return { fixturesDir: dir, fixturesToken: token };
}

/**
 * Why the recorded fixtures dir is not one this harness created, or null when it is. The dir lies
 * outside the scratchpad, so a path read from the state is trusted only when ALL hold:
 * - it is a real directory, not a symlink, and its realpath is the recorded path;
 * - the realpath's parent is the per-user temp dir (`fixturesParent`);
 * - its basename is `cockpit-fixtures-*`;
 * - it holds the marker `start` wrote, with this run's recorded token.
 */
function fixturesDirProblem(st) {
  const dir = st?.fixturesDir;
  if (!dir) return 'no fixtures dir is recorded';
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return `${dir} does not exist`;
  if (stat.isSymbolicLink() || !stat.isDirectory()) return `${dir} is not a real directory`;
  const real = fs.realpathSync(dir);
  if (real !== dir) return `${dir} resolves to ${real}`;
  let parent;
  try {
    parent = fixturesParent();
  } catch (err) {
    return err.message;
  }
  if (path.dirname(real) !== parent) return `${real} is not directly under the per-user temp dir ${parent}`;
  if (!path.basename(real).startsWith(FIXTURES_PREFIX)) return `${real} is not named ${FIXTURES_PREFIX}*`;
  const marker = path.join(real, FIXTURES_MARKER);
  const markerStat = fs.lstatSync(marker, { throwIfNoEntry: false });
  if (!markerStat?.isFile()) return `${real} holds no ${FIXTURES_MARKER} marker`;
  if (!st.fixturesToken || fs.readFileSync(marker, 'utf-8').trim() !== st.fixturesToken) {
    return `${real}'s marker does not hold this run's token`;
  }
  return null;
}

/** The recorded fixtures dir, verified as this harness's before anything uses it. */
function fixturesDir(st) {
  const problem = fixturesDirProblem(st);
  if (problem) throw new Error(`the recorded fixtures dir is not the harness's: ${problem}`);
  return st.fixturesDir;
}

/**
 * Remove the recorded fixtures dir, only after `fixturesDirProblem` finds nothing wrong. Otherwise
 * it deletes nothing and returns the refusal.
 */
function removeFixturesDir(st) {
  const problem = fixturesDirProblem(st);
  if (problem) return `REFUSED to remove the fixtures dir, deleted nothing: ${problem}`;
  fs.rmSync(st.fixturesDir, { recursive: true, force: true });
  return null;
}

function scratchFromEnv() {
  const raw = process.env.COCKPIT_SCRATCH;
  if (!raw) throw new Refusal(2, 'COCKPIT_SCRATCH is not set');
  if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) throw new Refusal(2, `COCKPIT_SCRATCH=${raw} is not a directory`);
  const scratch = fs.realpathSync(raw);
  const tempRoots = ['/private/tmp', '/private/var/folders', fs.realpathSync(os.tmpdir())];
  if (!tempRoots.some((t) => isWithin(scratch, t))) throw new Refusal(2, `COCKPIT_SCRATCH=${scratch} is not under a temp root`);
  return scratch;
}

function codevVersion() {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'packages/codev/package.json'), 'utf-8')).version;
}

/**
 * A child environment built from an allowlist, never the caller's whole environment: no
 * CODEV_*, CLAUDE_CODE_*, VSCODE_*, NODE_ENV, AF_TEST_DB, BRIDGE_* or token variables leak in.
 * HOME is the harness's scratch home; the stubs come first on PATH.
 */
function childEnv(L, caller, extra = {}) {
  const env = {
    PATH: `${STUBS}:${process.env.PATH}`,
    HOME: L.home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR,
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    COCKPIT_STUB_LOG: L.stubLog,
    COCKPIT_STUB_CALLER: caller,
    COCKPIT_CODEV_VERSION: codevVersion(),
    ...extra,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return env;
}

function towerEnv(L, run) {
  return childEnv(L, 'tower', {
    CODEV_AGENT_FARM_DIR: run.agentFarmDir, SHELLPER_SOCKET_DIR: run.socketDir, COCKPIT_REQUEST_LOG: L.requestLog,
    // Its own temp dir, in the scratchpad: the fixtures dir must not be under it (see fixturesParent).
    TMPDIR: L.towerTmp,
  });
}

/** The isolated Tower's command line: the request log preloaded, then the dist's server. */
function towerArgs(runCfg) {
  return ['--require', path.join(HERE, 'request-log.cjs'), TOWER_SERVER, '-p', String(runCfg.towerPort)];
}

function driverEnv(L, run, st, extra = {}) {
  return childEnv(L, 'driver', {
    CODEV_AGENT_FARM_DIR: run.agentFarmDir,
    COCKPIT_EXPECT_AGENT_FARM_DIR: run.agentFarmDir,
    COCKPIT_TOWER_PORT: String(run.towerPort),
    COCKPIT_TOWER_PID: String(st.towerPid),
    COCKPIT_TOWER_KEY: readKey(run),
    COCKPIT_FIXTURES_DIR: fixturesDir(st),
    ...extra,
  });
}

function webEnv(L, run) {
  return childEnv(L, 'vscode', { CODEV_TOWER_KEY: readKey(run) });
}

function readKey(run) {
  const keyFile = path.join(run.agentFarmDir, 'local-key');
  if (!fs.existsSync(keyFile)) throw new Error(`the isolated Tower has not written ${keyFile}`);
  return fs.readFileSync(keyFile, 'utf-8').trim();
}

// ---------------------------------------------------------------------------------------------
// State and pid files
// ---------------------------------------------------------------------------------------------

function loadState(L) {
  if (!fs.existsSync(L.state)) throw new Error(`no harness recorded at ${L.state} (run start)`);
  return JSON.parse(fs.readFileSync(L.state, 'utf-8'));
}

function saveState(L, st) {
  fs.writeFileSync(L.state, `${JSON.stringify(st, null, 2)}\n`);
}

/** Record a launched process: the tripwire watches it and `stop` may kill it once `markers` match. */
function writePid(L, name, pid, markers) {
  fs.mkdirSync(L.pids, { recursive: true });
  fs.writeFileSync(path.join(L.pids, `${name}.json`), JSON.stringify({ pid, markers }));
}

function removePid(L, name) {
  fs.rmSync(path.join(L.pids, `${name}.json`), { force: true });
}

function readPidFiles(L) {
  if (!fs.existsSync(L.pids)) return [];
  return fs.readdirSync(L.pids).filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(L.pids, f), 'utf-8')) }));
}

/** Snapshot every live process the harness owns, so `stop` can find one even if its parent died. */
function recordKnownPids(L, st) {
  const { pids, table } = ownedPids(L, st);
  st.knownPids = [...pids].map((pid) => ({ pid, command: table.get(pid)?.command ?? '' }));
  saveState(L, st);
}

/** Every spelling under which a harness shellper socket can appear in lsof. */
function socketPrefixes(L, st) {
  const prefixes = [L.run];
  if (st?.socketDir) {
    prefixes.push(st.socketDir);
    if (st.socketDir.startsWith('/tmp/')) prefixes.push(`/private${st.socketDir}`);
  }
  return prefixes;
}

/**
 * The harness's live processes: pid-file roots whose command still carries their markers, the
 * shellpers (holders of a Unix socket in the harness's socket dir), previously recorded processes
 * whose command is unchanged, and all descendants. The calling CLI process is never included.
 */
function ownedPids(L, st) {
  const table = processTable();
  const roots = new Set();
  const skipped = [];
  for (const rec of readPidFiles(L)) {
    if (rec.name.startsWith('cli-')) continue;
    const cmd = table.get(rec.pid)?.command;
    if (cmd && rec.markers.every((m) => cmd.includes(m))) roots.add(rec.pid);
    else if (cmd) skipped.push(`${rec.name}: pid ${rec.pid} now runs '${cmd}'`);
  }
  if (st) for (const pid of unixSocketHolders(socketPrefixes(L, st))) roots.add(pid);
  for (const known of st?.knownPids ?? []) {
    if (table.get(known.pid)?.command === known.command) roots.add(known.pid);
  }
  const pids = descendants(roots, table);
  for (const pid of [process.pid, process.ppid]) pids.delete(pid);
  return { pids, table, skipped };
}

// ---------------------------------------------------------------------------------------------
// Process launch helpers
// ---------------------------------------------------------------------------------------------

function launch(L, name, cmd, args, { env, cwd, markers }) {
  fs.mkdirSync(L.logs, { recursive: true });
  const out = fs.openSync(path.join(L.logs, `${name}.log`), 'a');
  const child = spawn(cmd, args, { env, cwd, detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  child.unref();
  if (!child.pid) throw new Error(`failed to launch ${name}`);
  writePid(L, name, child.pid, markers);
  return child.pid;
}

async function waitForListener(port, owner, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(owner)) throw new Error(`${what} (pid ${owner}) exited before listening on ${port}`);
    if (listenerPids(port).length) return;
    await sleep(500);
  }
  throw new Error(`${what} did not listen on ${port} within ${timeoutMs / 1000}s`);
}

/** Run the fixture driver synchronously in the isolated environment. */
function runDriver(L, runCfg, st, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(HERE, 'fixtures.mjs'), ...args], {
    env: driverEnv(L, runCfg, st, extraEnv), cwd: L.home, encoding: 'utf-8', timeout: 180_000,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function probeDriver(L, runCfg, st) {
  const r = runDriver(L, runCfg, st, ['probe']);
  if (r.status !== 0) throw new Error(`fixture driver probe failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// ---------------------------------------------------------------------------------------------
// Planning (pure: gates 1 and 2 plus input checks, nothing created)
// ---------------------------------------------------------------------------------------------

function planRun({ needWeb }) {
  const scratch = scratchFromEnv();
  const L = layout(scratch);
  const towerPort = gatePort('COCKPIT_TOWER_PORT', process.env.COCKPIT_TOWER_PORT);
  let webPort = null;
  if (needWeb) {
    webPort = gatePort('COCKPIT_WEB_PORT', process.env.COCKPIT_WEB_PORT);
    if (webPort === towerPort) throw new Refusal(1, 'COCKPIT_WEB_PORT equals COCKPIT_TOWER_PORT');
  }
  const agentFarmDir = process.env.CODEV_AGENT_FARM_DIR || L.af;
  const socketLink = process.env.SHELLPER_SOCKET_DIR ? null : `/tmp/cckp-${crypto.randomBytes(4).toString('hex')}`;
  const socketDir = process.env.SHELLPER_SOCKET_DIR || socketLink;
  gateDirs({ scratch, agentFarmDir, socketDir, socketLinkTarget: socketLink ? L.run : undefined });
  if (fs.existsSync(L.state)) throw new Error(`a harness is already recorded at ${L.state}; run stop first`);
  if (!fs.existsSync(TOWER_SERVER)) throw new Error(`${TOWER_SERVER} is missing: build packages/codev first`);
  let vscodeMode = null;
  let ideServerBin = null;
  if (needWeb) {
    if (!fs.existsSync(L.vsix)) throw new Error(`no vsix at ${L.vsix}: run build-vsix first`);
    vscodeMode = process.env.COCKPIT_VSCODE || 'serve-web';
    if (!VSCODE_MODES.includes(vscodeMode)) throw new Error(`COCKPIT_VSCODE=${vscodeMode} is not one of ${VSCODE_MODES.join(', ')}`);
    if (vscodeMode === 'serve-web' && !fs.existsSync(CODE_BIN)) throw new Error(`no VS Code CLI at ${CODE_BIN} (set COCKPIT_CODE_BIN)`);
    if (vscodeMode === 'ide-server') {
      ideServerBin = process.env.COCKPIT_IDE_SERVER_BIN;
      if (!ideServerBin || !fs.existsSync(ideServerBin)) {
        throw new Error(`COCKPIT_VSCODE=ide-server needs COCKPIT_IDE_SERVER_BIN, the VS Code Server binary Tower's IDE support runs (got '${ideServerBin ?? ''}')`);
      }
    }
  }
  return { L, towerPort, webPort, agentFarmDir, socketDir, socketLink, vscodeMode, ideServerBin };
}

// ---------------------------------------------------------------------------------------------
// Bring-up
// ---------------------------------------------------------------------------------------------

/**
 * Create the state record and dirs, enrol this CLI process and start the tripwire, then the
 * isolated Tower; gates 2 (again), 4 and 3. The tripwire is up before anything the harness launches.
 */
async function bringUpTower(runCfg) {
  const { L } = runCfg;
  for (const dir of [L.root, L.af, L.run, L.home, L.towerTmp, L.pids, L.logs, L.shots]) fs.mkdirSync(dir, { recursive: true });
  const st = {
    ...createFixturesDir(),
    startedAt: new Date().toISOString(),
    towerPort: runCfg.towerPort, webPort: runCfg.webPort,
    agentFarmDir: runCfg.agentFarmDir, socketDir: runCfg.socketDir, socketLink: runCfg.socketLink,
    towerPid: null, webPid: null, tripwirePid: null, knownPids: [],
  };
  saveState(L, st);
  if (runCfg.socketLink) {
    fs.symlinkSync(L.run, runCfg.socketLink);
    gateDirs({ scratch: L.scratch, agentFarmDir: runCfg.agentFarmDir, socketDir: runCfg.socketDir });
  }
  writePid(L, `cli-${process.pid}`, process.pid, []);
  startTripwire(L, st);
  st.towerPid = launch(L, 'tower', process.execPath, towerArgs(runCfg), {
    env: towerEnv(L, runCfg), cwd: L.home, markers: ['tower-server.js', `-p ${runCfg.towerPort}`],
  });
  saveState(L, st);
  await waitForListener(runCfg.towerPort, st.towerPid, 30_000, 'isolated Tower');
  st.towerVersion = await gateListener({ port: runCfg.towerPort, pid: st.towerPid, key: readKey(runCfg) });
  st.globalDb = gateDbAgreement({ driver: probeDriver(L, runCfg, st), agentFarmDir: runCfg.agentFarmDir, towerPid: st.towerPid });
  saveState(L, st);
  return st;
}

/**
 * Make the installed extension's activity bar origin/main's: drop the `codev-cockpit` container and
 * its views from its package.json. A profile that uses this install is one that used Codev before
 * the Cockpit existed (`verify profile-seed`); `verify` runs nothing else against it.
 */
function stripCockpitContainer(dest) {
  const file = path.join(dest, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const c = pkg.contributes;
  c.viewsContainers.activitybar = c.viewsContainers.activitybar.filter((v) => v.id !== 'codev-cockpit');
  delete c.views['codev-cockpit'];
  const shown = spawnSync('git', ['show', 'origin/main:apps/vscode/package.json'], { cwd: REPO, encoding: 'utf-8' });
  if (shown.status !== 0) throw new Error(`git show origin/main:apps/vscode/package.json failed: ${shown.stderr}`);
  const main = JSON.parse(shown.stdout).contributes;
  if (JSON.stringify(c.viewsContainers) !== JSON.stringify(main.viewsContainers)) throw new Error('the stripped viewsContainers differ from origin/main\'s');
  if (JSON.stringify(Object.keys(c.views).sort()) !== JSON.stringify(Object.keys(main.views).sort())) throw new Error('the stripped view containers differ from origin/main\'s');
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** Unpack the vsix as an installed extension (as the spike installed its extension). */
function installVsix(L) {
  const pkg = JSON.parse(fs.readFileSync(path.join(VSCODE_APP, 'package.json'), 'utf-8'));
  const id = `${pkg.publisher}.${pkg.name}`;
  const folder = `${id}-${pkg.version}`;
  const dest = path.join(L.vscodeExt, folder);
  const unpack = path.join(L.vscodeExt, '.unpack');
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.mkdirSync(unpack, { recursive: true });
  const r = run('unzip', ['-q', L.vsix, 'extension/*', '-d', unpack]);
  if (r.status !== 0) throw new Error(`unzip ${L.vsix} failed: ${r.stderr}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(path.join(unpack, 'extension'), dest);
  fs.rmSync(unpack, { recursive: true, force: true });
  const installed = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf-8'));
  if (installed.version !== pkg.version || installed.name !== pkg.name) {
    throw new Error(`the vsix holds ${installed.name}@${installed.version}, not the branch's ${pkg.name}@${pkg.version}`);
  }
  const entry = { identifier: { id }, version: pkg.version, location: { $mid: 1, path: dest, scheme: 'file' }, relativeLocation: folder };
  fs.writeFileSync(path.join(L.vscodeExt, 'extensions.json'), JSON.stringify([entry]));
  return { id, version: pkg.version, dest, vsixSha256: sha256(L.vsix) };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeMachineSettings(L, towerPort) {
  const dir = path.join(L.vscodeUser, 'Machine');
  fs.mkdirSync(dir, { recursive: true });
  const settings = { 'codev.towerPort': towerPort, 'codev.autoStartTower': false, 'files.autoSave': 'off' };
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return file;
}

/**
 * Start the isolated VS Code. `serve-web` runs `code serve-web`. `ide-server` is the plan's
 * alternative for when serve-web cannot run: it launches the VS Code Server binary Tower's IDE
 * support uses, directly (never through any Tower's /api/ide), with the flags ide-server.ts passes
 * (--host, --port, --server-base-path, --connection-token-file, --extensions-dir) plus the server
 * and user data dirs, all in the scratchpad. The mode is chosen explicitly; a serve-web failure
 * fails the start rather than switching modes on its own.
 */
async function bringUpVscode(runCfg, st) {
  const { L } = runCfg;
  st.vscodeMode = runCfg.vscodeMode;
  st.extension = installVsix(L);
  if (runCfg.preCockpit) {
    stripCockpitContainer(st.extension.dest);
    st.extension.preCockpit = true;
  }
  st.settingsPath = writeMachineSettings(L, runCfg.towerPort);
  const env = webEnv(L, runCfg);
  gateVscodeProfile({ settingsPath: st.settingsPath, port: runCfg.towerPort, env, stubsDir: STUBS });
  if (runCfg.vscodeMode === 'serve-web') {
    fs.mkdirSync(L.vscodeCli, { recursive: true });
    st.webPid = launch(L, 'vscode', CODE_BIN, [
      'serve-web', '--host', '127.0.0.1', '--port', String(runCfg.webPort),
      '--without-connection-token', '--accept-server-license-terms',
      '--cli-data-dir', L.vscodeCli, '--server-data-dir', L.vscodeServer,
      '--user-data-dir', L.vscodeUser, '--extensions-dir', L.vscodeExt,
    ], { env, cwd: L.home, markers: ['serve-web', `--port ${runCfg.webPort}`] });
  } else {
    fs.writeFileSync(L.vscodeToken, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
    st.webPid = launch(L, 'vscode', runCfg.ideServerBin, [
      '--host', '127.0.0.1', '--port', String(runCfg.webPort), '--server-base-path', IDE_BASE_PATH,
      '--connection-token-file', L.vscodeToken, '--extensions-dir', L.vscodeExt,
      '--server-data-dir', L.vscodeServer, '--user-data-dir', L.vscodeUser, '--accept-server-license-terms',
    ], { env, cwd: L.home, markers: [`--port ${runCfg.webPort}`, `--connection-token-file ${L.vscodeToken}`] });
  }
  saveState(L, st);
  await waitForListener(runCfg.webPort, st.webPid, 300_000, runCfg.vscodeMode);
  saveState(L, st);
}

function startTripwire(L, st) {
  st.tripwirePid = launch(L, 'tripwire', process.execPath, [
    path.join(HERE, 'tripwire.mjs'), 'watch', '--port', String(OWNER_TOWER_PORT), '--pids', L.pids,
    '--marker', L.tripMarker, ...socketPrefixes(L, st).flatMap((p) => ['--socket-prefix', p]), '--interval', '2000',
  ], { env: childEnv(L, 'tripwire'), cwd: L.home, markers: ['tripwire.mjs', 'watch'] });
  saveState(L, st);
}

function runCfgFromState(L, st) {
  return {
    L, towerPort: st.towerPort, webPort: st.webPort, agentFarmDir: st.agentFarmDir, socketDir: st.socketDir,
    socketLink: st.socketLink, vscodeMode: st.vscodeMode,
  };
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

async function cmdStart() {
  const runCfg = planRun({ needWeb: true });
  const { L } = runCfg;
  let st;
  try {
    st = await bringUpTower(runCfg);
    console.log(`isolated Tower ${st.towerVersion} up on :${runCfg.towerPort} (pid ${st.towerPid}), db ${st.globalDb}`);
    await seedScenario(L, runCfg, st, 'empty');
    await bringUpVscode(runCfg, st);
    console.log(`${st.vscodeMode} up on :${runCfg.webPort} (pid ${st.webPid}) with ${st.extension.id}@${st.extension.version}`);
    assertTripwireClean(L, st);
    recordKnownPids(L, st);
    removePid(L, `cli-${process.pid}`);
    console.log(`harness started; workbench: ${workbenchUrl(L, st)}`);
  } catch (err) {
    console.error(`start failed: ${err.message}; tearing down`);
    await teardown(L);
    throw err;
  }
}

function workbenchUrl(L, st) {
  return workbenchUrlFor(L, st, `folder=${encodeURIComponent(path.join(fixturesDir(st), 'alpha'))}`);
}

/** The workbench URL with this query (a `folder=`, or `ew=true` for a window with no folder). */
function workbenchUrlFor(L, st, query) {
  if (st.vscodeMode === 'ide-server') {
    const token = fs.readFileSync(L.vscodeToken, 'utf-8').trim();
    return `http://127.0.0.1:${st.webPort}${IDE_BASE_PATH}/?${query}&tkn=${token}`;
  }
  return `http://127.0.0.1:${st.webPort}/?${query}`;
}

async function seedScenario(L, runCfg, st, name) {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`unknown scenario '${name}' (known: ${Object.keys(SCENARIOS).join(', ')})`);
  const r = runDriver(L, runCfg, st, ['seed', name]);
  if (r.status !== 0) {
    const err = r.status === REFUSAL_EXIT_CODE ? new Refusal(3, r.stderr.trim()) : new Error(`seeding '${name}' failed: ${r.stderr}`);
    throw err;
  }
  const key = readKey(runCfg);
  for (const ws of scenario.workspaces) {
    const dir = path.join(fixturesDir(st), ws.name);
    const want = expectedOverview(ws);
    await gateOverview({ port: runCfg.towerPort, key, workspace: dir, ...want });
    console.log(`gate 6: ${ws.name} overview has builders ${JSON.stringify(want.builders)} and architects ${JSON.stringify(want.architects)}`);
  }
  const listed = scenario.workspaces.filter((ws) => ws.activate)
    .map((ws) => ({ path: path.join(fixturesDir(st), ws.name), active: !ws.deactivate }));
  await gateFleet({ port: runCfg.towerPort, key, workspaces: listed });
  console.log(`gate 6: /api/workspaces lists ${listed.map((w) => `${path.basename(w.path)} (${w.active ? 'active' : 'dormant'})`).join(', ') || 'none of the fixtures'}`);
}

async function cmdSeed(name) {
  const L = layout(scratchFromEnv());
  const st = loadState(L);
  assertTripwireClean(L, st);
  writePid(L, `cli-${process.pid}`, process.pid, []);
  try {
    await seedScenario(L, runCfgFromState(L, st), st, name);
  } finally {
    removePid(L, `cli-${process.pid}`);
  }
  assertTripwireClean(L, st);
  recordKnownPids(L, st);
}

function assertTripwireClean(L, st) {
  if (fs.existsSync(L.tripMarker)) throw new Error(`TRIPWIRE FIRED: ${fs.readFileSync(L.tripMarker, 'utf-8')}`);
  if (!st.tripwirePid || !isAlive(st.tripwirePid)) throw new Error(`the tripwire (pid ${st.tripwirePid}) is not running`);
}

/** git: the vsix's inputs are unchanged since build-vsix (committed and in the working tree). */
/**
 * A digest of what the vsix is built from, as it is on disk now: every tracked or untracked (not
 * ignored) file under VSIX_INPUTS, by path and content. Comparing digests rather than commits means
 * an uncommitted edit that was built in counts as current, and a new untracked file counts as a
 * change.
 */
function vsixInputsDigest() {
  const r = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...VSIX_INPUTS], { cwd: REPO });
  if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr.trim()}`);
  const hash = crypto.createHash('sha256');
  for (const rel of [...new Set(r.stdout.split('\0').filter(Boolean))].sort()) {
    const abs = path.join(REPO, rel);
    const stat = fs.lstatSync(abs, { throwIfNoEntry: false });
    let content;
    if (!stat) content = 'missing';
    else if (stat.isSymbolicLink()) content = `link:${fs.readlinkSync(abs)}`;
    else if (stat.isFile()) content = sha256(abs);
    else content = `mode:${stat.mode}`;
    hash.update(`${rel}\0${content}\n`);
  }
  return hash.digest('hex');
}

function vsixIsCurrent(L) {
  if (!fs.existsSync(L.vsixMeta)) return `no build record ${L.vsixMeta}`;
  const meta = JSON.parse(fs.readFileSync(L.vsixMeta, 'utf-8'));
  if (meta.sha256 !== sha256(L.vsix)) return 'the vsix changed after build-vsix recorded it';
  if (!meta.inputsDigest) return 'the build record has no inputs digest; run build-vsix again';
  if (meta.inputsDigest !== vsixInputsDigest()) return 'vsix inputs changed since build-vsix; run it again';
  return null;
}

async function cmdCheck() {
  const L = layout(scratchFromEnv());
  const st = loadState(L);
  const runCfg = runCfgFromState(L, st);
  const results = [];
  const item = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
    }
  };
  writePid(L, `cli-${process.pid}`, process.pid, []);
  try {
    await item('tripwire running and not tripped', () => { assertTripwireClean(L, st); return `pid ${st.tripwirePid}`; });
    await item('gate 4: Tower on its port is the harness pid and answers the isolated key', async () =>
      `pid ${st.towerPid}, version ${await gateListener({ port: st.towerPort, pid: st.towerPid, key: readKey(runCfg) })}`);
    await item('gate 3: fixture driver and Tower agree on the db', () =>
      gateDbAgreement({ driver: probeDriver(L, runCfg, st), agentFarmDir: st.agentFarmDir, towerPid: st.towerPid }));
    await item('gate 5: profile pins the Tower port, auto-start off, stubs resolve', () => {
      gateVscodeProfile({ settingsPath: st.settingsPath, port: st.towerPort, env: webEnv(L, runCfg), stubsDir: STUBS });
      return st.settingsPath;
    });
    await item(`${st.vscodeMode} listener belongs to the harness`, () => {
      const tree = descendants([st.webPid]);
      const listeners = listenerPids(st.webPort);
      if (!listeners.length || !listeners.every((p) => tree.has(p))) throw new Error(`listeners ${listeners} not in the ${st.vscodeMode} tree`);
      return `pid ${listeners.join(', ')}`;
    });
    await item('installed extension is the branch vsix', () => {
      const stale = vsixIsCurrent(L);
      if (stale) throw new Error(stale);
      const entries = JSON.parse(fs.readFileSync(path.join(L.vscodeExt, 'extensions.json'), 'utf-8'));
      const codev = entries.filter((e) => e.identifier.id === st.extension.id);
      if (codev.length !== 1 || codev[0].location.path !== st.extension.dest) {
        throw new Error(`extensions.json lists ${JSON.stringify(codev)}`);
      }
      return `${st.extension.id}@${st.extension.version}, vsix ${st.extension.vsixSha256.slice(0, 12)}`;
    });
    await item('workbench loads and the Codev extension activates', () => runWorkbenchCheck(L, st, 'check-workbench'));
    await item('extension host is connected to the isolated Tower', async () => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const tree = descendants([st.webPid]);
        const conns = tcpOn(st.towerPort, 'ESTABLISHED').filter((p) => tree.has(p.pid));
        if (conns.length) return `pids ${[...new Set(conns.map((c) => c.pid))].join(', ')}`;
        if (Date.now() > deadline) throw new Error(`no ${st.vscodeMode} process holds a connection to :${st.towerPort}`);
        await sleep(1000);
      }
    });
    await item('extension preflight ran the codev stub', () => {
      const calls = fs.existsSync(L.stubLog) ? fs.readFileSync(L.stubLog, 'utf-8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      const hit = calls.find((c) => c.caller === 'vscode' && c.tool === 'codev' && c.argv.join(' ') === '--version');
      if (!hit) throw new Error(`no 'codev --version' from the vscode caller in ${calls.length} recorded calls`);
      return `${calls.length} recorded call(s)`;
    });
    await item('tripwire sample now: nothing of ours on :4100', () => {
      const { treeSize, violations } = sample({ port: OWNER_TOWER_PORT, pidsDir: L.pids, socketPrefixes: socketPrefixes(L, st) });
      if (violations.length) throw new Error(JSON.stringify(violations));
      assertTripwireClean(L, st);
      return `tree of ${treeSize}`;
    });
  } finally {
    removePid(L, `cli-${process.pid}`);
  }
  recordKnownPids(L, st);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `check FAILED (${failed} of ${results.length})` : `check passed (${results.length} items)`);
  if (failed) process.exitCode = 1;
}

/** Drive the workbench headless; returns a detail string or throws with the driver's error. */
function runWorkbenchCheck(L, st, name) {
  const out = path.join(L.logs, `${name}.json`);
  const shot = path.join(L.shots, `${name}.png`);
  const r = spawnSync(process.execPath, [
    path.join(HERE, 'workbench.mjs'), 'check', '--url', workbenchUrl(L, st), '--profile', L.browserProfile,
    '--shot', shot, '--out', out, '--owner-port', String(OWNER_TOWER_PORT),
  ], { env: childEnv(L, 'workbench', { PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_BROWSERS }), cwd: L.home, encoding: 'utf-8', timeout: 420_000 });
  if (r.error) throw r.error;
  const result = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf-8')) : null;
  if (r.status !== 0 || !result?.ok) throw new Error(`workbench check failed: ${result?.error ?? r.stderr}`);
  return `screenshot ${shot}${result.trustAccepted ? ' (trust prompt accepted)' : ''}`;
}

/**
 * Kill only the harness's own processes (by PID, each re-verified), remove the socket symlink
 * (always, even after a failed start), and, when nothing survived, the runtime dirs and state
 * record. Logs, screenshots and a tripwire marker are kept. Returns survivors.
 */
async function teardown(L) {
  const st = fs.existsSync(L.state) ? JSON.parse(fs.readFileSync(L.state, 'utf-8')) : null;
  const { pids, skipped } = ownedPids(L, st);
  for (const s of skipped) console.log(`not killing ${s}`);
  if (st?.towerPid && isAlive(st.towerPid)) {
    // Cross-check: the terminals the isolated Tower lists should all be in the kill set.
    try {
      const res = await fetch(`http://127.0.0.1:${st.towerPort}/api/terminals`, { headers: { 'codev-tower-key': readKey(runCfgFromState(L, st)) } });
      const { terminals } = await res.json();
      for (const t of terminals ?? []) if (t.pid && !pids.has(t.pid)) console.log(`warning: Tower lists terminal pid ${t.pid} outside the owned set`);
    } catch (err) {
      console.log(`warning: could not list the isolated Tower's terminals: ${err.message}`);
    }
  }
  const survivors = await killPids([...pids]);
  if (st?.socketLink && fs.lstatSync(st.socketLink, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(st.socketLink);
  const after = ownedPids(L, st).pids;
  const left = [...new Set([...survivors, ...after])];
  console.log(`teardown: killed ${pids.size} pid(s)${left.length ? `; STILL ALIVE: ${left.join(', ')}` : '; none left'}`);
  if (!left.length) {
    for (const key of RUNTIME_DIRS) fs.rmSync(L[key], { recursive: true, force: true });
    const refused = st?.fixturesDir ? removeFixturesDir(st) : null;
    if (refused) {
      // Keep the state record: it names the dir that was not removed.
      console.log(refused);
      return [refused];
    }
    fs.rmSync(L.state, { force: true });
  }
  return left;
}

async function cmdStop() {
  const L = layout(scratchFromEnv());
  const tripped = fs.existsSync(L.tripMarker) ? fs.readFileSync(L.tripMarker, 'utf-8') : null;
  const left = await teardown(L);
  if (tripped) console.log(`NOTE: the tripwire had fired during this run:\n${tripped}`);
  if (left.length) process.exitCode = 1;
}

async function cmdBuildVsix() {
  const L = layout(scratchFromEnv());
  fs.mkdirSync(L.root, { recursive: true });
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: REPO }).stdout.trim();
  const dirty = run('git', ['status', '--porcelain', '--', ...VSIX_INPUTS], { cwd: REPO }).stdout.trim() !== '';
  // Digest the inputs before packaging: an edit made during the build then reads as a change.
  const inputsDigest = vsixInputsDigest();
  const r = spawnSync('pnpm', ['exec', 'vsce', 'package', '--no-dependencies', '--out', L.vsix], { cwd: VSCODE_APP, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`vsce package failed (${r.status})`);
  const meta = { head, dirtyAtBuild: dirty, inputsDigest, sha256: sha256(L.vsix), builtAt: new Date().toISOString() };
  fs.writeFileSync(L.vsixMeta, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`built ${L.vsix} at ${head.slice(0, 8)}${dirty ? ' (with uncommitted or untracked input changes)' : ''}`);
}

// ---------------------------------------------------------------------------------------------
// Phase 5: Tower down / up (reconnect check) and the scripted Cockpit verification
// ---------------------------------------------------------------------------------------------

/**
 * Stop the isolated Tower only, by its recorded PID (re-verified by its command line). Its shellpers
 * are detached and survive, as they survive any Tower restart, so `tower-up` restores the sessions.
 */
async function cmdTowerDown() {
  const L = layout(scratchFromEnv());
  const st = loadState(L);
  assertTripwireClean(L, st);
  const cmd = processTable().get(st.towerPid)?.command ?? '';
  if (!cmd.includes('tower-server.js') || !cmd.includes(`-p ${st.towerPort}`)) {
    throw new Error(`pid ${st.towerPid} is not the isolated Tower (it runs '${cmd}')`);
  }
  const survivors = await killPids([st.towerPid]);
  if (survivors.length) throw new Error(`the isolated Tower (pid ${st.towerPid}) survived`);
  removePid(L, 'tower');
  st.towerPid = null;
  saveState(L, st);
  console.log(`isolated Tower stopped; :${st.towerPort} ${listenerPids(st.towerPort).length ? 'STILL has a listener' : 'is free'}`);
}

/** Start the isolated Tower again on the same port, agent-farm dir and socket dir; gates 4 and 3. */
async function cmdTowerUp() {
  const L = layout(scratchFromEnv());
  const st = loadState(L);
  assertTripwireClean(L, st);
  if (st.towerPid && isAlive(st.towerPid)) throw new Error(`the isolated Tower is already running (pid ${st.towerPid})`);
  const runCfg = runCfgFromState(L, st);
  gatePort('COCKPIT_TOWER_PORT', String(st.towerPort));
  writePid(L, `cli-${process.pid}`, process.pid, []);
  try {
    st.towerPid = launch(L, 'tower', process.execPath, towerArgs(runCfg), {
      env: towerEnv(L, runCfg), cwd: L.home, markers: ['tower-server.js', `-p ${st.towerPort}`],
    });
    saveState(L, st);
    await waitForListener(st.towerPort, st.towerPid, 30_000, 'isolated Tower');
    st.towerVersion = await gateListener({ port: st.towerPort, pid: st.towerPid, key: readKey(runCfg) });
    st.globalDb = gateDbAgreement({ driver: probeDriver(L, runCfg, st), agentFarmDir: st.agentFarmDir, towerPid: st.towerPid });
    saveState(L, st);
  } finally {
    removePid(L, `cli-${process.pid}`);
  }
  assertTripwireClean(L, st);
  recordKnownPids(L, st);
  console.log(`isolated Tower ${st.towerVersion} up again on :${st.towerPort} (pid ${st.towerPid})`);
}

/**
 * Restart the isolated VS Code only: kill its process tree by PID (the server re-verified by its
 * command line), then bring it up again with the same dirs, vsix and Tower. VS Code's server keeps a
 * disconnected window's extension host alive for its reconnection grace period, so after earlier
 * windows their hosts keep polling the Tower; a request count needs a server with none.
 */
async function cmdVscodeRestart() {
  const L = layout(scratchFromEnv());
  const st = loadState(L);
  assertTripwireClean(L, st);
  const runCfg = { ...runCfgFromState(L, st), ideServerBin: process.env.COCKPIT_IDE_SERVER_BIN, preCockpit: process.env.COCKPIT_PRE_COCKPIT === '1' };
  const markers = st.vscodeMode === 'serve-web' ? ['serve-web', `--port ${st.webPort}`] : [`--port ${st.webPort}`, `--connection-token-file ${L.vscodeToken}`];
  const cmd = processTable().get(st.webPid)?.command ?? '';
  if (!markers.every((m) => cmd.includes(m))) throw new Error(`pid ${st.webPid} is not the harness's ${st.vscodeMode} (it runs '${cmd}')`);
  const tree = [...descendants([st.webPid])];
  const survivors = await killPids(tree);
  if (survivors.length) throw new Error(`${st.vscodeMode} pids survived: ${survivors.join(', ')}`);
  removePid(L, 'vscode');
  if (listenerPids(st.webPort).length) throw new Error(`:${st.webPort} still has a listener`);
  writePid(L, `cli-${process.pid}`, process.pid, []);
  try {
    await bringUpVscode(runCfg, st);
  } finally {
    removePid(L, `cli-${process.pid}`);
  }
  assertTripwireClean(L, st);
  recordKnownPids(L, st);
  console.log(`${st.vscodeMode} restarted on :${st.webPort} (pid ${st.webPid}); killed ${tree.length} pid(s) of the old tree`);
}

/**
 * Run one script of the Cockpit verification driver (`cockpit-verify.mjs`) against the running
 * harness. The installed vsix must still be the branch's.
 */
async function cmdVerify(script) {
  const L = layout(scratchFromEnv());
  const st = loadState(L);
  assertTripwireClean(L, st);
  const stale = vsixIsCurrent(L) ?? (st.extension.vsixSha256 === sha256(L.vsix) ? null : 'the vsix was rebuilt after start installed it; stop and start again');
  if (stale) throw new Error(`the installed vsix is not the branch's: ${stale}`);
  if (Boolean(st.extension.preCockpit) !== (script === 'profile-seed')) {
    throw new Error(st.extension.preCockpit
      ? 'the install has no Cockpit container (COCKPIT_PRE_COCKPIT): only profile-seed runs against it; vscode-restart without it first'
      : 'profile-seed needs the install without the Cockpit container: COCKPIT_PRE_COCKPIT=1 vscode-restart first');
  }
  const out = path.join(L.logs, `verify-${script}.json`);
  const r = spawnSync(process.execPath, [
    path.join(HERE, 'cockpit-verify.mjs'), script, '--url-template', workbenchUrlFor(L, st, '__QUERY__'), '--fixtures', fixturesDir(st),
    '--profile', L.browserProfile, '--shots', L.shots, '--out', out, '--owner-port', String(OWNER_TOWER_PORT),
    '--stub-log', L.stubLog, '--request-log', L.requestLog, '--tower-port', String(st.towerPort),
    ...(process.env.COCKPIT_BASELINE ? ['--baseline', path.resolve(process.env.COCKPIT_BASELINE)] : []),
  ], {
    env: childEnv(L, 'workbench', {
      PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_BROWSERS,
      COCKPIT_TOWER_KEY: readKey(runCfgFromState(L, st)),
      // For the driver's own `tower-down` / `tower-up` calls back into this CLI.
      COCKPIT_SCRATCH: L.scratch,
      COCKPIT_TOWER_PORT: String(st.towerPort),
      COCKPIT_WEB_PORT: String(st.webPort),
    }),
    cwd: L.home, encoding: 'utf-8', timeout: 1_800_000, stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (r.error) throw r.error;
  assertTripwireClean(L, st);
  recordKnownPids(L, st);
  if (r.status !== 0) {
    process.exitCode = 1;
    console.log(`verify ${script} FAILED; results in ${out}`);
  } else {
    console.log(`verify ${script} passed; results in ${out}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------------------------

/** A throwaway listener in a separate process; resolves with { pid, port, kill }. */
function foreignListener() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e',
      "const s=require('net').createServer(c=>{}).listen(0,'127.0.0.1',()=>console.log(s.address().port))"], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.once('data', (d) => resolve({ pid: child.pid, port: Number(String(d).trim()), kill: () => child.kill('SIGKILL') }));
    child.once('error', reject);
  });
}

async function selftest() {
  const scratch = scratchFromEnv();
  const towerPort = gatePort('COCKPIT_TOWER_PORT', process.env.COCKPIT_TOWER_PORT);
  const webPort = gatePort('COCKPIT_WEB_PORT', process.env.COCKPIT_WEB_PORT);
  const base = path.join(scratch, 'cockpit-harness-selftest');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  const results = [];
  const record = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // --- Gates 1 and 2: `start` refuses before creating anything. ---
  const busy = await foreignListener();
  const outsideAf = path.join(REPO, 'tmp-cockpit-selftest-af');
  const outsideSock = `/tmp/cckp-selftest-${crypto.randomBytes(3).toString('hex')}`;
  const longSockName = 'socket-dir-with-a-deliberately-long-name-to-exceed-the-unix-socket-path-limit';
  const cases = [
    ['gate 1 refuses COCKPIT_TOWER_PORT=4100', { COCKPIT_TOWER_PORT: '4100' }, 1],
    ['gate 1 refuses an unset port', { COCKPIT_TOWER_PORT: '' }, 1],
    ['gate 1 refuses a non-numeric port', { COCKPIT_TOWER_PORT: '18x64' }, 1],
    ['gate 1 refuses the web port equal to the Tower port', { COCKPIT_WEB_PORT: String(towerPort) }, 1],
    ['gate 1 refuses a port that already has a listener', { COCKPIT_TOWER_PORT: String(busy.port) }, 1],
    ['gate 2 refuses CODEV_AGENT_FARM_DIR=~/.agent-farm', { CODEV_AGENT_FARM_DIR: path.join(REAL_HOME, '.agent-farm') }, 2],
    ['gate 2 refuses an agent-farm dir outside the scratchpad', { CODEV_AGENT_FARM_DIR: outsideAf }, 2],
    ['gate 2 refuses SHELLPER_SOCKET_DIR=~/.codev/run', { SHELLPER_SOCKET_DIR: path.join(REAL_HOME, '.codev', 'run') }, 2],
    ['gate 2 refuses a socket dir outside the scratchpad', { SHELLPER_SOCKET_DIR: outsideSock }, 2],
    ['gate 2 refuses a socket dir too long for a Unix socket', (caseScratch) => ({ SHELLPER_SOCKET_DIR: path.join(caseScratch, longSockName) }), 2],
  ];
  let n = 0;
  for (const [name, overridesFor, gate] of cases) {
    const caseScratch = path.join(base, `case-${++n}`);
    fs.mkdirSync(caseScratch);
    const overrides = typeof overridesFor === 'function' ? overridesFor(caseScratch) : overridesFor;
    const env = { ...process.env, COCKPIT_SCRATCH: caseScratch, COCKPIT_TOWER_PORT: String(towerPort), COCKPIT_WEB_PORT: String(webPort), ...overrides };
    for (const k of ['CODEV_AGENT_FARM_DIR', 'SHELLPER_SOCKET_DIR']) if (!(k in overrides)) delete env[k];
    const r = spawnSync(process.execPath, [path.join(HERE, 'harness.mjs'), 'start'], { env, encoding: 'utf-8', timeout: 60_000 });
    const problems = [];
    if (r.status !== REFUSAL_EXIT_CODE) problems.push(`exit ${r.status}, expected ${REFUSAL_EXIT_CODE}`);
    if (!r.stderr.includes(`pre-flight gate ${gate} refused`)) problems.push(`stderr lacks 'gate ${gate} refused': ${r.stderr.trim()}`);
    if (fs.readdirSync(caseScratch).length) problems.push(`created ${fs.readdirSync(caseScratch).join(', ')}`);
    for (const p of [outsideAf, outsideSock]) if (fs.existsSync(p)) problems.push(`created ${p}`);
    for (const p of [towerPort, webPort]) if (listenerPids(p).length) problems.push(`something listens on ${p}`);
    record(name, !problems.length, problems.join('; ') || r.stderr.trim().split('\n').pop());
  }
  busy.kill();

  // --- Gates 3 and 4 against a real isolated Tower. ---
  process.env.COCKPIT_SCRATCH = path.join(base, 'tower');
  fs.mkdirSync(process.env.COCKPIT_SCRATCH);
  delete process.env.CODEV_AGENT_FARM_DIR;
  delete process.env.SHELLPER_SOCKET_DIR;
  const runCfg = planRun({ needWeb: false });
  const { L } = runCfg;
  try {
    const st = await bringUpTower(runCfg);
    record('isolated Tower passes gates 2-4 (positive control)', true, `pid ${st.towerPid}, db ${st.globalDb}`);
    assertTripwireClean(L, st);
    record('tripwire is running before the Tower launch and stays clean', true, `pid ${st.tripwirePid}`);

    const r = runDriver(L, runCfg, st, ['seed', 'one-builder'], { NODE_ENV: 'test' });
    const testDb = path.join(runCfg.agentFarmDir, 'test.db');
    const problems = [];
    if (r.status !== REFUSAL_EXIT_CODE) problems.push(`exit ${r.status}: ${r.stderr.trim()}`);
    if (!r.stderr.includes('pre-flight gate 3 refused')) problems.push(`stderr: ${r.stderr.trim()}`);
    if (fs.existsSync(testDb)) problems.push(`created ${testDb}`);
    const created = fs.readdirSync(fixturesDir(st)).filter((f) => f !== FIXTURES_MARKER);
    if (created.length) problems.push(`created fixtures ${created.join(', ')}`);
    record('gate 3 refuses a NODE_ENV=test driver against the production-mode Tower', !problems.length, problems.join('; ') || r.stderr.trim());

    const foreign = await foreignListener();
    try {
      await gateListener({ port: foreign.port, pid: st.towerPid, key: readKey(runCfg) });
      record('gate 4 refuses a listener that is not the harness\'s', false, 'gate 4 passed');
    } catch (err) {
      record('gate 4 refuses a listener that is not the harness\'s', err instanceof Refusal && err.gate === 4, err.message);
    } finally {
      foreign.kill();
    }
  } catch (err) {
    record('isolated Tower bring-up', false, err.message);
  } finally {
    const left = await teardown(L);
    const linkGone = !runCfg.socketLink || !fs.lstatSync(runCfg.socketLink, { throwIfNoEntry: false });
    record('selftest Tower torn down by PID, socket link removed', !left.length && linkGone,
      left.length ? `alive: ${left.join(', ')}` : (linkGone ? '' : `${runCfg.socketLink} remains`));
  }

  // --- Teardown refuses to remove a recorded fixtures dir that is not the harness's. ---
  fixturesRemovalSelftest(base, record);

  // --- Tripwire fires on a connection from the harness tree, and only from it. ---
  await tripwireSelftest(base, record);

  fs.rmSync(base, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `selftest FAILED (${failed} of ${results.length})` : `selftest passed (${results.length} cases)`);
  if (failed) process.exitCode = 1;
}

/**
 * `removeFixturesDir` (the step `stop` runs) refuses every recorded dir that fails a check and
 * deletes nothing; a genuine one is removed. Decoys outside the scratchpad are created here under the
 * per-user temp dir with their own `cockpit-selftest-*` / `cockpit-fixtures-*` names, and this
 * function removes them itself by the paths it created.
 */
function fixturesRemovalSelftest(base, record) {
  const parent = fixturesParent();
  const made = [];
  const decoyDir = (prefix) => {
    const dir = fs.mkdtempSync(path.join(parent, prefix));
    made.push(dir);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'must survive\n');
    return dir;
  };
  try {
    const genuine = createFixturesDir();
    made.push(genuine.fixturesDir);
    fs.writeFileSync(path.join(genuine.fixturesDir, 'keep.txt'), 'must survive\n');
    const noMarker = decoyDir(FIXTURES_PREFIX);
    const wrongName = decoyDir('cockpit-selftest-');
    fs.writeFileSync(path.join(wrongName, FIXTURES_MARKER), `${genuine.fixturesToken}\n`);
    const inScratch = fs.mkdtempSync(path.join(base, FIXTURES_PREFIX));
    fs.writeFileSync(path.join(inScratch, FIXTURES_MARKER), `${genuine.fixturesToken}\n`);
    fs.writeFileSync(path.join(inScratch, 'keep.txt'), 'must survive\n');
    const link = path.join(parent, `${FIXTURES_PREFIX}selftest-link-${crypto.randomBytes(3).toString('hex')}`);
    fs.symlinkSync(genuine.fixturesDir, link);
    made.push(link);
    const cases = [
      ['no fixtures dir recorded', {}, null],
      ['a dir without the marker', { fixturesDir: noMarker, fixturesToken: genuine.fixturesToken }, noMarker],
      ['a marker with another run\'s token', { fixturesDir: genuine.fixturesDir, fixturesToken: 'f'.repeat(32) }, genuine.fixturesDir],
      ['a name other than cockpit-fixtures-*', { fixturesDir: wrongName, fixturesToken: genuine.fixturesToken }, wrongName],
      ['a parent other than the per-user temp dir', { fixturesDir: inScratch, fixturesToken: genuine.fixturesToken }, inScratch],
      ['a symlink to a genuine fixtures dir', { fixturesDir: link, fixturesToken: genuine.fixturesToken }, genuine.fixturesDir],
    ];
    for (const [what, st, survivor] of cases) {
      const refused = removeFixturesDir(st);
      const kept = !survivor || fs.existsSync(path.join(survivor, 'keep.txt'));
      const linkKept = fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink();
      record(`stop refuses to remove ${what}, deleting nothing`, Boolean(refused) && kept && linkKept,
        refused ? refused : 'removed it');
    }
    const removed = removeFixturesDir(genuine);
    record('stop removes the genuine fixtures dir (positive control)', !removed && !fs.existsSync(genuine.fixturesDir),
      removed ?? genuine.fixturesDir);
  } finally {
    for (const p of made) {
      const stat = fs.lstatSync(p, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) fs.unlinkSync(p);
      else if (stat) fs.rmSync(p, { recursive: true, force: true });
    }
  }
}

async function tripwireSelftest(base, record) {
  const dir = path.join(base, 'tripwire');
  const pidsDir = path.join(dir, 'pids');
  const marker = path.join(dir, 'tripped.json');
  fs.mkdirSync(pidsDir, { recursive: true });
  const server = net.createServer(() => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // The "harness child": connects to the throwaway listener when told to on stdin, then holds.
  const child = spawn(process.execPath, ['-e',
    `process.stdin.once('data',()=>{require('net').connect(${port},'127.0.0.1');});setInterval(()=>{},1000);`], { stdio: ['pipe', 'ignore', 'inherit'] });
  fs.writeFileSync(path.join(pidsDir, 'child.json'), JSON.stringify({ pid: child.pid, markers: [] }));
  const tw = spawn(process.execPath, [path.join(HERE, 'tripwire.mjs'), 'watch', '--port', String(port), '--pids', pidsDir,
    '--marker', marker, '--interval', '200'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const twExit = new Promise((r) => tw.once('exit', (code) => r(code)));
  try {
    // Control: a connection from a process outside the tree (this one) must not trip it.
    const outsider = net.connect(port, '127.0.0.1');
    await sleep(2000);
    const quiet = tw.exitCode === null && !fs.existsSync(marker);
    record('tripwire ignores a connection from outside the harness tree', quiet, quiet ? '' : 'it fired');
    outsider.destroy();

    child.stdin.write('go\n');
    const code = await Promise.race([twExit, sleep(10_000).then(() => 'timeout')]);
    const hit = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf-8')) : null;
    const ok = code === TRIPWIRE_EXIT_CODE && hit?.violations.some((v) => v.pid === child.pid);
    record('tripwire fires on a connection from a harness child', ok, `exit ${code}, ${hit ? `flagged pid ${hit.violations.map((v) => v.pid).join(', ')}` : 'no marker'}`);
  } finally {
    if (tw.exitCode === null) tw.kill('SIGKILL');
    child.kill('SIGKILL');
    server.close();
  }
}

// ---------------------------------------------------------------------------------------------

const COMMANDS = {
  'build-vsix': cmdBuildVsix,
  start: cmdStart,
  seed: cmdSeed,
  check: cmdCheck,
  stop: cmdStop,
  'tower-down': cmdTowerDown,
  'tower-up': cmdTowerUp,
  'vscode-restart': cmdVscodeRestart,
  verify: cmdVerify,
  selftest,
};

const [cmd, ...args] = process.argv.slice(2);
if (!COMMANDS[cmd]) {
  console.error(`usage: harness.mjs ${Object.keys(COMMANDS).join(' | ')}`);
  process.exit(64);
}
COMMANDS[cmd](...args).catch((err) => {
  console.error(err instanceof Refusal ? err.message : `harness error: ${err.stack ?? err}`);
  process.exit(err instanceof Refusal ? REFUSAL_EXIT_CODE : 1);
});
