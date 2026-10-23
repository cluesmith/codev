/**
 * IDE server lifecycle, Tower-side (Issue #1668).
 *
 * Tower is the spawner: `afx ide start` drives this through the local-only
 * `/api/ide` endpoint, and the same spawn path is reused by boot reconcile and
 * by on-demand respawn when a `/ide/` request arrives and the server is down.
 * Runtime state lives in the `~/.agent-farm/ide-server.json` record (Issue
 * #1668 §D3) — no config file, no `global.db` change. Liveness is discovered by
 * port (`getProcessesOnPort`), the same way Tower finds its own process.
 *
 * Every spawn runs a preflight first (Spec 1789): the server version floor and
 * the embedded sidebar install into the Tower-owned extensions directory. The
 * preflight throws before anything is stopped, replaced or recorded, so a
 * refused start leaves a live server and its record untouched. Lifecycle
 * operations are serialized by `withIdeLock`, taken only at the entry points
 * (`spawnIdeServer`, `stopIdeServer`, the respawn in `ensureIdeServerLive`);
 * the unlocked bodies call each other freely, so the nesting cannot deadlock.
 *
 * Native Windows (Spec 1658 Phase 9): the server path is usually a `.cmd`
 * shim, which `spawn` cannot run without a shell, so the spawn goes through
 * the shared shim resolver with no console window. There are no signals or
 * process groups, so stop kills the server's process tree. Readiness is a
 * loopback connect, since the Windows port query costs a PowerShell start per
 * poll. POSIX is unchanged.
 */

import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getProcessesOnPort, getProcessesOnPortAsync } from '../utils/port.js';
import { isWindows } from '../../lib/platform.js';
import {
  collectTree,
  killSessionTree,
  waitForTreeExit,
  type KillSessionTreeResult,
  type TreeMember,
  type TreeSnapshot,
} from '../../lib/process-tree.js';
import { listProcessCensus, type ProcessCensusEntry } from './process-census.js';
import { parseJsonBody } from '../utils/server-utils.js';
import {
  IDE_DEFAULT_PREFIX,
  IDE_DEFAULT_PORT,
  type IdeServerRecord,
  readIdeRecord,
  writeIdeRecord,
  deleteIdeRecord,
  ensureIdeConnectionToken,
  getIdeConnectionTokenPath,
} from '../lib/ide-record.js';
import {
  IDE_READY_TIMEOUT_MS,
  IDE_STOP_EXIT_TIMEOUT_MS,
  type LogFn,
  buildIdeServerEnv,
  checkIdeServerVersion,
  ideServerSpawnable,
} from '../lib/ide-version.js';
import { ensureSidebarInstalled, getIdeExtensionsDir } from '../lib/ide-extensions.js';

const READY_POLL_MS = 200;
const STOP_POLL_MS = 200;
const CONNECT_PROBE_TIMEOUT_MS = 1_000;

/**
 * True if some process is listening on the port. Uses `getProcessesOnPort`
 * (`lsof`, ~100 ms and synchronous), so it is a **COLD-path only** check — restart
 * reconcile, `afx ide status`, start-collision detection, and respawn. The request
 * forward must NEVER call this (Issue #1668): it reads the port from the record and
 * lets the upstream connect error be the liveness truth-teller.
 */
function isPortLive(port: number): boolean {
  return getProcessesOnPort(port).length > 0;
}

/** True if a PID is alive (cheap, non-blocking). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The recorded IDE server port, or null if none — the forward's hot-path target
 * resolution. A plain record read, no port scan (Issue #1668): a dead server
 * fails the proxy connect immediately, which is the only liveness check the
 * forward needs.
 */
export function getRecordedIdePort(): number | null {
  return readIdeRecord()?.port ?? null;
}

