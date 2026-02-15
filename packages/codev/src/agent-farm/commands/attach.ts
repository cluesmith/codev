/**
 * Attach command - attach to a running builder terminal
 */

import type { Builder } from '../types.js';
import { logger, fatal } from '../utils/logger.js';
import { openBrowser } from '../utils/shell.js';
import { loadState, getBuilder, getBuilders } from '../state.js';
import { getConfig } from '../utils/config.js';
import { TowerClient } from '../lib/tower-client.js';
import chalk from 'chalk';

export interface AttachOptions {
  project?: string;     // Builder ID / project ID
  issue?: number;       // Issue number (for bugfix builders)
  browser?: boolean;    // Open in browser instead of attaching
}

/**
 * Find a builder by issue number
 */
function findBuilderByIssue(issueNumber: number): Builder | null {
  const builders = getBuilders();
  return builders.find((b) => b.issueNumber === issueNumber) ?? null;
}

/**
 * Find a builder by ID (supports partial matching)
 */
function findBuilderById(id: string): Builder | null {
  // First try exact match
  const exact = getBuilder(id);
  if (exact) return exact;

  // Try prefix match (e.g., "0073" matches "0073-feature-name")
  const builders = getBuilders();
  const matches = builders.filter((b) => b.id.startsWith(id) || b.id.includes(id));

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    logger.error(`Ambiguous builder ID "${id}". Matches:`);
    for (const b of matches) {
      logger.info(`  - ${b.id}`);
    }
    return null;
  }

  return null;
}

/**
 * Display a list of running builders for interactive selection
 */
async function displayBuilderList(): Promise<void> {
  const state = loadState();
  const builders = state.builders;

  if (builders.length === 0) {
    logger.info('No builders running.');
    logger.blank();
    logger.info('Spawn a builder with:');
    logger.info('  af spawn -p <project-id>');
    logger.info('  af spawn --issue <number>');
    logger.info('  af spawn --task "description"');
    return;
  }

  logger.header('Running Builders');
  logger.blank();

  const widths = [15, 30, 8, 10];
  logger.row(['ID', 'Name', 'Type', 'Status'], widths);
  logger.row(['──', '────', '────', '──────'], widths);

  for (const builder of builders) {
    const running = !!builder.terminalId;
    const statusText = running ? chalk.green(builder.status) : chalk.red('stopped');
    const typeColor = getTypeColor(builder.type);

    logger.row([
      builder.id,
      builder.name.substring(0, 28),
      typeColor(builder.type),
      statusText,
    ], widths);
  }

  logger.blank();
  logger.info('Attach with:');
  logger.info('  af attach -p <id>         # by builder/project ID');
  logger.info('  af attach --issue <num>   # by issue number');
  logger.info('  af attach -p <id> --browser  # open in browser');
}

/**
 * Get color function for builder type
 */
function getTypeColor(type: string): (text: string) => string {
  switch (type) {
    case 'spec':
      return chalk.cyan;
    case 'bugfix':
      return chalk.red;
    case 'task':
      return chalk.magenta;
    case 'protocol':
      return chalk.yellow;
    case 'worktree':
      return chalk.blue;
    case 'shell':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

/**
 * Attach to builder terminal
 */
export async function attach(options: AttachOptions): Promise<void> {
  // If no arguments provided, show list of builders
  if (!options.project && !options.issue) {
    await displayBuilderList();
    return;
  }

  // Find the builder
  let builder: Builder | null = null;

  if (options.issue) {
    builder = findBuilderByIssue(options.issue);
    if (!builder) {
      fatal(`No builder found for issue #${options.issue}. Use 'af status' to see running builders.`);
    }
  } else if (options.project) {
    builder = findBuilderById(options.project);
    if (!builder) {
      fatal(`Builder "${options.project}" not found. Use 'af status' to see running builders.`);
    }
  }

  if (!builder) {
    fatal('No builder specified. Use --project (-p) or --issue (-i).');
    return; // TypeScript doesn't know fatal() never returns
  }

  // Open in browser (via Tower dashboard)
  const config = getConfig();
  const client = new TowerClient();
  const url = client.getWorkspaceUrl(config.workspaceRoot);

  if (options.browser) {
    logger.info(`Opening Tower dashboard at ${url}...`);
    await openBrowser(url);
    logger.success('Opened Tower dashboard in browser');
    return;
  }

  // Default: open in browser (Tower dashboard is the primary terminal interface)
  if (!builder.terminalId) {
    fatal(`Builder ${builder.id} has no terminal session. Try opening in browser with --browser`);
  }

  logger.info(`Builder ${builder.id} terminal is available in the Tower dashboard.`);
  logger.info(`Opening ${url}...`);
  await openBrowser(url);
  logger.success('Opened Tower dashboard in browser');
}
