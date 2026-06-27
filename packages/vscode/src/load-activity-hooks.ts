/**
 * Thin client-side wrapper over Tower's `GET /api/activity-hooks`.
 *
 * Returns the canonical `ResolvedActivityHooks` for the active workspace, so the
 * extension never parses or merges config files itself. SECURITY: Tower resolves
 * hooks from the PERSONAL config layers only (`~/.codev/config.json` +
 * `.codev/config.local.json`) — never the committed `.codev/config.json` — because
 * hooks open URLs and a committed hook would be a zero-click RCE. The resolved hooks
 * are a workspace-wide concern fetched once and cached in `activity-hooks.ts`.
 */

import type { ResolvedActivityHooks } from '@cluesmith/codev-types';
import type { ConnectionManager } from './connection-manager.js';

/**
 * Returns `null` when Tower is unreachable or the workspace isn't activated, so
 * callers degrade to "no hooks".
 */
export async function loadActivityHooks(
  connectionManager: ConnectionManager,
): Promise<ResolvedActivityHooks | null> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') { return null; }
  return client.getActivityHooks(workspacePath);
}