/** True if a loopback TCP connect to `port` succeeds within the probe timeout. */
export function isPortAccepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (accepting: boolean) => {
      socket.destroy();
      resolve(accepting);
    };
    socket.setTimeout(CONNECT_PROBE_TIMEOUT_MS, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Whether a server is listening on `port`: the port query on POSIX, a loopback
 * connect on Windows. Every async liveness check uses this rather than
 * `isPortLive`, because the Windows port query is a synchronous PowerShell run
 * of seconds that would stall Tower's event loop, and the respawn check runs
 * when a `/ide/` request finds the server down.
 */
async function isPortListening(port: number): Promise<boolean> {
  if (isWindows()) return isPortAccepting(port);
  return isPortLive(port);
}

/** Poll until a process is listening on `port`, or the timeout elapses. */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortListening(port)) return true;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return isPortListening(port);
}

/**
 * Start the server process. POSIX spawns the path as given. Windows spawns the
 * form `ideServerSpawnable` resolves (a JS launcher under Node, a `.cmd` shim
 * through the shim resolver), with no console window.
 */
export function spawnIdeServerProcess(serverPath: string, args: string[], options: SpawnOptions & { env: Record<string, string> }): ChildProcess {
  if (!isWindows()) return spawn(serverPath, args, options);
  const spawnable = ideServerSpawnable(serverPath, args, options.env);
  return spawn(spawnable.command, spawnable.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: spawnable.windowsVerbatimArguments,
  });
}

/**
 * Tail of the lifecycle lock: a non-reentrant promise chain. Taken only at the
 * entry points, never inside the unlocked bodies.
 */
let ideLockTail: Promise<unknown> = Promise.resolve();

function withIdeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = ideLockTail.then(fn);
  ideLockTail = run.catch(() => {});
  return run;
}

export interface SpawnIdeOptions {
  serverPath: string;
  port?: number;
}

export interface SpawnIdeResult {
  record: IdeServerRecord;
  /**
   * True when an already-live server was adopted that is not running what
   * this start asked for: the sidebar just changed, the recorded server path,
   * sidebar version or extensions directory differs from the current one
   * (including a legacy record with neither), or its launch arguments are
   * unknown (no prior record). The live server is never killed; the user
   * restarts it.
   */
  restartRequired: boolean;
}

interface IdePreflight {
  serverVersion: string;
  extensionsDir: string;
  /** Null when the package carries no embedded sidebar. */
  sidebarVersion: string | null;
  sidebarChanged: boolean;
}

/**
 * Version floor, then the sidebar install (which validates or creates the
 * extensions directory first). Throws before any side effect on the server or
 * the record. A missing embedded sidebar only warns: the server still gets
 * `--extensions-dir`.
 */
async function runIdePreflight(serverPath: string, log: LogFn): Promise<IdePreflight> {
  const { version } = await checkIdeServerVersion(serverPath);
  const extensionsDir = getIdeExtensionsDir();
  const sidebar = await ensureSidebarInstalled(serverPath, { extensionsDir, log });
  return {
    serverVersion: version,
    extensionsDir,
    sidebarVersion: sidebar.version,
    sidebarChanged: sidebar.outcome === 'installed',
  };
}

/**
 * Spawn the IDE server detached (so it survives a Tower restart, like a
 * shellper) and write the runtime record. Resolves once the server is
 * listening, or throws if the binary is missing, fails the preflight, or never
 * binds. Serialized with every other lifecycle operation.
 */
export function spawnIdeServer(opts: SpawnIdeOptions, log: LogFn): Promise<SpawnIdeResult> {
  return withIdeLock(() => spawnIdeServerUnlocked(opts, log));
}

