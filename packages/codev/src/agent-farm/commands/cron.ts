// CLI handlers for `af cron` subcommands (Spec 399 Phase 4).
// Each function calls the Tower API via TowerClient and formats output.

import { getTowerClient, DEFAULT_TOWER_PORT } from '../lib/tower-client.js';
import { logger, fatal } from '../utils/logger.js';

interface CronTaskResponse {
  name: string;
  schedule: string;
  enabled: boolean;
  command: string;
  target: string;
  timeout: number;
  workspacePath: string;
  last_run: number | null;
  last_result: string | null;
  last_output?: string;
}

interface CronRunResponse {
  ok: boolean;
  result: string;
  output: string;
}

interface CronToggleResponse {
  ok: boolean;
  enabled: boolean;
}

interface CronListOptions {
  all?: boolean;
  workspace?: string;
  port?: number;
}

interface CronStatusOptions {
  workspace?: string;
  port?: number;
}

interface CronTaskActionOptions {
  workspace?: string;
  port?: number;
}

export async function cronList(options: CronListOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  let path = '/api/cron/tasks';
  if (!options.all && options.workspace) {
    path += `?workspace=${encodeURIComponent(options.workspace)}`;
  }

  const result = await client.request<CronTaskResponse[]>(path);
  if (!result.ok) {
    fatal(result.error || 'Failed to fetch cron tasks');
  }

  const tasks = result.data!;
  if (tasks.length === 0) {
    logger.info('No cron tasks configured.');
    return;
  }

  logger.header('Cron Tasks');

  const widths = [20, 18, 8, 15];
  logger.row(['NAME', 'SCHEDULE', 'ENABLED', 'WORKSPACE'], widths);
  logger.row(['─'.repeat(20), '─'.repeat(18), '─'.repeat(8), '─'.repeat(15)], widths);

  for (const task of tasks) {
    const wsName = task.workspacePath.split('/').pop() || task.workspacePath;
    logger.row([
      task.name.slice(0, 20),
      task.schedule.slice(0, 18),
      task.enabled ? 'yes' : 'no',
      wsName.slice(0, 15),
    ], widths);
  }
}

export async function cronStatus(name: string, options: CronStatusOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  let path = `/api/cron/tasks/${encodeURIComponent(name)}/status`;
  if (options.workspace) {
    path += `?workspace=${encodeURIComponent(options.workspace)}`;
  }

  const result = await client.request<CronTaskResponse>(path);
  if (!result.ok) {
    fatal(result.error || `Failed to fetch status for task '${name}'`);
  }

  const task = result.data!;
  logger.header(`Task: ${task.name}`);
  logger.kv('Schedule', task.schedule);
  logger.kv('Enabled', task.enabled ? 'yes' : 'no');
  logger.kv('Command', task.command);
  logger.kv('Target', task.target);
  logger.kv('Timeout', `${task.timeout}s`);
  logger.kv('Workspace', task.workspacePath);

  if (task.last_run) {
    const date = new Date(task.last_run * 1000).toISOString();
    logger.kv('Last Run', date);
    logger.kv('Last Result', task.last_result || 'unknown');
    if (task.last_output) {
      logger.blank();
      logger.info('Last Output:');
      console.log(task.last_output);
    }
  } else {
    logger.kv('Last Run', 'never');
  }
}

export async function cronRun(name: string, options: CronTaskActionOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  let path = `/api/cron/tasks/${encodeURIComponent(name)}/run`;
  if (options.workspace) {
    path += `?workspace=${encodeURIComponent(options.workspace)}`;
  }

  logger.info(`Running task '${name}'...`);
  const result = await client.request<CronRunResponse>(path, { method: 'POST' });
  if (!result.ok) {
    fatal(result.error || `Failed to run task '${name}'`);
  }

  const data = result.data!;
  if (data.result === 'success') {
    logger.success(`Task '${name}' completed successfully`);
  } else {
    logger.error(`Task '${name}' failed`);
  }

  if (data.output) {
    logger.blank();
    logger.info('Output:');
    console.log(data.output);
  }
}

export async function cronEnable(name: string, options: CronTaskActionOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  let path = `/api/cron/tasks/${encodeURIComponent(name)}/enable`;
  if (options.workspace) {
    path += `?workspace=${encodeURIComponent(options.workspace)}`;
  }

  const result = await client.request<CronToggleResponse>(path, { method: 'POST' });
  if (!result.ok) {
    fatal(result.error || `Failed to enable task '${name}'`);
  }

  logger.success(`Task '${name}' enabled`);
}

export async function cronDisable(name: string, options: CronTaskActionOptions = {}): Promise<void> {
  const client = getTowerClient(options.port || DEFAULT_TOWER_PORT);

  let path = `/api/cron/tasks/${encodeURIComponent(name)}/disable`;
  if (options.workspace) {
    path += `?workspace=${encodeURIComponent(options.workspace)}`;
  }

  const result = await client.request<CronToggleResponse>(path, { method: 'POST' });
  if (!result.ok) {
    fatal(result.error || `Failed to disable task '${name}'`);
  }

  logger.success(`Task '${name}' disabled`);
}
