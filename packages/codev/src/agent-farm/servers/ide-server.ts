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
import { getProcessesOnPort } from '../utils/port.js';
import { isWindows } from '../../lib/platform.js';
import { collectTree, killSessionTree } from '../../lib/process-tree.js';
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
 * True if some process is listening on the port. Uses `lsof` (`getProcessesOnPort`),
 * which is ~100 ms and synchronous, so it is a **COLD-path only** check — restart
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
    await stopIdeServerUnlocked(log);
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
    throw new Error(`IDE server did not start listening on port ${port} within ${IDE_READY_TIMEOUT_MS / 1000}s`);
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
function adoptLiveIdeServer(
  opts: SpawnIdeOptions,
  port: number,
  existing: IdeServerRecord | null,
  preflight: IdePreflight,
  log: LogFn,
): SpawnIdeResult {
  let prior: IdeServerRecord | null = null;
  if (existing && existing.port === port) {
    prior = existing;
  }
  const restartRequired = prior === null || !liveServerIsCurrent(prior, opts.serverPath, preflight);

  const record: IdeServerRecord = {
    prefix: IDE_DEFAULT_PREFIX,
    port,
    serverPath: prior?.serverPath ?? opts.serverPath,
    pid: getProcessesOnPort(port)[0] ?? 0,
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
  const pids = getProcessesOnPort(record.port);
  if (isWindows()) {
    return stopWindowsIdeServer(record, pids, log);
  }
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

/** Seams for the Windows stop path; production uses the real census and tree kill. */
export interface WindowsIdeStopSeams {
  census?: typeof listProcessCensus;
  killTree?: (pid: number) => Promise<unknown>;
  isAlive?: (pid: number) => boolean;
}

/**
 * The roots whose trees a Windows stop kills. The recorded pid (a `cmd.exe`
 * wrapper, or the server itself) is a root only when the census shows a
 * listener among its descendants: that live listener is what proves the pid
 * still belongs to this server and was not reused. Any listener outside that
 * tree (an adopted server) is a root of its own. `targets` is every process
 * the stop expects to end, for the exit wait.
 */
export function windowsIdeStopRoots(
  census: ProcessCensusEntry[],
  recordedPid: number,
  listeners: number[],
): { roots: number[]; targets: number[] } {
  const recordedTree = collectTree(census, recordedPid).map((member) => member.pid);
  const roots: number[] = [];
  const targets: number[] = [];
  if (recordedPid > 0 && listeners.some((pid) => recordedTree.includes(pid))) {
    roots.push(recordedPid);
    targets.push(...recordedTree);
  }
  for (const pid of listeners) {
    if (!targets.includes(pid)) {
      roots.push(pid);
      targets.push(...collectTree(census, pid).map((member) => member.pid));
      if (!targets.includes(pid)) targets.push(pid);
    }
  }
  return { roots, targets };
}

/**
 * Windows stop: kill each root's process tree (`killSessionTree`: census
 * snapshot, `taskkill /T /F`, then any snapshot member still alive), wait for
 * the targets to exit, then delete the record. A census failure falls back to
 * the listeners alone. A kill that fails is logged and the wait reports what
 * survived.
 */
export async function stopWindowsIdeServer(
  record: IdeServerRecord,
  listeners: number[],
  log: LogFn,
  seams: WindowsIdeStopSeams = {},
): Promise<{ stopped: boolean; port: number | null }> {
  const census = seams.census ?? listProcessCensus;
  const killTree = seams.killTree ?? ((pid: number) => killSessionTree(pid));
  const isAlive = seams.isAlive ?? isPidAlive;

  let plan: { roots: number[]; targets: number[] } = { roots: listeners, targets: listeners };
  if (listeners.length > 0) {
    try {
      plan = windowsIdeStopRoots(await census({ fresh: true }), record.pid, listeners);
    } catch (err) {
      log('WARN', `IDE server stop: process census failed (${(err as Error).message}); killing the listeners' trees only`);
    }
  }

  for (const pid of plan.roots) {
    try {
      await killTree(pid);
    } catch (err) {
      log('WARN', `IDE server stop: tree kill of pid ${pid} failed: ${(err as Error).message}`);
    }
  }

  const deadline = Date.now() + IDE_STOP_EXIT_TIMEOUT_MS;
  let survivors = plan.targets.filter(isAlive);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS));
    survivors = survivors.filter(isAlive);
  }

  deleteIdeRecord();
  let survivorNote = '';
  if (survivors.length > 0) {
    survivorNote = `, ${survivors.length} still running: ${survivors.join(', ')}`;
    log('WARN', `IDE server stop: processes survived the tree kill: ${survivors.join(', ')}`);
  }
  log('INFO', `Stopped IDE server on port ${record.port} (${plan.targets.length} process(es)${survivorNote})`);
  return { stopped: listeners.length > 0, port: record.port };
}

export interface IdeStatus {
  record: IdeServerRecord | null;
  alive: boolean;
  pid: number | null;
}

/** Report the IDE server's status from the record plus a live port probe. */
export function ideServerStatus(): IdeStatus {
  const record = readIdeRecord();
  if (!record) return { record: null, alive: false, pid: null };
  const pids = getProcessesOnPort(record.port);
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
    const status = ideServerStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  if (req.method === 'DELETE') {
    const result = await stopIdeServer(log);
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