async function spawnIdeServerUnlocked(opts: SpawnIdeOptions, log: LogFn): Promise<SpawnIdeResult> {
  const port = opts.port ?? IDE_DEFAULT_PORT;
  if (!opts.serverPath) {
    throw new Error('IDE server path is required (no default — set --server-path)');
  }
  if (!existsSync(opts.serverPath)) {
    throw new Error(`IDE server binary not found at ${opts.serverPath}`);
  }

  // Before anything is stopped or replaced: a refused server or a failed
  // install must leave the current server and its record exactly as they are.
  const preflight = await runIdePreflight(opts.serverPath, log);

  // Start-collision: a prior server recorded on a DIFFERENT port would be orphaned
  // (still running, no longer tracked) if we just overwrote the singleton record.
  // Stop it first so "start on a new port" never leaves a detached stray (#1668).
  const existing = readIdeRecord();
  if (existing && existing.port !== port && (await isPortListening(existing.port))) {
    log('WARN', `IDE server already recorded on port ${existing.port}; stopping it before starting on ${port}`);
    try {
      await stopIdeServerUnlocked(log);
    } catch (err) {
      throw new Error(`Cannot start the IDE server on port ${port}: stopping the one on port ${existing.port} failed: ${(err as Error).message}`);
    }
  }

  // Already live on the port: idempotent, adopt and record, never kill or double-spawn.
  if (await isPortListening(port)) {
    return adoptLiveIdeServer(opts, port, existing, preflight, log);
  }

  const basePath = IDE_DEFAULT_PREFIX.replace(/\/$/, ''); // "/ide"
  const tokenFile = getIdeConnectionTokenPath();
  ensureIdeConnectionToken();

  const args = [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--server-base-path', basePath,
    '--connection-token-file', tokenFile,
    '--extensions-dir', preflight.extensionsDir,
    '--accept-server-license-terms',
  ];

  log('INFO', `Spawning IDE server ${preflight.serverVersion}: ${opts.serverPath} ${args.join(' ')}`);
  const child = spawnIdeServerProcess(opts.serverPath, args, {
    cwd: process.cwd(),
    env: buildIdeServerEnv(),
    detached: true,
    stdio: 'ignore',
  });
  if (!child.pid) {
    throw new Error('Failed to spawn IDE server process');
  }
  child.unref();

  const ready = await waitForPort(port, IDE_READY_TIMEOUT_MS);
  if (!ready) {
    // No record is written for a server that never bound, so nothing could
    // stop it later: stop it now (Spec 1658 Phase 9; the leak dates from #1668).
    const stopped = await stopUnreadyIdeServer(child.pid, log);
    let outcome = 'the server process was stopped';
    if (!stopped) outcome = `the server process (pid ${child.pid}) could not be stopped and may still be running`;
    throw new Error(`IDE server did not start listening on port ${port} within ${IDE_READY_TIMEOUT_MS / 1000}s; ${outcome}`);
  }

  const record: IdeServerRecord = {
    prefix: IDE_DEFAULT_PREFIX,
    port,
    serverPath: opts.serverPath,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    serverVersion: preflight.serverVersion,
    extensionsDir: preflight.extensionsDir,
    sidebarVersion: preflight.sidebarVersion ?? undefined,
  };
  writeIdeRecord(record);
  log('INFO', `IDE server listening on port ${port} (pid ${child.pid})`);
  return { record, restartRequired: false };
}

/**
 * Record a server already listening on `port` without touching it. The record
 * keeps what the live process was actually spawned with (the prior record's
 * server path, version, extensions directory and sidebar; absent stays absent):
 * the version just checked describes `opts.serverPath`, which need not be the
 * binary the live process came from. With no prior record on that port the live
 * binary is unknown, so the requested path is recorded and a restart is flagged.
 */
