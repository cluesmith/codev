// Core cron scheduler module for af cron (Spec 399).
//
// Loads .af-cron/*.yaml task definitions per workspace, executes due tasks
// asynchronously via child_process.exec, evaluates conditions, and delivers
// messages via the Tower send pipeline (format + write + broadcast).

import { exec } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import { parseCronExpression, isDue } from './tower-cron-parser.js';
import type { CronSchedule } from './tower-cron-parser.js';
import { formatBuilderMessage } from '../utils/message-format.js';
import { broadcastMessage } from './tower-messages.js';
import { getGlobalDb } from '../db/index.js';

// ============================================================================
// Types
// ============================================================================

export interface CronTask {
  name: string;
  schedule: string;
  enabled: boolean;
  command: string;
  condition?: string;
  message: string;
  target: string;
  timeout: number;
  cwd?: string;
  workspacePath: string;
}

export interface CronDeps {
  log: (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;
  getKnownWorkspacePaths: () => string[];
  resolveTarget: (target: string, fallbackWorkspace?: string) => unknown;
  getTerminalManager: () => { getSession: (id: string) => { write: (data: string) => void } | null };
}

// ============================================================================
// Module state
// ============================================================================

let tickInterval: ReturnType<typeof setInterval> | null = null;
let deps: CronDeps | null = null;

const MAX_OUTPUT_BYTES = 4096;

// ============================================================================
// Public API
// ============================================================================

export function initCron(cronDeps: CronDeps): void {
  deps = cronDeps;
  deps.log('INFO', 'Cron scheduler initialized');

  // Run @startup tasks immediately
  runStartupTasks().catch(err => {
    deps?.log('ERROR', `Startup tasks failed: ${err}`);
  });

  // Start the 60-second tick interval
  tickInterval = setInterval(() => {
    tick().catch(err => {
      deps?.log('ERROR', `Cron tick failed: ${err}`);
    });
  }, 60_000);
}

export function shutdownCron(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  deps?.log('INFO', 'Cron scheduler stopped');
  deps = null;
}

export function getAllTasks(): CronTask[] {
  if (!deps) return [];
  const tasks: CronTask[] = [];
  for (const wsPath of deps.getKnownWorkspacePaths()) {
    tasks.push(...loadWorkspaceTasks(wsPath));
  }
  return tasks;
}

// ============================================================================
// YAML loading
// ============================================================================

export function loadWorkspaceTasks(workspacePath: string): CronTask[] {
  const cronDir = join(workspacePath, '.af-cron');
  if (!existsSync(cronDir)) return [];

  const tasks: CronTask[] = [];
  let entries: string[];
  try {
    entries = readdirSync(cronDir);
  } catch {
    return [];
  }

  for (const file of entries) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

    try {
      const content = readFileSync(join(cronDir, file), 'utf-8');
      const doc = yaml.load(content) as Record<string, unknown> | null;
      if (!doc || typeof doc !== 'object') continue;

      const name = typeof doc.name === 'string' ? doc.name : '';
      const schedule = typeof doc.schedule === 'string' ? doc.schedule : '';
      const command = typeof doc.command === 'string' ? doc.command : '';
      const message = typeof doc.message === 'string' ? doc.message : '';

      if (!name || !schedule || !command || !message) {
        deps?.log('WARN', `Skipping ${file} in ${workspacePath}: missing required fields`);
        continue;
      }

      // Validate cron expression
      try {
        parseCronExpression(schedule);
      } catch (err) {
        deps?.log('WARN', `Skipping ${file} in ${workspacePath}: invalid schedule: ${err}`);
        continue;
      }

      tasks.push({
        name,
        schedule,
        enabled: doc.enabled !== false,
        command,
        condition: typeof doc.condition === 'string' ? doc.condition : undefined,
        message,
        target: typeof doc.target === 'string' ? doc.target : 'architect',
        timeout: typeof doc.timeout === 'number' ? doc.timeout : 30,
        cwd: typeof doc.cwd === 'string' ? doc.cwd : undefined,
        workspacePath,
      });
    } catch (err) {
      deps?.log('WARN', `Failed to parse ${file} in ${workspacePath}: ${err}`);
    }
  }

  return tasks;
}

// ============================================================================
// Task ID
// ============================================================================

export function getTaskId(workspacePath: string, taskName: string): string {
  return createHash('sha256').update(`${workspacePath}:${taskName}`).digest('hex').slice(0, 16);
}

// ============================================================================
// Tick logic
// ============================================================================

export async function tick(): Promise<void> {
  if (!deps) return;

  const now = new Date();
  const workspaces = deps.getKnownWorkspacePaths();

  for (const wsPath of workspaces) {
    const tasks = loadWorkspaceTasks(wsPath);

    for (const task of tasks) {
      if (!isTaskEnabled(task)) continue;

      const schedule = parseCronExpression(task.schedule);
      if (schedule.startup) continue; // startup tasks handled separately

      const taskId = getTaskId(task.workspacePath, task.name);
      const lastRun = getLastRun(taskId);

      if (isDue(schedule, now, lastRun)) {
        // Fire-and-forget: don't block the tick loop
        executeTask(task).catch(err => {
          deps?.log('ERROR', `Task '${task.name}' failed: ${err}`);
        });
      }
    }
  }
}

