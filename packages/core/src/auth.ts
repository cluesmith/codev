import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AGENT_FARM_DIR } from './constants.js';

const LOCAL_KEY_PATH = resolve(AGENT_FARM_DIR, 'local-key');

/**
 * Read the local auth key from disk. Returns null if file doesn't exist.
 * Read-only — does not create directories or generate keys.
 * Safe for use in the VS Code extension.
 */
export function readLocalKey(): string | null {
  try {
    return readFileSync(LOCAL_KEY_PATH, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get or create the local auth key. Creates ~/.agent-farm/ and generates
 * a random key if missing. CLI-only — the extension should use readLocalKey().
 */
export function ensureLocalKey(): string {
  if (!existsSync(AGENT_FARM_DIR)) {
    mkdirSync(AGENT_FARM_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(LOCAL_KEY_PATH)) {
    const key = randomBytes(32).toString('hex');
    writeFileSync(LOCAL_KEY_PATH, key, { mode: 0o600 });
    return key;
  }

  return readFileSync(LOCAL_KEY_PATH, 'utf-8').trim();
}