async function adoptLiveIdeServer(
  opts: SpawnIdeOptions,
  port: number,
  existing: IdeServerRecord | null,
  preflight: IdePreflight,
  log: LogFn,
): Promise<SpawnIdeResult> {
  const listeners = await getProcessesOnPortAsync(port);
  let prior: IdeServerRecord | null = null;
  if (existing && existing.port === port) {
    prior = existing;
  }
  const restartRequired = prior === null || !liveServerIsCurrent(prior, opts.serverPath, preflight);

  const record: IdeServerRecord = {
    prefix: IDE_DEFAULT_PREFIX,
    port,
    serverPath: prior?.serverPath ?? opts.serverPath,
    pid: listeners?.[0] ?? 0,
    startedAt: prior?.startedAt ?? new Date().toISOString(),
    serverVersion: prior?.serverVersion,
    extensionsDir: prior?.extensionsDir,
    sidebarVersion: prior?.sidebarVersion,
  };
  writeIdeRecord(record);
  let note = '';
  if (restartRequired) {
    note = '; restart it to load the current Codev sidebar';
  }
  log('INFO', `IDE server already listening on port ${port}; adopted${note}`);
  return { record, restartRequired };
}

/**
 * True when the live server recorded in `prior` already runs what this start
 * prepared: the same server binary at the same version, the same extensions
 * directory and, when a sidebar is embedded, the same sidebar version. Compared
 * against the record rather than this preflight's outcome, so a server left
 * running after an earlier start upgraded the server (in place, as `npm i -g`
 * does, or at a new path) or the sidebar is still reported stale on every later
 * start. An unknown recorded version is not treated as stale on its own.
 */
function liveServerIsCurrent(prior: IdeServerRecord, serverPath: string, preflight: IdePreflight): boolean {
  if (prior.serverPath !== serverPath) return false;
  if (prior.serverVersion !== undefined && prior.serverVersion !== preflight.serverVersion) return false;
  if (preflight.sidebarChanged) return false;
  if (prior.extensionsDir !== preflight.extensionsDir) return false;
  if (preflight.sidebarVersion === null) return true;
  return prior.sidebarVersion === preflight.sidebarVersion;
}

/**
 * Stop the IDE server on the recorded port: SIGTERM, wait for exit, escalate to
 * SIGKILL for survivors (mirrors `towerStop`, #1668 plan §4), then delete the
 * record. Cold path — `getProcessesOnPort` is fine here. Serialized with every
 * other lifecycle operation.
 */
export function stopIdeServer(log: LogFn): Promise<{ stopped: boolean; port: number | null }> {
  return withIdeLock(() => stopIdeServerUnlocked(log));
}

async function stopIdeServerUnlocked(log: LogFn): Promise<{ stopped: boolean; port: number | null }> {
  const record = readIdeRecord();
  if (!record) {
    return { stopped: false, port: null };
  }
  const listeners = await getProcessesOnPortAsync(record.port);
  if (isWindows()) {
    return stopWindowsIdeServer(record, listeners, log);
  }
  const pids = listeners ?? [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }

  // Wait for the SIGTERMed processes to actually exit before deleting the record;
  // escalate any survivors to SIGKILL, so a lingering process can't be re-adopted.
  const deadline = Date.now() + IDE_STOP_EXIT_TIMEOUT_MS;
  let survivors = pids.filter(isPidAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
    survivors = survivors.filter(isPidAlive);
  }
  for (const pid of survivors) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // exited between the check and the kill
    }
  }

  deleteIdeRecord();
  const killedNote = survivors.length > 0 ? `, SIGKILL escalated for ${survivors.length}` : '';
  log('INFO', `Stopped IDE server on port ${record.port} (${pids.length} process(es)${killedNote})`);
  return { stopped: pids.length > 0, port: record.port };
}

/** Seams for the Windows path of `stopUnreadyIdeServer`. */
export interface UnreadyStopSeams {
  killTree?: (pid: number) => Promise<KillSessionTreeResult>;
  waitExit?: (pid: number, snapshot: TreeSnapshot, timeoutMs: number) => Promise<boolean>;
}

/** True while any process in the group led by `pgid` is alive. */
function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a spawned server that never started listening; true when it is gone.
 * Windows: kill its tree. POSIX: it leads its own process group (spawned
 * detached), so SIGTERM the group, wait for it to empty, and SIGKILL it if it
 * outlives the wait, mirroring `stopIdeServer`. Windows reports success only
 * once the kill's snapshot has exited (`taskkill` failing does not reject). A
 * failure is logged, never thrown: the caller is already failing the start,
 * and says whether this worked.
 */
