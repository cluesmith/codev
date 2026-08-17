import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AGENT_FARM_DIR } from './constants.js';

const LOCAL_KEY_PATH = resolve(AGENT_FARM_DIR, 'local-key');

/**
 * Optional environment override for the shared Tower key. When `CODEV_TOWER_KEY`
 * is set it IS the key on both sides: Tower treats it as the expected key and
 * clients present it. This is the supported way to authenticate across a boundary
 * where the client does not share Tower's `local-key` file — a host CLI/SDK
 * reaching a Tower inside a container, or a Tower on a non-loopback bind
 * (`BRIDGE_MODE`). Set the SAME value on Tower and every client. It must be the
 * Tower's 64-hex key (the browser dashboard shell only injects a well-formed
 * key). Unset for same-host loopback use, where the `local-key` file is the
 * source of truth.
 */
function keyOverride(): string | null {
  const v = process.env.CODEV_TOWER_KEY;
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the local auth key. Honors the `CODEV_TOWER_KEY` env override; otherwise
 * reads it from disk, returning null if the file doesn't exist. Read-only — does
 * not create directories or generate keys. Safe for use in the VS Code extension.
 */
export function readLocalKey(): string | null {
  const override = keyOverride();
  if (override) return override;
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
  const override = keyOverride();
  if (override) return override;

  if (!existsSync(AGENT_FARM_DIR)) {
    mkdirSync(AGENT_FARM_DIR, { recursive: true, mode: 0o700 });
  }

  if (!existsSync(LOCAL_KEY_PATH)) {
    const key = randomBytes(32).toString('hex');
    writeFileSync(LOCAL_KEY_PATH, key, { mode: 0o600 });
    return key;
  }

  // Repair permissions on an existing key file: `mode` on writeFileSync only
  // applies at creation, so a key written before this hardening (or by another
  // tool) may be world-readable. Tighten it to 0600 on read (best effort;
  // chmod is a no-op on platforms that don't support POSIX modes).
  try {
    chmodSync(LOCAL_KEY_PATH, 0o600);
  } catch {
    /* best effort — platform may not support chmod */
  }
  return readFileSync(LOCAL_KEY_PATH, 'utf-8').trim();
}
