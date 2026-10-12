/**
 * `afx ide start | stop | status | install` (Issue #1668, Spec 1789).
 *
 * Thin client over Tower's local-only `/api/ide` endpoint: Tower is the spawner
 * (so boot reconcile and on-demand respawn reuse the same path), and these
 * commands drive it. Runtime state lives in Tower's `~/.agent-farm/ide-server.json`
 * record — there is no config file and no database change (Issue #1668 §D3).
 *
 * Server discovery runs here, in the user's shell environment, because Tower's
 * daemon `PATH` may predate the server install or lack the npm global bin.
 * `afx ide install` runs npm here too: Tower never exposes an endpoint that runs it.
 */

import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { delimiter, dirname, join, resolve } from 'node:path';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { DEFAULT_TOWER_PORT } from '../lib/tower-client.js';
import {
  IDE_SERVER_UPGRADE_COMMAND,
  IDE_START_BUDGET_MS,
  IDE_VERSION_TIMEOUT_MS,
  IdeServerCommandError,
  buildIdeServerEnv,
  runIdeServerCommand,
} from '../lib/ide-version.js';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';

/** The server's bin name, on `PATH` and in its package's `bin` map. */
export const IDE_SERVER_BIN = 'codev-ide-server';
/** The npm meta-package that provides the server. */
export const IDE_SERVER_PACKAGE = '@cluesmith/codev-ide';

/** Bound on `GET /api/ide`, which only reads the record and probes the port. */
const IDE_STATUS_TIMEOUT_MS = 10_000;
/** Bound on `npm root -g` during discovery. */
const NPM_ROOT_TIMEOUT_MS = 10_000;

/** Root of the running codev install (`src/agent-farm/commands` and `dist/agent-farm/commands` alike). */
const CODEV_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

interface TowerResponse {
  status: number;
  body: unknown;
}

/**
 * Make a key-authed request to Tower's local `/api/ide` endpoint. Rejects with a
 * clear message when Tower isn't running (the endpoint is Tower-hosted).
 */