export async function stopUnreadyIdeServer(pid: number, log: LogFn, seams: UnreadyStopSeams = {}): Promise<boolean> {
  if (isWindows()) {
    const killTree = seams.killTree ?? ((root: number) => killSessionTree(root));
    const waitExit = seams.waitExit ?? waitForTreeExit;
    try {
      const result = await killTree(pid);
      if (result.refused !== undefined) return false;
      const gone = await waitExit(pid, result.snapshot, IDE_STOP_EXIT_TIMEOUT_MS);
      if (!gone) log('WARN', `IDE server pid ${pid} never listened, and its tree outlived the kill`);
      return gone;
    } catch (err) {
      log('WARN', `IDE server pid ${pid} never listened, and killing its tree failed: ${(err as Error).message}`);
      return false;
    }
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    log('WARN', `IDE server pid ${pid} never listened, and SIGTERM to its group failed: ${code ?? (err as Error).message}`);
    return false;
  }
  const deadline = Date.now() + IDE_STOP_EXIT_TIMEOUT_MS;
  while (isGroupAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  }
  if (!isGroupAlive(pid)) return true;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // exited between the check and the kill
  }
  log('WARN', `IDE server pid ${pid} never listened and ignored SIGTERM; SIGKILL sent to its group`);
  await new Promise((r) => setTimeout(r, STOP_POLL_MS));
  return !isGroupAlive(pid);
}

/** Seams for the Windows stop path; production uses the real census and tree kill. */
export interface WindowsIdeStopSeams {
  census?: typeof listProcessCensus;
  killTree?: (pid: number) => Promise<unknown>;
  isAlive?: (pid: number) => boolean;
}

/** What a Windows stop kills (`roots`, as trees) and waits on (`targets`). */
export interface WindowsIdeStopPlan {
  roots: number[];
  targets: TreeMember[];
}

/**
 * The roots whose trees a Windows stop kills while the port has listeners.
 * The recorded pid (a `cmd.exe` wrapper, or the server itself) is a root only
 * when the census shows a listener among its descendants: that live listener
 * is what proves the pid still belongs to this server and was not reused. Any
 * listener outside that tree (an adopted server) is a root of its own.
 * `targets` is every process the stop expects to end, with its creation time.
 */
export function windowsIdeStopRoots(
  census: ProcessCensusEntry[],
  recordedPid: number,
  listeners: number[],
): WindowsIdeStopPlan {
  const recordedTree = collectTree(census, recordedPid);
  const roots: number[] = [];
  const targets: TreeMember[] = [];
  const targeted = (pid: number) => targets.some((member) => member.pid === pid);
  if (recordedPid > 0 && listeners.some((pid) => recordedTree.some((member) => member.pid === pid))) {
    roots.push(recordedPid);
    targets.push(...recordedTree);
  }
  for (const pid of listeners) {
    if (targeted(pid)) continue;
    roots.push(pid);
    targets.push(...collectTree(census, pid));
    if (!targeted(pid)) targets.push({ pid, creationTime: null });
  }
  return { roots, targets };
}

/**
 * The plan when nothing listens on the port but the record names a pid: the
 * server may be alive with its port closed. The recorded tree is ours only if
 * a process in it carries Tower's connection-token path on its command line
 * (every spawn passes `--connection-token-file <path>`), so a reused pid is
 * never killed. Otherwise there is nothing of ours to stop.
 */
export function windowsIdeRecordedServerPlan(
  census: ProcessCensusEntry[],
  recordedPid: number,
  tokenPath: string,
): WindowsIdeStopPlan {
  if (recordedPid <= 0) return { roots: [], targets: [] };
  const tree = collectTree(census, recordedPid);
  const marker = tokenPath.replace(/\^/g, '').toLowerCase();
  // A `cmd.exe` root's line carries the path with cmd's `^` escapes.
  const byPid = new Map(census.map((entry) => [entry.pid, entry.cmdline.replace(/\^/g, '').toLowerCase()]));
  const ours = tree.some((member) => (byPid.get(member.pid) ?? '').includes(marker));
  if (!ours) return { roots: [], targets: [] };
  return { roots: [recordedPid], targets: tree };
}

