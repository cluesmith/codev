/**
 * Open command - opens file annotation viewer
 *
 * Spec 0092: Files are now served through Tower, no separate ports.
 * This command creates a file tab via the Tower API.
 */

import { resolve, dirname, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { getMainRepoFromWorktree, findWorkspaceRoot } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { TowerClient, encodeWorkspacePath } from '../lib/tower-client.js';

interface OpenOptions {
  file: string;
}

/**
 * Try to create a file tab via the Tower API. On failure, `refused` says whether nothing was
 * listening (Tower not running); any other failure has already been reported (#1901).
 */
async function tryTowerApi(
  client: TowerClient,
  workspacePath: string,
  filePath: string,
): Promise<{ ok: true; tabId: string } | { ok: false; refused: boolean }> {
  const encodedPath = encodeWorkspacePath(workspacePath);

  const result = await client.request<{ id: string; existing?: boolean }>(
    `/workspace/${encodedPath}/api/tabs/file`,
    {
      method: 'POST',
      body: JSON.stringify({ path: filePath }),
    }
  );

  if (result.ok && result.data) {
    logger.success(`Opened in workspace tab`);
    logger.kv('File', filePath);
    if (result.data.existing) {
      logger.info('(File was already open)');
    }
    return { ok: true, tabId: result.data.id };
  }

  if (result.connectionRefused) {
    return { ok: false, refused: true };
  }

  logger.error(`Tower API error (HTTP ${result.status}): ${result.error ?? 'no file tab in the response'}`);
  logger.kv('Workspace', workspacePath);
  logger.kv('File', filePath);

  return { ok: false, refused: false };
}

/**
 * Open file annotation viewer
 *
 * Spec 0092: All file viewing goes through Tower. No fallback to separate servers.
 */
export async function open(options: OpenOptions): Promise<void> {
  // Resolve file path relative to current directory (works correctly in worktrees)
  let filePath: string;
  if (isAbsolute(options.file)) {
    filePath = options.file;
  } else {
    filePath = resolve(process.cwd(), options.file);
  }

  // Check file exists
  if (!existsSync(filePath)) {
    fatal(`File not found: ${filePath}`);
  }

  // Determine workspace from CWD first (the user's current workspace context).
  // This ensures cross-workspace file opens show in the user's active workspace,
  // not in the workspace where the file physically resides.
  // Fall back to file-based detection when CWD isn't in a recognizable workspace
  // (e.g., running from /tmp).
  const cwdWorkspace = findWorkspaceRoot(process.cwd());
  const cwdIsWorkspace = existsSync(resolve(cwdWorkspace, 'codev')) ||
    existsSync(resolve(cwdWorkspace, '.git'));

  let workspacePath = cwdIsWorkspace
    ? cwdWorkspace
    : findWorkspaceRoot(dirname(filePath));

  // When running from a worktree, Tower only knows the main repo workspace.
  // Fall back to main repo path so the API call targets a registered workspace.
  const mainRepo = getMainRepoFromWorktree(workspacePath);
  if (mainRepo) {
    workspacePath = mainRepo;
  }

  // Try to use Tower API
  const client = new TowerClient();
  const opened = await tryTowerApi(client, workspacePath, filePath);

  if (opened.ok) {
    // Tab created server-side — dashboard picks it up via state polling.
    // No need to open a browser; the user already has the dashboard open.
    return;
  }

  if (opened.refused) {
    logger.error('Tower is not running.');
    logger.info('Start it with: afx tower start');
    logger.info('Then try again: afx open ' + options.file);
  }
  process.exit(1);
}
