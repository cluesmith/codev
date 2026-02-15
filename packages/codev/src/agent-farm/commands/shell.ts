/**
 * Shell command - creates a utility shell terminal tab in the dashboard.
 *
 * Spec 0090: All terminals go through Tower on port 4100.
 * The dashboard picks up new tabs via state polling — no browser open needed.
 */

import { getConfig } from '../utils/index.js';
import { logger } from '../utils/logger.js';
import { TowerClient, encodeWorkspacePath } from '../lib/tower-client.js';

interface UtilOptions {
  name?: string;
}

/**
 * Try to create a shell tab via the Tower API.
 * Returns { ok: true } on success, or { ok: false, connectionRefused, error } on failure.
 */
async function tryTowerApi(
  client: TowerClient,
  workspacePath: string,
  name?: string,
): Promise<{ ok: boolean; connectionRefused: boolean; error?: string }> {
  const encodedPath = encodeWorkspacePath(workspacePath);

  const result = await client.request<{ id: string; name: string; terminalId: string }>(
    `/workspace/${encodedPath}/api/tabs/shell`,
    {
      method: 'POST',
      body: JSON.stringify({ name }),
    }
  );

  if (result.ok && result.data) {
    logger.success('Shell opened in dashboard tab');
    logger.kv('Name', result.data.name);
    return { ok: true, connectionRefused: false };
  }

  // status=0 means the request never reached the server (ECONNREFUSED, timeout, etc.)
  const connectionRefused = result.status === 0;
  return { ok: false, connectionRefused, error: result.error };
}

/**
 * Spawn a utility shell terminal
 */
export async function shell(options: UtilOptions = {}): Promise<void> {
  const config = getConfig();

  const client = new TowerClient();
  const result = await tryTowerApi(client, config.workspaceRoot, options.name);
  if (result.ok) {
    return;
  }

  if (result.connectionRefused) {
    logger.error('Tower is not running.');
    logger.info('Start it with: af tower start');
    logger.info('Then try again: af shell');
  } else {
    logger.error(`Tower returned an error: ${result.error || 'unknown'}`);
    logger.info('Check Tower logs: af tower log');
  }
  process.exit(1);
}
