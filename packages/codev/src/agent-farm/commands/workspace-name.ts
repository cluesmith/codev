/**
 * `afx workspace name <name>` and `afx workspace name --clear` (Spec 1940)
 *
 * Gives the current workspace an explicit address name, the name other workspaces write
 * before the colon (`<name>:architect`), or removes it so the workspace is addressed by
 * its directory name again. It is the remedy for two workspaces that share a directory
 * name. Tower holds the names and decides: this command only asks.
 *
 * Run from a builder worktree it names the builder's workspace, not the worktree.
 */

import { logger } from '../utils/logger.js';
import { getTowerClient } from '../lib/tower-client.js';
import { detectWorkspaceRoot } from './send.js';

export interface WorkspaceNameOptions {
  name?: string;
  clear?: boolean;
}

export async function workspaceName(options: WorkspaceNameOptions): Promise<void> {
  if (options.clear && options.name !== undefined) {
    logger.error('Give a name to set, or --clear to remove it, not both.');
    process.exit(1);
  }
  if (!options.clear && options.name === undefined) {
    logger.error('Give the name to set, or --clear to remove it: afx workspace name <name> | afx workspace name --clear');
    process.exit(1);
  }

  const workspacePath = detectWorkspaceRoot();
  if (!workspacePath) {
    logger.error('Not inside a workspace: run this from the workspace to name.');
    process.exit(1);
  }

  const client = getTowerClient();
  if (!(await client.isRunning())) {
    logger.error('Tower is not running. Start it with `afx workspace start` first.');
    process.exit(1);
  }

  const outcome = await client.setWorkspaceAddressName(workspacePath, options.clear ? null : options.name!);
  if (!outcome.ok) {
    logger.error(outcome.error);
    process.exit(1);
  }

  const { explicitName, addressName, unaddressableReason } = outcome.result;
  if (explicitName !== null) {
    logger.success(`This workspace is now addressed as '${explicitName}'.`);
    logger.info(`Another workspace reaches its front door with: afx send ${explicitName}:architect "…"`);
    return;
  }
  if (addressName === null) {
    logger.warn(`Explicit name removed. This workspace now has no address name: ${unaddressableReason}`);
    return;
  }
  logger.success(`Explicit name removed. This workspace is addressed by its directory name, '${addressName}'.`);
}