async function runStartupTasks(): Promise<void> {
  if (!deps) return;

  const workspaces = deps.getKnownWorkspacePaths();
  for (const wsPath of workspaces) {
    const tasks = loadWorkspaceTasks(wsPath);
    for (const task of tasks) {
      if (!isTaskEnabled(task)) continue;

      const schedule = parseCronExpression(task.schedule);
      if (!schedule.startup) continue;

      deps.log('INFO', `Running startup task: ${task.name}`);
      await executeTask(task).catch(err => {
        deps?.log('ERROR', `Startup task '${task.name}' failed: ${err}`);
      });
    }
  }
}

// ============================================================================
// Task execution
// ============================================================================

export async function executeTask(task: CronTask): Promise<{ result: string; output: string }> {
  if (!deps) throw new Error('Cron not initialized');

  const taskId = getTaskId(task.workspacePath, task.name);
  deps.log('INFO', `Executing cron task: ${task.name}`);

  let output: string;
  let result: string;

  try {
    output = await runCommand(task.command, {
      cwd: task.cwd ?? task.workspacePath,
      timeout: task.timeout * 1000,
    });
    result = 'success';
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    output = execErr.stdout ?? execErr.stderr ?? execErr.message ?? String(err);
    result = 'failure';
  }

  // Truncate output for storage
  const truncatedOutput = output.slice(0, MAX_OUTPUT_BYTES);
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Update SQLite state
  updateTaskState(taskId, task.workspacePath, task.name, nowSeconds, result, truncatedOutput);

  // Evaluate condition
  let shouldNotify = true;
  if (task.condition) {
    try {
      shouldNotify = evaluateCondition(task.condition, output.trim());
    } catch (err) {
      deps.log('WARN', `Condition evaluation failed for '${task.name}': ${err}`);
      shouldNotify = false;
    }
  }

  if (shouldNotify && result === 'success') {
    const renderedMessage = task.message.replace(/\$\{output\}/g, output.trim());
    deliverMessage(task, renderedMessage);
  } else if (result === 'failure') {
    deliverMessage(task, `Cron task '${task.name}' failed: ${output.trim().slice(0, 200)}`);
  }

  deps.log('INFO', `Cron task '${task.name}' completed: ${result}`);
  return { result, output: truncatedOutput };
}

function runCommand(command: string, options: { cwd: string; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: 1024 * 1024, // 1MB
      env: process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        // Attach stdout/stderr for the caller
        (error as unknown as Record<string, string>).stdout = stdout;
        (error as unknown as Record<string, string>).stderr = stderr;
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

// ============================================================================
// Condition evaluation
// ============================================================================

export function evaluateCondition(condition: string, output: string): boolean {
  // eslint-disable-next-line no-new-func
  const fn = new Function('output', 'return ' + condition);
  return !!fn(output);
}

// ============================================================================
// Message delivery (shared send pipeline)
// ============================================================================

function deliverMessage(task: CronTask, message: string): void {
  if (!deps) return;

  const result = deps.resolveTarget(task.target, task.workspacePath) as
    | { terminalId: string; workspacePath: string; agent: string }
    | { code: string; message: string };

  if ('code' in result) {
    deps.log('WARN', `Cannot deliver cron message for '${task.name}': target '${task.target}' not found`);
    return;
  }

  const session = deps.getTerminalManager().getSession(result.terminalId);
  if (!session) {
    deps.log('WARN', `Cannot deliver cron message for '${task.name}': terminal session gone`);
    return;
  }

  const formatted = formatBuilderMessage('af-cron', message);
  session.write(formatted);
  session.write('\r');

  broadcastMessage({
    type: 'message',
    from: {
      project: basename(task.workspacePath),
      agent: 'af-cron',
    },
    to: {
      project: basename(result.workspacePath),
      agent: result.agent,
    },
    content: message,
    metadata: { source: 'cron' },
    timestamp: new Date().toISOString(),
  });

  deps.log('INFO', `Cron message delivered: af-cron → ${result.agent}`);
}

// ============================================================================
// SQLite state management
// ============================================================================

function getLastRun(taskId: string): number | null {
  try {
    const db = getGlobalDb();
    const row = db.prepare('SELECT last_run FROM cron_tasks WHERE id = ?').get(taskId) as
      | { last_run: number | null }
      | undefined;
    return row?.last_run ?? null;
  } catch {
    return null;
  }
}

function updateTaskState(
  taskId: string,
  workspacePath: string,
  taskName: string,
  lastRun: number,
  lastResult: string,
  lastOutput: string,
): void {
  try {
    const db = getGlobalDb();
    db.prepare(`
      INSERT INTO cron_tasks (id, workspace_path, task_name, last_run, last_result, last_output, enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        last_run = excluded.last_run,
        last_result = excluded.last_result,
        last_output = excluded.last_output
    `).run(taskId, workspacePath, taskName, lastRun, lastResult, lastOutput);
  } catch (err) {
    deps?.log('ERROR', `Failed to update task state for '${taskName}': ${err}`);
  }
}

function isTaskEnabled(task: CronTask): boolean {
  // Check YAML-level enabled flag first
  if (!task.enabled) return false;

  // Check DB-level enabled override
  try {
    const db = getGlobalDb();
    const taskId = getTaskId(task.workspacePath, task.name);
    const row = db.prepare('SELECT enabled FROM cron_tasks WHERE id = ?').get(taskId) as
      | { enabled: number }
      | undefined;
    if (row && row.enabled === 0) return false;
  } catch {
    // DB not available — treat as enabled
  }

  return true;
}
