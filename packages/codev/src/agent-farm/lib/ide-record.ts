/**
 * IDE server runtime record (Issue #1668).
 *
 * Tower forwards a fixed `/ide/` prefix to a single local VS Code server-web
 * process. That server's runtime facts — the port it listens on, the binary it
 * was spawned from, and its PID — live here, in a Tower-managed JSON file under
 * `~/.agent-farm/`, exactly as `cloud-config.json` and `machine-id` do.
 *
 * This is deliberately NOT a user-facing config file and NOT a `global.db`
 * table (Issue #1668 Decisions §D3): a single server is a singleton, so its
 * state belongs beside the other `~/.agent-farm` singletons, written by Tower,
 * never hand-edited. Tower is the sole writer; `afx ide` drives it through the
 * local `/api/ide` endpoint.
 */

import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { AGENT_FARM_DIR } from './tower-client.js';

/** The fixed Tower prefix that routes to the IDE server (Issue #1668 §D1). */
export const IDE_DEFAULT_PREFIX = '/ide/';

/** Default port the local IDE server listens on when `--port` is not given. */
export const IDE_DEFAULT_PORT = 8200;

const IDE_RECORD_FILENAME = 'ide-server.json';
const IDE_CONNECTION_TOKEN_FILENAME = 'ide-connection-token';

/**
 * The single running IDE server's runtime facts. `prefix` is stored for status
 * display but is always the fixed constant; the live PID is authoritative only
 * as a cross-check — port-based discovery (`getProcessesOnPort`) is the source
 * of truth for liveness.
 */
export interface IdeServerRecord {
  prefix: string;
  port: number;
  serverPath: string;
  pid: number;
  defaultFolder?: string;
  startedAt: string;
}

/** Path to `~/.agent-farm/ide-server.json`. */
export function getIdeRecordPath(): string {
  return resolve(AGENT_FARM_DIR, IDE_RECORD_FILENAME);
}

/** Path to the Tower-owned IDE connection-token file. */
export function getIdeConnectionTokenPath(): string {
  return resolve(AGENT_FARM_DIR, IDE_CONNECTION_TOKEN_FILENAME);
}

/**
 * Read the IDE server record, or null if it does not exist or is unreadable /
 * malformed (fail soft — a corrupt record must never wedge request routing;
 * the caller treats null as "no server registered").
 */
export function readIdeRecord(): IdeServerRecord | null {
  const path = getIdeRecordPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<IdeServerRecord>;
    if (
      typeof parsed.prefix !== 'string' ||
      typeof parsed.port !== 'number' ||
      typeof parsed.serverPath !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.startedAt !== 'string'
    ) {
      return null;
    }
    return {
      prefix: parsed.prefix,
      port: parsed.port,
      serverPath: parsed.serverPath,
      pid: parsed.pid,
      defaultFolder: typeof parsed.defaultFolder === 'string' ? parsed.defaultFolder : undefined,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

/** Write the IDE server record, creating `~/.agent-farm/` if needed. */
export function writeIdeRecord(record: IdeServerRecord): void {
  if (!existsSync(AGENT_FARM_DIR)) {
    mkdirSync(AGENT_FARM_DIR, { recursive: true, mode: 0o700 });
  }
  const path = getIdeRecordPath();
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  // `mode` only applies on creation; enforce 0600 even if the file pre-existed.
  chmodSync(path, 0o600);
}

/** Delete the IDE server record. No-op if it does not exist. */
export function deleteIdeRecord(): void {
  const path = getIdeRecordPath();
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Read the Tower-owned connection token, or null if it does not exist yet.
 *
 * The forward presents this token to the IDE server as a `vscode-tkn` cookie
 * (Issue #1668): the server is spawned with `--connection-token-file`, so it
 * 403s any request that does not carry the token. The token cannot ride the
 * browser's own cookie jar through the relay — the server's `Set-Cookie` is
 * scoped `Path=/ide`, which never matches the external `/t/<tower>/ide/` — so
 * Tower injects it at the forward instead.
 */
export function readIdeConnectionToken(): string | null {
  const path = getIdeConnectionTokenPath();
  if (!existsSync(path)) return null;
  const token = readFileSync(path, 'utf-8').trim();
  return token.length > 0 ? token : null;
}

/**
 * Return the Tower-owned connection token, generating and persisting one (0600)
 * on first use. This token is the IDE server's own inner auth layer (passed via
 * `--connection-token-file`); it is NOT a substitute for Tower's key check on
 * the forward (Issue #1668 §D2).
 */
export function ensureIdeConnectionToken(): string {
  const path = getIdeConnectionTokenPath();
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8').trim();
    if (existing.length > 0) return existing;
  }
  if (!existsSync(AGENT_FARM_DIR)) {
    mkdirSync(AGENT_FARM_DIR, { recursive: true, mode: 0o700 });
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(path, token + '\n', { mode: 0o600 });
  chmodSync(path, 0o600); // enforce 0600 even if the file pre-existed
  return token;
}
