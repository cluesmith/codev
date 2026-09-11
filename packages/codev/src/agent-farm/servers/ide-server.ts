/**
 * IDE server lifecycle, Tower-side (Issue #1668).
 *
 * Tower is the spawner: `afx ide start` drives this through the local-only
 * `/api/ide` endpoint, and the same spawn path is reused by boot reconcile and
 * by on-demand respawn when a `/ide/` request arrives and the server is down.
 * Runtime state lives in the `~/.agent-farm/ide-server.json` record (Issue
 * #1668 §D3) — no config file, no `global.db` change. Liveness is discovered by
 * port (`getProcessesOnPort`), the same way Tower finds its own process.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { getProcessesOnPort } from '../utils/port.js';
import { sanitizeAgentEnv } from '../../lib/agent-env.js';
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

type LogFn = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;

const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 200;

/** True if some process is listening on the port. */
function isPortLive(port: number): boolean {
  return getProcessesOnPort(port).length > 0;
}

/** Poll until a process is listening on `port`, or the timeout elapses. */
async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isPortLive(port)) return true;
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return isPortLive(port);
}

export interface SpawnIdeOptions {
  serverPath: string;
  port?: number;
  defaultFolder?: string;
}

/**
 * Spawn the IDE server detached (so it survives a Tower restart, like a
 * shellper) and write the runtime record. Resolves to the record once the
 * server is listening, or throws if the binary is missing or never binds.
 */
export async function spawnIdeServer(opts: SpawnIdeOptions, log: LogFn): Promise<IdeServerRecord> {
  const port = opts.port ?? IDE_DEFAULT_PORT;
  if (!opts.serverPath) {
    throw new Error('IDE server path is required (no default — set --server-path)');
  }
  if (!existsSync(opts.serverPath)) {
    throw new Error(`IDE server binary not found at ${opts.serverPath}`);
  }

  // Already live on the port — idempotent: adopt and record, don't double-spawn.
  if (isPortLive(port)) {
    log('INFO', `IDE server already listening on port ${port}; adopting`);
    const pid = getProcessesOnPort(port)[0] ?? 0;
    const record: IdeServerRecord = {
      prefix: IDE_DEFAULT_PREFIX,
      port,
      serverPath: opts.serverPath,
      pid,
      defaultFolder: opts.defaultFolder,
      startedAt: new Date().toISOString(),
    };
    writeIdeRecord(record);
    return record;
  }

  const basePath = IDE_DEFAULT_PREFIX.replace(/\/$/, ''); // "/ide"
  const tokenFile = getIdeConnectionTokenPath();
  ensureIdeConnectionToken();

  const args = [
    '--host', '127.0.0.1',
    '--port', String(port),
    '--server-base-path', basePath,
    '--connection-token-file', tokenFile,
    '--accept-server-license-terms',
  ];
  if (opts.defaultFolder) {
    args.push('--default-folder', opts.defaultFolder);
  }

  log('INFO', `Spawning IDE server: ${opts.serverPath} ${args.join(' ')}`);
  const child = spawn(opts.serverPath, args, {
    cwd: process.cwd(),
    env: sanitizeAgentEnv(process.env),
    detached: true,
    stdio: 'ignore',
  });
  if (!child.pid) {
    throw new Error('Failed to spawn IDE server process');
  }
  child.unref();

  const ready = await waitForPort(port, READY_TIMEOUT_MS);
  if (!ready) {
    throw new Error(`IDE server did not start listening on port ${port} within ${READY_TIMEOUT_MS / 1000}s`);
  }

  const record: IdeServerRecord = {
    prefix: IDE_DEFAULT_PREFIX,
    port,
    serverPath: opts.serverPath,
    pid: child.pid,
    defaultFolder: opts.defaultFolder,
    startedAt: new Date().toISOString(),
  };
  writeIdeRecord(record);
  log('INFO', `IDE server listening on port ${port} (pid ${child.pid})`);
  return record;
}

/** Stop the IDE server: kill whatever is listening on the recorded port, delete the record. */
export function stopIdeServer(log: LogFn): { stopped: boolean; port: number | null } {
  const record = readIdeRecord();
  if (!record) {
    return { stopped: false, port: null };
  }
  const pids = getProcessesOnPort(record.port);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  deleteIdeRecord();
  log('INFO', `Stopped IDE server on port ${record.port} (killed ${pids.length} process(es))`);
  return { stopped: pids.length > 0, port: record.port };
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
  if (isPortLive(record.port)) return record.port;

  if (respawnInFlight) return respawnInFlight;
  respawnInFlight = (async () => {
    try {
      log('INFO', `IDE server on port ${record.port} is down; respawning from ${record.serverPath}`);
      const fresh = await spawnIdeServer(
        { serverPath: record.serverPath, port: record.port, defaultFolder: record.defaultFolder },
        log,
      );
      return fresh.port;
    } catch (err) {
      log('WARN', `IDE server respawn failed: ${(err as Error).message}`);
      return null;
    } finally {
      respawnInFlight = null;
    }
  })();
  return respawnInFlight;
}

/**
 * Boot-time reconcile: adopt a live server (no orphan) or respawn a recorded
 * but dead one. Best-effort — never throws into Tower boot.
 */
export async function reconcileIdeServer(log: LogFn): Promise<void> {
  const record = readIdeRecord();
  if (!record) return;
  if (isPortLive(record.port)) {
    log('INFO', `Adopted running IDE server on port ${record.port}`);
    return;
  }
  await ensureIdeServerLive(log);
}

/**
 * Local-only `/api/ide` management endpoint driving the lifecycle above:
 * `POST` starts (body `{ serverPath, port?, defaultFolder? }`), `DELETE` stops,
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
    const result = stopIdeServer(log);
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
    const defaultFolder = typeof body.defaultFolder === 'string' ? body.defaultFolder : undefined;
    if (!serverPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'serverPath is required' }));
      return;
    }
    try {
      const record = await spawnIdeServer({ serverPath, port, defaultFolder }, log);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...record }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}
