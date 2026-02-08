/**
 * Status command - shows status of all agents
 *
 * Phase 3 (Spec 0090): Uses tower API for project status.
 */

import { loadState } from '../state.js';
import { logger } from '../utils/logger.js';
import { isProcessRunning } from '../utils/shell.js';
import { getConfig } from '../utils/config.js';
import { TowerClient } from '../lib/tower-client.js';
import chalk from 'chalk';

/**
 * Default tower port
 */
const DEFAULT_TOWER_PORT = 4100;

/**
 * Display status of all agent farm processes
 */
export async function status(): Promise<void> {
  const config = getConfig();
  const projectPath = config.projectRoot;

  logger.header('Agent Farm Status');

  // Try tower API first (Phase 3 - Spec 0090)
  const client = new TowerClient(DEFAULT_TOWER_PORT);
  const towerRunning = await client.isRunning();

  if (towerRunning) {
    // Get health info
    const health = await client.getHealth();
    if (health) {
      logger.kv('Tower', chalk.green('running'));
      logger.kv('  Uptime', `${Math.floor(health.uptime)}s`);
      logger.kv('  Active Projects', health.activeProjects);
      logger.kv('  Memory', `${Math.round(health.memoryUsage / 1024 / 1024)}MB`);
    }

    logger.blank();

    // Get project status from tower
    const projectStatus = await client.getProjectStatus(projectPath);

    if (projectStatus) {
      const statusText = projectStatus.active ? chalk.green('active') : chalk.gray('inactive');
      logger.kv('Project', projectStatus.name);
      logger.kv('  Status', statusText);
      logger.kv('  Port', projectStatus.basePort);
      logger.kv('  Terminals', projectStatus.terminals.length);

      if (projectStatus.terminals.length > 0) {
        logger.blank();
        logger.info('Terminals:');
        for (const term of projectStatus.terminals) {
          const typeColor = term.type === 'architect' ? chalk.cyan : term.type === 'builder' ? chalk.blue : chalk.gray;
          logger.info(`  ${typeColor(term.type)} - ${term.label} (${term.active ? 'active' : 'stopped'})`);
        }
      }

      if (projectStatus.gateStatus?.hasGate) {
        logger.blank();
        logger.warn(`Gate pending: ${projectStatus.gateStatus.gateName} (builder: ${projectStatus.gateStatus.builderId})`);
      }

      return;
    }

    // Project not found in tower, show "not active"
    logger.kv('Project', chalk.gray('not active in tower'));
    logger.info(`Run 'af dash start' to activate this project`);
    return;
  }

  // Tower not running - show message and fall back to local state
  logger.kv('Tower', chalk.gray('not running'));
  logger.info(`Run 'af tower start' to start the tower daemon`);
  logger.blank();

  // Fall back to local state for legacy display
  const state = loadState();

  // Architect status
  if (state.architect) {
    const running = await isProcessRunning(state.architect.pid);
    const statusText = running ? chalk.green('running') : chalk.red('stopped');
    logger.kv('Architect', `${statusText} (PID: ${state.architect.pid}, port: ${state.architect.port})`);
    logger.kv('  Command', state.architect.cmd);
    logger.kv('  Started', state.architect.startedAt);
  } else {
    logger.kv('Architect', chalk.gray('not running'));
  }

  logger.blank();

  // Builders
  if (state.builders.length > 0) {
    logger.info('Builders:');
    const widths = [12, 20, 10, 12, 10, 6];

    logger.row(['ID', 'Name', 'Type', 'Status', 'Phase', 'Port'], widths);
    logger.row(['──', '────', '────', '──────', '─────', '────'], widths);

    for (const builder of state.builders) {
      // pid=0 means PTY-backed terminal; assume running if tmux session or terminalId exists
      const running = builder.pid > 0
        ? await isProcessRunning(builder.pid)
        : !!(builder.tmuxSession || builder.terminalId);
      const statusColor = getStatusColor(builder.status, running);
      const typeColor = getTypeColor(builder.type || 'spec');

      logger.row([
        builder.id,
        builder.name.substring(0, 18),
        typeColor(builder.type || 'spec'),
        statusColor(builder.status),
        builder.phase.substring(0, 8),
        builder.port > 0 ? String(builder.port) : '-',
      ], widths);
    }
  } else {
    logger.info('Builders: none');
  }

  logger.blank();

  // Utils
  if (state.utils.length > 0) {
    logger.info('Utility Terminals:');
    const widths = [8, 20, 8];

    logger.row(['ID', 'Name', 'Port'], widths);
    logger.row(['──', '────', '────'], widths);

    for (const util of state.utils) {
      const running = await isProcessRunning(util.pid);
      const name = running ? util.name : chalk.gray(util.name + ' (stopped)');

      logger.row([
        util.id,
        name.substring(0, 18),
        String(util.port),
      ], widths);
    }
  } else {
    logger.info('Utility Terminals: none');
  }

  logger.blank();

  // Annotations
  if (state.annotations.length > 0) {
    logger.info('Annotations:');
    const widths = [8, 30, 8];

    logger.row(['ID', 'File', 'Port'], widths);
    logger.row(['──', '────', '────'], widths);

    for (const annotation of state.annotations) {
      const running = await isProcessRunning(annotation.pid);
      const file = running ? annotation.file : chalk.gray(annotation.file + ' (stopped)');

      logger.row([
        annotation.id,
        file.substring(0, 28),
        String(annotation.port),
      ], widths);
    }
  } else {
    logger.info('Annotations: none');
  }
}

function getStatusColor(status: string, running: boolean): (text: string) => string {
  if (!running) {
    return chalk.gray;
  }

  switch (status) {
    case 'implementing':
      return chalk.blue;
    case 'blocked':
      return chalk.yellow;
    case 'pr-ready':
      return chalk.green;
    case 'complete':
      return chalk.green;
    default:
      return chalk.white;
  }
}

function getTypeColor(type: string): (text: string) => string {
  switch (type) {
    case 'spec':
      return chalk.cyan;
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
