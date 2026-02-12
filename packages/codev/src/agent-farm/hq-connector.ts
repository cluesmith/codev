/**
 * HQ Connector - Connects Agent Farm to CODEV_HQ
 *
 * When CODEV_HQ_URL is set, this module:
 * 1. Establishes WebSocket connection to HQ
 * 2. Registers with project info
 * 3. Watches status files and syncs changes
 * 4. Handles approval messages from HQ
 */

import { WebSocket } from 'ws';
import { watch, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, dirname, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { logger } from './utils/logger.js';

// Message types (duplicated from codev-hq for now, could be shared package later)
interface Message {
  type: string;
  id: string;
  ts: number;
  payload: Record<string, unknown>;
}

interface ProjectInfo {
  path: string;
  name: string;
  git_remote?: string;
}

/**
 * HQ Connector state
 */
let ws: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let statusWatcher: ReturnType<typeof watch> | null = null;
let instanceId: string | null = null;
let projectRoot: string | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 60000;
const BASE_RECONNECT_DELAY = 1000;

/**
 * Generate a unique message ID
 */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Send a message to HQ
 */
function sendMessage(message: Message): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    logger.debug('[HQ] Cannot send - WebSocket not open');
    return;
  }
  ws.send(JSON.stringify(message));
}

/**
 * Get git remote URL for a project
 */
