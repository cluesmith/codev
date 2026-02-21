/**
 * Rename command - renames the current shell session (Spec 468)
 *
 * Reads SHELLPER_SESSION_ID and TOWER_PORT from the environment,
 * calls the Tower API to rename the session, and displays the result.
 */

import { TowerClient, DEFAULT_TOWER_PORT } from '../lib/tower-client.js';
import { logger, fatal } from '../utils/logger.js';

interface RenameOptions {
  name: string;
}

export async function rename(options: RenameOptions): Promise<void> {
  if (!options.name || options.name.trim().length === 0) {
    fatal('Name is required. Usage: af rename <name>');
  }

  const sessionId = process.env.SHELLPER_SESSION_ID;
  if (!sessionId) {
    fatal('Not running inside a shellper session');
  }

  const rawPort = process.env.TOWER_PORT;
  const parsedPort = rawPort ? parseInt(rawPort, 10) : NaN;
  const port = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_TOWER_PORT;

  const client = new TowerClient(port);
  const result = await client.renameTerminal(sessionId, options.name);

  if (result.ok && result.data) {
    logger.success(`Renamed to: ${result.data.name}`);
    return;
  }

  if (result.status === 400) {
    fatal('Name must be 1-100 characters');
  } else if (result.status === 403) {
    fatal('Cannot rename builder/architect terminals');
  } else if (result.status === 404) {
    fatal('Session not found — it may have been closed');
  } else if (result.status === 0) {
    fatal('Tower is not running');
  } else {
    fatal(result.error || 'Rename failed');
  }
}
