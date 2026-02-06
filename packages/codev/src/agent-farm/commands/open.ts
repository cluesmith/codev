/**
 * Open command - opens file annotation viewer
 *
 * Spec 0092: Files are now served through Tower, no separate ports.
 * This command creates a file tab via the Tower API.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { openBrowser } from '../utils/shell.js';

// Tower port is fixed at 4100
const TOWER_PORT = 4100;

interface OpenOptions {
  file: string;
}

/**
 * Encode project path for Tower URL (base64url)
 */
function encodeProjectPath(projectPath: string): string {
  return Buffer.from(projectPath).toString('base64url');
}

/**
 * Try to create a file tab via the Tower API
 * Returns the file tab ID if successful, null if Tower not available
 */
async function tryTowerApi(projectPath: string, filePath: string): Promise<string | null> {
  const encodedPath = encodeProjectPath(projectPath);

  try {
    const response = await fetch(`http://localhost:${TOWER_PORT}/project/${encodedPath}/api/tabs/file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });

    if (response.ok) {
      const result = (await response.json()) as { id: string; existing?: boolean };
      logger.success(`Opened in dashboard tab`);
      logger.kv('File', filePath);
      if (result.existing) {
        logger.info('(File was already open)');
      }
      return result.id;
    }

    // Tower returned an error
    const error = await response.text();
    logger.error(`Tower API error: ${error}`);
    return null;
  } catch {
    // Tower not available
    return null;
  }
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

  // Try to use Tower API
  const tabId = await tryTowerApi(config.projectRoot, filePath);

  if (tabId) {
    // Open the dashboard with the file tab selected
    const encodedPath = encodeProjectPath(config.projectRoot);
    const dashboardUrl = `http://localhost:${TOWER_PORT}/project/${encodedPath}/?tab=file-${tabId}`;
    await openBrowser(dashboardUrl);
    return;
  }

  // Tower not available - tell user to start it
  logger.error('Tower is not running.');
  logger.info('Start it with: af tower start');
  logger.info('Then try again: af open ' + options.file);
  process.exit(1);
}