/**
 * Windows stop: kill each root's process tree (`killSessionTree`: census
 * snapshot, `taskkill /T /F`, then any snapshot member still alive), wait for
 * the targets to exit, then delete the record. With no listener, the recorded
 * tree is checked for being this server (`windowsIdeRecordedServerPlan`).
 * Whenever the stop cannot tell what is running (the port query failed, or
 * there is no listener and the census failed) or a target outlives the wait,
 * the record is kept and the stop throws, so the server stays tracked and the
 * stop can be retried. A census failure with listeners falls back to their
 * trees alone. Survivors are re-checked by creation time, so a pid reused
 * during the wait is not reported.
 */
export async function stopWindowsIdeServer(
  record: IdeServerRecord,
  listeners: number[] | null,
  log: LogFn,
  seams: WindowsIdeStopSeams = {},
): Promise<{ stopped: boolean; port: number | null }> {
  const census = seams.census ?? listProcessCensus;
  const killTree = seams.killTree ?? ((pid: number) => killSessionTree(pid));
  const isAlive = seams.isAlive ?? isPidAlive;
  const keep = (reason: string): Error =>
    new Error(`IDE server on port ${record.port} was not stopped: ${reason}; the record is kept so the stop can be retried`);

  if (listeners === null) throw keep('the port query failed, so its processes are unknown');

  let snapshot: ProcessCensusEntry[] | null = null;
  try {
    snapshot = await census({ fresh: true });
  } catch (err) {
    log('WARN', `IDE server stop: process census failed (${(err as Error).message})`);
  }

  let plan: WindowsIdeStopPlan;
  if (listeners.length === 0) {
    if (snapshot === null) throw keep(`the process census failed, so whether pid ${record.pid} still runs is unknown`);
    plan = windowsIdeRecordedServerPlan(snapshot, record.pid, getIdeConnectionTokenPath());
  } else if (snapshot === null) {
    log('WARN', "IDE server stop: killing the listeners' trees only");
    plan = { roots: listeners, targets: listeners.map((pid) => ({ pid, creationTime: null })) };
  } else {
    plan = windowsIdeStopRoots(snapshot, record.pid, listeners);
  }

  for (const pid of plan.roots) {
    try {
      await killTree(pid);
    } catch (err) {
      log('WARN', `IDE server stop: tree kill of pid ${pid} failed: ${(err as Error).message}`);
    }
  }

  const deadline = Date.now() + IDE_STOP_EXIT_TIMEOUT_MS;
  let survivors = plan.targets.filter((member) => isAlive(member.pid));
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
    survivors = survivors.filter((member) => isAlive(member.pid));
  }
  if (survivors.length > 0) {
    survivors = await sameSurvivors(survivors, census);
  }

  if (survivors.length > 0) {
    const pids = survivors.map((member) => member.pid).join(', ');
    log('WARN', `IDE server stop: processes survived the tree kill: ${pids}`);
    throw keep(`process(es) ${pids} still running`);
  }
  deleteIdeRecord();
  log('INFO', `Stopped IDE server on port ${record.port} (${plan.targets.length} process(es))`);
  return { stopped: plan.targets.length > 0, port: record.port };
}

/**
 * Survivors that are still the processes the stop targeted: present in a fresh
 * census with the recorded creation time. One recorded without a creation
 * time, or a failed census, counts as surviving (fail safe: the record stays).
 */
