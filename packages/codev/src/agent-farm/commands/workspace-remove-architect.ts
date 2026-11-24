/**
 * `afx workspace remove-architect <name>` (Spec 786)
 *
 * Removes a previously-added named architect from an active workspace. The
 * default `main` architect cannot be removed (refused by the validator and the
 * Tower handler). Removing an architect that has in-flight builders is
 * allowed — those builders' subsequent `afx send architect` calls fall back to
 * `main` via the existing routing chain (OQ-A).
 *
 * Symmetric with `workspace-add-architect.ts`.
 */

import { getConfig } from '../utils/index.js';
import { logger } from '../utils/logger.js';
import { getTowerClient } from '../lib/tower-client.js';
import { checkTower } from '../lib/tower-check.js';

export interface WorkspaceRemoveArchitectOptions {
  name: string;
}

export async function workspaceRemoveArchitect(
  options: WorkspaceRemoveArchitectOptions,
): Promise<void> {
  const config = getConfig();
  const workspacePath = config.workspaceRoot;

  const trimmed = (options.name ?? '').trim();
  if (trimmed === '') {
    logger.error('Architect name is required.');
    process.exit(1);
  }
  if (trimmed === 'main') {
    logger.error("Cannot remove the default 'main' architect.");
    process.exit(1);
  }

  const client = getTowerClient();
  const tower = await checkTower(client, { startCommand: 'afx workspace start' });
  if (tower.state !== 'running') {
    logger.error(tower.message);
    process.exit(1);
  }

  const result = await client.removeArchitect(workspacePath, trimmed);

  if (!result.ok) {
    logger.error(result.error ?? `Failed to remove architect '${trimmed}'.`);
    process.exit(1);
  }

  logger.success(`Removed architect '${trimmed}'.`);
}