function getGitRemote(projectPath: string): string | undefined {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: projectPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return remote || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get current git SHA for a file
 */
function getGitSha(filePath: string): string | undefined {
  try {
    const sha = execSync(`git log -1 --format=%H -- "${filePath}"`, {
      cwd: dirname(filePath),
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create git commit for approval
 */
function commitApproval(filePath: string, gate: string, approvedBy: string): boolean {
  try {
    const dir = dirname(filePath);
    const fileName = basename(filePath);
    execSync(`git add "${fileName}"`, { cwd: dir, timeout: 5000 });
    execSync(`git commit -m "[HQ] Gate approved: ${gate} by ${approvedBy}"`, {
      cwd: dir,
      timeout: 5000,
    });
    return true;
  } catch (error) {
    logger.debug(`[HQ] Failed to commit approval: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/**
 * Handle incoming messages from HQ
 */
function handleMessage(data: string): void {
  let message: Message;
  try {
    message = JSON.parse(data);
  } catch {
    logger.debug('[HQ] Invalid message received');
    return;
  }

  switch (message.type) {
    case 'welcome':
      logger.info('[HQ] Connected to CODEV_HQ');
      register();
      break;

    case 'pong':
      logger.debug('[HQ] Pong received');
      break;

    case 'response':
      const payload = message.payload as { success?: boolean; error?: string };
      if (payload?.success === false) {
        logger.warn(`[HQ] Error response: ${payload.error}`);
      }
      break;

    case 'approval':
      handleApproval(message);
      break;

    case 'command':
      handleCommand(message);
      break;

    default:
      logger.debug(`[HQ] Unknown message type: ${message.type}`);
  }
}

/**
 * Handle approval message from HQ
 */
function handleApproval(message: Message): void {
  const payload = message.payload as {
    project_path: string;
    project_id: string;
    gate: string;
    approved_by: string;
    approved_at: string;
    comment?: string;
  };

  logger.info(`[HQ] Received approval for ${payload.gate} from ${payload.approved_by}`);

  // Find the status file for this project
  const statusDir = join(projectRoot!, 'codev', 'status');
  const statusFile = join(statusDir, `${payload.project_id}-*.md`);

  // For spike simplicity, just look for any file starting with project_id
  try {
    const { globSync } = require('glob');
    const files = globSync(statusFile);
    if (files.length === 0) {
      logger.warn(`[HQ] Status file not found for project ${payload.project_id}`);
      return;
    }

    const filePath = files[0];
    let content = readFileSync(filePath, 'utf-8');

    // Parse YAML frontmatter and update gate status
    // Simple regex-based update for spike
    const gatePattern = new RegExp(
      `(${payload.gate.replace(/\./g, '\\.')}):\\s*\\{\\s*status:\\s*pending`,
      'g'
    );
    const newContent = content.replace(
      gatePattern,
      `$1: { status: passed, by: ${payload.approved_by}, at: ${payload.approved_at}`
    );

    if (newContent !== content) {
      writeFileSync(filePath, newContent, 'utf-8');
      logger.info(`[HQ] Updated ${basename(filePath)} with approval`);

      // Create git commit
      if (commitApproval(filePath, payload.gate, payload.approved_by)) {
        logger.info(`[HQ] Created git commit for approval`);
      }

      // Send status update back to HQ
      sendStatusUpdate(payload.project_path, filePath, newContent);
    }
  } catch (error) {
    logger.error(`[HQ] Failed to handle approval: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Handle command from HQ
 */
function handleCommand(message: Message): void {
  const payload = message.payload as {
    project_path: string;
    command: string;
    args: Record<string, unknown>;
  };

  logger.info(`[HQ] Received command: ${payload.command}`);

  // For spike, just log commands - full implementation would execute them
  logger.debug(`[HQ] Command args: ${JSON.stringify(payload.args)}`);

  // Acknowledge receipt
  sendMessage({
    type: 'command_ack',
    id: generateId(),
    ts: Date.now(),
    payload: { command_id: message.id, status: 'received' },
  });
}

/**
 * Register with HQ
 */
function register(): void {
  if (!projectRoot) return;

  const projects: ProjectInfo[] = [{
    path: projectRoot,
    name: basename(projectRoot),
    git_remote: getGitRemote(projectRoot),
  }];

  sendMessage({
    type: 'register',
    id: generateId(),
    ts: Date.now(),
    payload: {
      instance_id: instanceId,
      instance_name: process.env.CODEV_HQ_INSTANCE_NAME || `${require('os').hostname()}-agent-farm`,
      version: require('../../package.json').version,
      projects,
    },
  });

  // Start status file watching after registration
  startStatusWatcher();

  // Reset reconnect counter on successful registration
  reconnectAttempts = 0;
}

/**
 * Send status file update to HQ
 */
function sendStatusUpdate(projectPath: string, statusFile: string, content: string): void {
  sendMessage({
    type: 'status_update',
    id: generateId(),
    ts: Date.now(),
    payload: {
      project_path: projectPath,
      status_file: relative(projectPath, statusFile),
      content,
      git_sha: getGitSha(statusFile),
    },
  });
}

/**
 * Watch status files for changes
 */
function startStatusWatcher(): void {
  if (statusWatcher) return;
  if (!projectRoot) return;

  const statusDir = join(projectRoot, 'codev', 'status');

  // Create status directory if it doesn't exist
  if (!existsSync(statusDir)) {
    logger.debug('[HQ] Status directory does not exist, skipping watcher');
    return;
  }

  logger.info('[HQ] Watching status files...');

  statusWatcher = watch(statusDir, (eventType, filename) => {
    if (!filename || !filename.endsWith('.md')) return;

    const filePath = join(statusDir, filename);
    if (!existsSync(filePath)) return;

    try {
      const content = readFileSync(filePath, 'utf-8');
      sendStatusUpdate(projectRoot!, filePath, content);
      logger.debug(`[HQ] Synced ${filename}`);
    } catch (error) {
      logger.debug(`[HQ] Failed to read ${filename}: ${error instanceof Error ? error.message : error}`);
    }
  });
}

/**
 * Start ping interval to keep connection alive
 */
function startPingInterval(): void {
  if (pingInterval) return;

  pingInterval = setInterval(() => {
    sendMessage({
      type: 'ping',
      id: generateId(),
      ts: Date.now(),
      payload: { ts: Date.now() },
    });
  }, 30000);
}

/**
 * Attempt to reconnect to HQ
 */
function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const delay = Math.min(
    BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts),
    MAX_RECONNECT_DELAY
  );
  reconnectAttempts++;

  logger.info(`[HQ] Reconnecting in ${delay / 1000}s...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * Connect to CODEV_HQ
 */
function connect(): void {
  const hqUrl = process.env.CODEV_HQ_URL;
  if (!hqUrl) return;

  logger.info(`[HQ] Connecting to ${hqUrl}...`);

  const apiKey = process.env.CODEV_HQ_API_KEY || 'dev-key-spike';
  const wsUrl = new URL(hqUrl);
  wsUrl.searchParams.set('key', apiKey);

  ws = new WebSocket(wsUrl.toString());

  ws.on('open', () => {
    logger.info('[HQ] WebSocket connected');
    startPingInterval();
  });

  ws.on('message', (data: Buffer) => {
    handleMessage(data.toString());
  });

  ws.on('close', (code, reason) => {
    logger.warn(`[HQ] Disconnected (code: ${code})`);
    cleanup();
    scheduleReconnect();
  });

  ws.on('error', (error) => {
    logger.error(`[HQ] WebSocket error: ${error.message}`);
  });
}

/**
 * Cleanup resources
 */
function cleanup(): void {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }

  if (statusWatcher) {
    statusWatcher.close();
    statusWatcher = null;
  }

  ws = null;
}

/**
 * Connect to HQ and register this agent farm instance
 * Called during project activation when CODEV_HQ_URL is set
 */
export function initHQConnector(root: string): void {
  const hqUrl = process.env.CODEV_HQ_URL;
  if (!hqUrl) {
    logger.debug('[HQ] CODEV_HQ_URL not set, HQ connector disabled');
    return;
  }

  instanceId = randomUUID();
  projectRoot = root;

  logger.info('[HQ] HQ connector enabled');
  connect();
}

/**
 * Check if HQ connector is enabled
 */
export function isHQEnabled(): boolean {
  return !!process.env.CODEV_HQ_URL;
}