async function sameSurvivors(survivors: TreeMember[], census: typeof listProcessCensus): Promise<TreeMember[]> {
  let fresh: ProcessCensusEntry[];
  try {
    fresh = await census({ fresh: true });
  } catch {
    return survivors;
  }
  const createdByPid = new Map(fresh.map((entry) => [entry.pid, entry.creationTime ?? null]));
  return survivors.filter((member) => {
    if (!createdByPid.has(member.pid)) return false;
    if (member.creationTime === null) return true;
    return createdByPid.get(member.pid) === member.creationTime;
  });
}

export interface IdeStatus {
  record: IdeServerRecord | null;
  alive: boolean;
  pid: number | null;
}

/** Report the IDE server's status from the record plus a live port probe. */
export async function ideServerStatus(): Promise<IdeStatus> {
  const record = readIdeRecord();
  if (!record) return { record: null, alive: false, pid: null };
  const pids = await getProcessesOnPortAsync(record.port);
  // Windows: a failed port query is unknown, not dead; fall back to a connect.
  if (pids === null) return { record, alive: await isPortListening(record.port), pid: null };
  return { record, alive: pids.length > 0, pid: pids[0] ?? null };
}

// Guards against two concurrent `/ide/` requests both triggering a respawn.
let respawnInFlight: Promise<number | null> | null = null;

/**
 * Ensure the IDE server is live and return its port, or null if it cannot be
 * made live (no record, or a respawn that never bound). A live server is the
 * fast path (no spawn). A recorded-but-dead server is respawned from the
 * recorded `serverPath`; concurrent callers share one in-flight respawn.
 */
export async function ensureIdeServerLive(log: LogFn = () => {}): Promise<number | null> {
  const record = readIdeRecord();
  if (!record) return null;
  if (await isPortListening(record.port)) return record.port;

  if (respawnInFlight) return respawnInFlight;
  respawnInFlight = withIdeLock(() => respawnRecordedIdeServer(log)).finally(() => {
    respawnInFlight = null;
  });
  return respawnInFlight;
}

/**
 * The respawn body, run under the lock. It re-reads the record first: a start
 * or stop queued ahead of it may have changed or removed the record, or
 * already brought the server up.
 */
async function respawnRecordedIdeServer(log: LogFn): Promise<number | null> {
  try {
    const current = readIdeRecord();
    if (!current) return null;
    if (await isPortListening(current.port)) return current.port;
    log('INFO', `IDE server on port ${current.port} is down; respawning from ${current.serverPath}`);
    const fresh = await spawnIdeServerUnlocked(
      { serverPath: current.serverPath, port: current.port },
      log,
    );
    return fresh.record.port;
  } catch (err) {
    log('WARN', `IDE server respawn failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Boot-time reconcile: adopt a live server (no orphan) or respawn a recorded
 * but dead one. Best-effort — never throws into Tower boot.
 */
export async function reconcileIdeServer(log: LogFn): Promise<void> {
  const record = readIdeRecord();
  if (!record) return;
  if (await isPortListening(record.port)) {
    log('INFO', `Adopted running IDE server on port ${record.port}`);
    return;
  }
  await ensureIdeServerLive(log);
}

/**
 * Local-only `/api/ide` management endpoint driving the lifecycle above:
 * `POST` starts (body `{ serverPath, port? }`), `DELETE` stops,
 * `GET` reports status. Reached only post-`isRequestAllowed` (key required) and
 * blocked from the tunnel like `/api/tunnel/*` — it spawns/kills a process.
 */
export async function handleIdeApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  log: LogFn,
): Promise<void> {
  if (req.method === 'GET') {
    const status = await ideServerStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  if (req.method === 'DELETE') {
    let result: { stopped: boolean; port: number | null };
    try {
      result = await stopIdeServer(log);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }
    const serverPath = typeof body.serverPath === 'string' ? body.serverPath : '';
    const port = typeof body.port === 'number' ? body.port : undefined;
    if (!serverPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'serverPath is required' }));
      return;
    }
    try {
      const { record, restartRequired } = await spawnIdeServer({ serverPath, port }, log);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...record, restartRequired }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}