function towerIdeRequest(method: string, timeoutMs: number, body?: unknown): Promise<TowerResponse> {
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    try {
      headers[TOWER_KEY_HEADER] = ensureLocalKey();
    } catch {
      // Key unavailable — the request will 401; surfaced to the caller.
    }
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(payload));
    }
    const req = http.request(
      { hostname: '127.0.0.1', port: DEFAULT_TOWER_PORT, path: '/api/ide', method, headers, timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            // leave as raw text
          }
          resolvePromise({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        reject(new Error('Tower is not running. Start it with: afx tower start'));
      } else {
        reject(err);
      }
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timed out after ${timeoutMs / 1000}s waiting for Tower`));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable `name` in a `PATH` string, scanned directly (no `which` subprocess). */
function findOnPath(name: string, pathValue: string): string | null {
  for (const entry of pathValue.split(delimiter)) {
    if (entry === '') continue;
    const candidate = resolve(entry, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** The server bin inside an installed `@cluesmith/codev-ide` package directory, or null. */
function packageServerBin(packageDir: string): string | null {
  let pkg: { name?: unknown; bin?: unknown };
  try {
    pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8'));
  } catch {
    return null;
  }
  if (pkg.name !== IDE_SERVER_PACKAGE) return null;
  let relativeBin: unknown = pkg.bin;
  if (typeof pkg.bin === 'object' && pkg.bin !== null) {
    relativeBin = (pkg.bin as Record<string, unknown>)[IDE_SERVER_BIN];
  }
  if (typeof relativeBin !== 'string') return null;
  const candidate = resolve(packageDir, relativeBin);
  if (!isExecutableFile(candidate)) return null;
  return candidate;
}

/** `npm root -g` in the given environment, or null when npm is missing, fails or times out. */
function npmGlobalRoot(env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile('npm', ['root', '-g'], { env, timeout: NPM_ROOT_TIMEOUT_MS }, (error, stdout) => {
      const root = String(stdout).trim();
      if (error || root === '') {
        resolvePromise(null);
        return;
      }
      resolvePromise(root);
    });
  });
}

export interface ResolveIdeServerPathOptions {
  /** `--server-path`: wins without consulting discovery. */
  serverPath?: string;
  /** Environment whose `PATH` is searched (and npm runs in). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Root of the running codev install, whose sibling `codev-ide` is checked. */
  codevRoot?: string;
}

/**
 * Find the Codev IDE server: `--server-path` if given (throws when it does not
 * exist), else `codev-ide-server` on `PATH`, else `@cluesmith/codev-ide` as a
 * sibling of the running codev install, else under `npm root -g`. Returns an
 * absolute path that is deliberately not realpath'd, so an in-place
 * `npm i -g` upgrade takes effect on the next respawn; null when nothing is found.
 */
export async function resolveIdeServerPath(opts: ResolveIdeServerPathOptions = {}): Promise<string | null> {
  if (opts.serverPath !== undefined) {
    const explicit = resolve(opts.serverPath);
    if (!existsSync(explicit)) {
      throw new Error(`IDE server binary not found at ${explicit}`);
    }
    return explicit;
  }

  const env = opts.env ?? process.env;
  const onPath = findOnPath(IDE_SERVER_BIN, env.PATH ?? '');
  if (onPath !== null) return onPath;

  const codevRoot = opts.codevRoot ?? CODEV_PACKAGE_ROOT;
  const sibling = packageServerBin(resolve(codevRoot, '..', 'codev-ide'));
  if (sibling !== null) return sibling;

  const globalRoot = await npmGlobalRoot(env);
  if (globalRoot === null) return null;
  return packageServerBin(join(globalRoot, '@cluesmith', 'codev-ide'));
}

const SERVER_NOT_FOUND_MESSAGE =
  `Codev IDE server not found: no ${IDE_SERVER_BIN} on PATH or in the global node_modules.\n` +
  `  Install it with: afx ide install (runs ${IDE_SERVER_UPGRADE_COMMAND})\n` +
  '  Or point at a binary with: afx ide start --server-path <bin>';

export interface IdeStartOptions {
  serverPath?: string;
  port?: number;
  defaultFolder?: string;
}

/** `afx ide start`: discover the server, then ask Tower to spawn it. */
export async function ideStart(options: IdeStartOptions = {}): Promise<void> {
  let serverPath: string | null;
  try {
    serverPath = await resolveIdeServerPath({ serverPath: options.serverPath });
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (serverPath === null) {
    logger.error(SERVER_NOT_FOUND_MESSAGE);
    process.exit(1);
  }

  logger.header('Starting IDE server');
  logger.kv('Server', serverPath);
  logger.info('Checking the server version and installing the Codev sidebar (the first start can take a minute)...');
  const res = await towerIdeRequest('POST', IDE_START_BUDGET_MS, {
    serverPath,
    port: options.port,
    defaultFolder: options.defaultFolder ? resolve(options.defaultFolder) : undefined,
  });

  if (res.status === 200) {
    const rec = res.body as {
      port?: number;
      pid?: number;
      serverVersion?: string;
      sidebarVersion?: string;
      restartRequired?: boolean;
    };
    logger.success('IDE server started');
    logger.kv('Prefix', '/ide/');
    logger.kv('Port', rec.port ?? '?');
    logger.kv('PID', rec.pid ?? '?');
    logger.kv('Server version', rec.serverVersion ?? 'unknown');
    logger.kv('Sidebar version', rec.sidebarVersion ?? 'unknown');
    if (rec.restartRequired) {
      logger.warn('The running IDE server predates this start; restart it to load the current server and sidebar: afx ide stop && afx ide start');
    }
  } else {
    const err = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
    logger.error(`Failed to start IDE server: ${err}`);
    process.exit(1);
  }
}

/** `afx ide stop` — ask Tower to tear the IDE server down. */
export async function ideStop(): Promise<void> {
  logger.header('Stopping IDE server');
  const res = await towerIdeRequest('DELETE', IDE_START_BUDGET_MS);
  if (res.status === 200) {
    const result = res.body as { stopped?: boolean; port?: number | null };
    if (result.stopped) {
      logger.success(`IDE server stopped (port ${result.port})`);
    } else {
      logger.info('IDE server was not running');
    }
  } else {
    const err = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
    logger.error(`Failed to stop IDE server: ${err}`);
    process.exit(1);
  }
}

/** `afx ide status` — report the IDE server's prefix, port, PID, and liveness. */
export async function ideStatus(): Promise<void> {
  const res = await towerIdeRequest('GET', IDE_STATUS_TIMEOUT_MS);
  if (res.status !== 200) {
    const err = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
    logger.error(`Failed to read IDE server status: ${err}`);
    process.exit(1);
  }
  const status = res.body as {
    record: {
      prefix: string;
      port: number;
      serverPath: string;
      defaultFolder?: string;
      serverVersion?: string;
      extensionsDir?: string;
      sidebarVersion?: string;
    } | null;
    alive: boolean;
    pid: number | null;
  };

  logger.header('IDE server status');
  if (!status.record) {
    logger.info('No IDE server registered. Start one with: afx ide start');
    return;
  }
  logger.kv('Prefix', status.record.prefix);
  logger.kv('Port', status.record.port);
  logger.kv('Server', status.record.serverPath);
  logger.kv('Server version', status.record.serverVersion ?? 'unknown');
  logger.kv('Extensions dir', status.record.extensionsDir ?? 'unknown');
  logger.kv('Sidebar version', status.record.sidebarVersion ?? 'unknown');
  if (status.record.defaultFolder) logger.kv('Default folder', status.record.defaultFolder);
  logger.kv('Running', status.alive ? `yes (PID ${status.pid})` : 'no (recorded but not live)');
  logger.blank();
  logger.info('Note: each open IDE browser window runs its own extension host (~100–300 MB); N windows = N hosts.');
}

/** Run `npm i -g @cluesmith/codev-ide` with npm's output on this terminal; resolves with its exit status. */
function runNpmInstall(): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn('npm', ['i', '-g', IDE_SERVER_PACKAGE], { stdio: 'inherit' });
    child.on('error', (error) => {
      logger.error(`Could not run npm: ${error.message}`);
      resolvePromise(1);
    });
    child.on('close', (code) => {
      resolvePromise(code ?? 1);
    });
  });
}

/**
 * `afx ide install`: run `npm i -g @cluesmith/codev-ide` in the user's own
 * environment (never through Tower), exit with npm's status, and on success
 * report the server discovery now finds and its `--version` line 1.
 */
export async function ideInstall(): Promise<void> {
  logger.header('Installing the Codev IDE server');
  logger.info(`Running: ${IDE_SERVER_UPGRADE_COMMAND}`);
  const status = await runNpmInstall();
  if (status !== 0) {
    logger.error(`npm exited with status ${status}`);
    process.exit(status);
  }

  const serverPath = await resolveIdeServerPath();
  if (serverPath === null) {
    logger.warn(`npm finished, but ${IDE_SERVER_BIN} is not on PATH or in the global node_modules`);
    return;
  }
  try {
    const run = await runIdeServerCommand(serverPath, ['--version'], {
      timeoutMs: IDE_VERSION_TIMEOUT_MS,
      env: buildIdeServerEnv(),
    });
    const version = run.stdout.split(/\r?\n/, 1)[0].trim();
    logger.success(`Installed Codev IDE server ${version}`);
    logger.kv('Server', serverPath);
  } catch (error) {
    if (!(error instanceof IdeServerCommandError)) throw error;
    logger.warn(`Installed ${serverPath}, but its --version failed (${error.message})`);
  }
}
