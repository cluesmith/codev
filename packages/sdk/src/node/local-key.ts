/**
 * Node-only auth adapter (`@cluesmith/codev-sdk/node`): the read-only
 * local-key profile for Node consumers of the sdk (the VS Code extension
 * host, standalone controllers like the Stream Deck plugin).
 *
 * READS (never generates) the key at `~/.agent-farm/local-key`; Tower owns
 * generation, and issuance (`ensureLocalKey`) stays in `@cluesmith/codev-core`.
 * Pass this as `getAuthKey` when constructing a `TowerClient`.
 *
 * This is the one Node-entangled corner of the sdk. The import-boundary test
 * exempts `src/node/` from the node-builtin ban and asserts that nothing in
 * the environment-agnostic graph imports it, so Metro and browser consumers
 * never resolve it.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const LOCAL_KEY_PATH = resolve(homedir(), '.agent-farm', 'local-key');

/**
 * Read the local auth key, or null if Tower has never created it.
 *
 * Honors the `CODEV_TOWER_KEY` environment override: when set, it IS the key this
 * client presents, so a Node consumer (VS Code host, Stream Deck plugin) can reach
 * a Tower whose `local-key` file it does not share — a Tower inside a container or
 * on a non-loopback `BRIDGE_MODE` bind. Set the same value Tower uses. Unset for
 * same-host loopback, where the file is the source of truth. (The env name is
 * duplicated here rather than imported: the sdk cannot import `@cluesmith/codev-core`
 * or `@cluesmith/codev-types` at runtime — server/client isolation, issue #1189.)
 */
export function readLocalKey(): string | null {
  const override = process.env.CODEV_TOWER_KEY?.trim();
  if (override) return override;
  try {
    return readFileSync(LOCAL_KEY_PATH, 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
