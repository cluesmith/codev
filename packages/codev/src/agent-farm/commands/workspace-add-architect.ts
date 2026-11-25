/**
 * `afx workspace add-architect [--name <name>]` (Spec 755)
 *
 * Registers an additional named architect terminal in an active workspace.
 *
 * Without `--name`, Tower auto-assigns the next available `architect-<N>`
 * (smallest unused integer ≥ 2). With `--name <name>`, the name is validated
 * client-side first (cheap roundtrip avoidance) and then the request is
 * dispatched to Tower, which re-validates and rejects collisions.
 *
 * Existing `afx architect` (local Claude session, no Tower) is intentionally
 * unchanged — its no-Tower contract is preserved.
 */

import { getConfig } from '../utils/index.js';
import { logger } from '../utils/logger.js';
import { getTowerClient } from '../lib/tower-client.js';
import { checkTower } from '../lib/tower-check.js';
import { validateArchitectName } from '../utils/architect-name.js';

export interface WorkspaceAddArchitectOptions {
  name?: string;
}

export async function workspaceAddArchitect(
  options: WorkspaceAddArchitectOptions = {},
): Promise<void> {
  const config = getConfig();
  const workspacePath = config.workspaceRoot;

  // Client-side validation. Tower re-validates, but failing fast here
  // gives a tighter error path when the user typos a name.
  //
  // Note: we distinguish "no --name supplied" (undefined) from "--name with
  // empty/whitespace value" (rejected explicitly). The former auto-numbers;
  // the latter is a user error and must not silently auto-number.
  if (options.name !== undefined) {
    const trimmed = options.name.trim();
    if (trimmed === '') {
      logger.error('Architect name cannot be empty. Omit --name to auto-number, or supply a valid name.');
      process.exit(1);
    }
    const err = validateArchitectName(trimmed);
    if (err) {
      logger.error(err);
      process.exit(1);
    }
    // Pass the trimmed value through to the Tower client.
    options.name = trimmed;
  }

  const client = getTowerClient();
  const tower = await checkTower(client, { startCommand: 'afx workspace start' });
  if (tower.state !== 'running') {
    logger.error(tower.message);
    process.exit(1);
  }

  const result = await client.addArchitect(workspacePath, options.name);

  if (!result.ok) {
    logger.error(result.error ?? 'Failed to add architect.');
    process.exit(1);
  }

  logger.success(`Started architect '${result.name}' (terminal ${result.terminalId}).`);
}
