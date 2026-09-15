/**
 * `afx ide start | stop | status` (Issue #1668).
 *
 * Thin client over Tower's local-only `/api/ide` endpoint: Tower is the spawner
 * (so boot reconcile and on-demand respawn reuse the same path), and these
 * commands drive it. Runtime state lives in Tower's `~/.agent-farm/ide-server.json`
 * record — there is no config file and no database change (Issue #1668 §D3).
 */

import http from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { DEFAULT_TOWER_PORT } from '../lib/tower-client.js';
import { ensureLocalKey } from '@cluesmith/codev-core/auth';
import { TOWER_KEY_HEADER } from '@cluesmith/codev-types';

interface TowerResponse {
  status: number;
  body: unknown;
}

/**
 * Make a key-authed request to Tower's local `/api/ide` endpoint. Rejects with a
 * clear message when Tower isn't running (the endpoint is Tower-hosted).
 */
function towerIdeRequest(method: string, body?: unknown): Promise<TowerResponse> {
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
      { hostname: '127.0.0.1', port: DEFAULT_TOWER_PORT, path: '/api/ide', method, headers, timeout: 30_000 },
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
      reject(new Error('Timed out talking to Tower'));
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export interface IdeStartOptions {
  serverPath?: string;
  port?: number;
  defaultFolder?: string;
}

/** `afx ide start` — ask Tower to spawn the IDE server. */
export async function ideStart(options: IdeStartOptions = {}): Promise<void> {
  if (!options.serverPath) {
    logger.error('--server-path is required (there is no default — the codev-ide server-web build is not shipped with codev).');
    process.exit(1);
  }
  const serverPath = resolve(options.serverPath);
  if (!existsSync(serverPath)) {
    logger.error(`IDE server binary not found at ${serverPath}`);
    process.exit(1);
  }

  logger.header('Starting IDE server');
  const res = await towerIdeRequest('POST', {
    serverPath,
    port: options.port,
    defaultFolder: options.defaultFolder ? resolve(options.defaultFolder) : undefined,
  });

  if (res.status === 200) {
    const rec = res.body as { port?: number; pid?: number };
    logger.success('IDE server started');
    logger.kv('Prefix', '/ide/');
    logger.kv('Port', rec.port ?? '?');
    logger.kv('PID', rec.pid ?? '?');
  } else {
    const err = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
    logger.error(`Failed to start IDE server: ${err}`);
    process.exit(1);
  }
}

/** `afx ide stop` — ask Tower to tear the IDE server down. */
export async function ideStop(): Promise<void> {
  logger.header('Stopping IDE server');
  const res = await towerIdeRequest('DELETE');
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
  const res = await towerIdeRequest('GET');
  if (res.status !== 200) {
    const err = (res.body as { error?: string })?.error ?? `HTTP ${res.status}`;
    logger.error(`Failed to read IDE server status: ${err}`);
    process.exit(1);
  }
  const status = res.body as {
    record: { prefix: string; port: number; serverPath: string; defaultFolder?: string } | null;
    alive: boolean;
    pid: number | null;
  };

  logger.header('IDE server status');
  if (!status.record) {
    logger.info('No IDE server registered. Start one with: afx ide start --server-path <bin>');
    return;
  }
  logger.kv('Prefix', status.record.prefix);
  logger.kv('Port', status.record.port);
  logger.kv('Server', status.record.serverPath);
  if (status.record.defaultFolder) logger.kv('Default folder', status.record.defaultFolder);
  logger.kv('Running', status.alive ? `yes (PID ${status.pid})` : 'no (recorded but not live)');
  logger.blank();
  logger.info('Note: each open IDE browser window runs its own extension host (~100–300 MB); N windows = N hosts.');
}
