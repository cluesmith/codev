/**
 * Workspace-path canonicalization (single source of truth).
 *
 * The `workspace_path` column keys the architect and builders tables. Writers
 * and readers MUST agree on its exact form, so every callsite normalizes through
 * this one helper: the symlink-dereferenced real path when it exists on disk,
 * else `path.resolve` for not-yet-existing paths (fresh installs).
 *
 * This is a leaf module (imports only node builtins) so both the data layer
 * (state.ts, db/consolidate.ts) and the server layer (servers/tower-utils.ts and
 * its importers) can share it without a dependency cycle — the reason the data
 * layer previously kept an inline copy rather than importing from the
 * server-layer tower-utils.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export function normalizeWorkspacePath(workspacePath: string): string {
  try {
    return realpathSync(workspacePath);
  } catch {
    // Path doesn't exist yet — normalize without realpath.
    return resolve(workspacePath);
  }
}
