/**
 * Open command - opens file annotation viewer
 *
 * Spec 0092: Files are now served through Tower, no separate ports.
 * This command creates a file tab via the Tower API.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getConfig, getMainRepoFromWorktree } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { TowerClient, encodeWorkspacePath } from '../lib/tower-client.js';

interface OpenOptions {
  file: string;
}

/**
 * Try to create a file tab via the Tower API
 * Returns the file tab ID if successful, null if Tower not available
 */
async function tryTowerApi(client: TowerClient, workspacePath: string, filePath: string): Promise<string | null> {
  const encodedPath = encodeWorkspacePath(workspacePath);

  const result = await client.request<{ id: string; existing?: boolean }>(
    `/workspace/${encodedPath}/api/tabs/file`,
    {
      method: 'POST',
      body: JSON.stringify({ path: filePath }),
    }
  );

  if (result.ok && result.data) {
    logger.success(`Opened in dashboard tab`);
    logger.kv('File', filePath);
    if (result.data.existing) {
      logger.info('(File was already open)');
    }
    return result.data.id;
  }

  if (result.error) {
    logger.error(`Tower API error (HTTP ${result.status}): ${result.error}`);
    logger.kv('Workspace', workspacePath);
    logger.kv('File', filePath);
  }

  return null;
}

/**
 * Open file annotation viewer
 *
 * Spec 0092: All file viewing goes through Tower. No fallback to separate servers.
 */
export async function open(options: OpenOptions): Promise<void> {
  const config = getConfig();

  // Resolve file path relative to current directory (works correctly in worktrees)
  let filePath: string;
  if (options.file.startsWith('/')) {
    filePath = options.file;
  } else {
    filePath = resolve(process.cwd(), options.file);
  }

  // Check file exists
  if (!existsSync(filePath)) {
    fatal(`File not found: ${filePath}`);
  }

  // When running from a worktree, Tower only knows the main repo workspace.
  // Fall back to main repo path so the API call targets a registered workspace.
  let workspacePath = config.workspaceRoot;
  const mainRepo = getMainRepoFromWorktree(config.workspaceRoot);
  if (mainRepo) {
    workspacePath = mainRepo;
  }

  // Try to use Tower API
  const client = new TowerClient();
  const tabId = await tryTowerApi(client, workspacePath, filePath);

  if (tabId) {
    // Tab created server-side — dashboard picks it up via state polling.
    // No need to open a browser; the user already has the dashboard open.
    return;
  }

  // Tower not available - tell user to start it
  logger.error('Tower is not running.');
  logger.info('Start it with: af tower start');
  logger.info('Then try again: af open ' + options.file);
  process.exit(1);
}
