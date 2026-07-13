/**
 * Thin client-side wrapper over Tower's `GET /api/worktree-config`.
 *
 * Returns the canonical `ResolvedWorktreeConfig` for the active
 * workspace — Tower applies the full five-layer deep-merge (defaults
 * / cache / global / project / project-local), so the extension
 * never has to parse or merge `.codev/config(.local).json` itself.
 *
 * Lives at the top level of `src/` because multiple consumers need
 * it (the Workspace tree view, the `Codev: Open Dev URL` command,
 * any future config-driven UI). Past versions had this inlined in
 * `commands/open-dev-url.ts`, but that file's job is one command;
 * the resolved config is a workspace-wide concern.
 */

import type { ResolvedWorktreeConfig, WorktreeDevUrl } from '@cluesmith/codev-types';
import type { ConnectionManager } from './connection-manager.js';

export type { ResolvedWorktreeConfig, WorktreeDevUrl };

/**
 * Returns `null` when Tower is unreachable or the workspace isn't
 * activated. Callers extract whichever field they need (e.g.
 * `(await loadWorktreeConfig(cm))?.devUrls ?? []`).
 */
export async function loadWorktreeConfig(
  connectionManager: ConnectionManager,
): Promise<ResolvedWorktreeConfig | null> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') { return null; }
  return client.getWorktreeConfig(workspacePath);
}

/**
 * Whether the resolved config carries a *runnable* `worktree.devCommand`.
 *
 * "Runnable" means a non-empty, non-whitespace string — matching the
 * actual gate in `commands/dev-shared.ts` (`if (!devCommand)`), where an
 * empty string falls through to the "configure devCommand" error. The
 * type is `string | null` (`ResolvedWorktreeConfig.devCommand`), so `""`
 * is reachable and must be treated as absent, not present-but-disabled.
 *
 * Single source of truth for two surfaces: the `codev.hasDevCommand`
 * context key (gates the builder-row Run/Stop Dev menu) and the
 * Workspace view's Start-row visibility. Keeping both on this helper
 * guarantees they agree on every config state.
 */
export function hasRunnableDevCommand(config: ResolvedWorktreeConfig | null): boolean {
  return typeof config?.devCommand === 'string' && config.devCommand.trim().length > 0;
}
