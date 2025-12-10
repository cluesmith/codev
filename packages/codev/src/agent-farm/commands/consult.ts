/**
 * Consult command - runs a consult command in a dashboard terminal
 *
 * Opens a terminal tab that runs the consult command and keeps the
 * terminal open after completion for review.
 */

import { getConfig } from '../utils/index.js';
import { logger, fatal } from '../utils/logger.js';
import { loadState } from '../state.js';
import path from 'node:path';

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
  const state = loadState();

  if (!state.architect) {
    fatal('Dashboard not running. Start with: af start');
  }

  const config = getConfig();
  const dashboardPort = config.dashboardPort;

  // Build the consult command
  const consultBin = path.join(config.projectRoot, 'codev/bin/consult');
  let cmd = `${consultBin} --model ${options.model}`;
  if (options.type) {
    cmd += ` --type ${options.type}`;
  }
  cmd += ` ${subcommand} ${target}`;

  // Generate a name for the terminal (e.g., "gemini-pr87")
  const name = `${options.model}-${subcommand}${target}`;

  try {
    const response = await fetch(`http://localhost:${dashboardPort}/api/tabs/shell`, {
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
