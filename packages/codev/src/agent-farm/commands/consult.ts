/**
 * Consult command - runs a consult command in a dashboard terminal
 *
 * Opens a terminal tab that runs the consult command and keeps the
 * terminal open after completion for review.
 */

import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { TowerClient } from '../lib/tower-client.js';

// Tower port — the single HTTP server since Spec 0090
const DEFAULT_TOWER_PORT = 4100;

/**
 * Encode project path for Tower URL (base64url)
 */
function encodeProjectPath(projectPath: string): string {
  return Buffer.from(projectPath).toString('base64url');
}

interface ConsultOptions {
  model: string;
  type?: string;
}

/**
 * Run a consult command in a dashboard terminal
 */
export async function consult(
  subcommand: string,
  target: string,
  options: ConsultOptions
): Promise<void> {
  const client = new TowerClient(DEFAULT_TOWER_PORT);
  if (!(await client.isRunning())) {
    fatal('Tower not running. Start with: af dash start');
  }

  const config = getConfig();
  const encodedPath = encodeProjectPath(config.projectRoot);

  // Build the consult command (consult is now a proper CLI binary)
  let cmd = `consult --model ${options.model}`;
  if (options.type) {
    cmd += ` --type ${options.type}`;
  }
  cmd += ` ${subcommand} ${target}`;

  // Generate a name for the terminal (e.g., "gemini-pr87")
  const name = `${options.model}-${subcommand}${target}`;

  try {
    const response = await fetch(`http://localhost:${DEFAULT_TOWER_PORT}/project/${encodedPath}/api/tabs/shell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, command: cmd }),
    });

    if (response.ok) {
      const result = (await response.json()) as { name: string; port: number };
      logger.success(`Consult opened in dashboard tab`);
      logger.kv('Name', result.name);
      logger.kv('Command', cmd);
    } else {
      const error = await response.text();
      fatal(`Failed to open consult terminal: ${error}`);
    }
  } catch (err) {
    fatal(`Dashboard not available: ${err}`);
  }
}
