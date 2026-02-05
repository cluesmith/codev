#!/usr/bin/env node

/**
 * Tower server for Agent Farm.
 * Provides a centralized view of all agent-farm instances across projects.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { WebSocketServer, WebSocket } from 'ws';
import { getGlobalDb } from '../db/index.js';
import { cleanupStaleEntries } from '../utils/port-registry.js';
import { escapeHtml, parseJsonBody, isRequestAllowed } from '../utils/server-utils.js';
import { TerminalManager } from '../../terminal/pty-manager.js';
import { encodeData, encodeControl, decodeFrame } from '../../terminal/ws-protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default port for tower dashboard
const DEFAULT_PORT = 4100;

// Rate limiting for activation requests (Spec 0090 Phase 1)
// Simple in-memory rate limiter: 10 activations per minute per client
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const activationRateLimits = new Map<string, RateLimitEntry>();

/**
 * Check if a client has exceeded the rate limit for activations
 * Returns true if rate limit exceeded, false if allowed
 */
function isRateLimited(clientIp: string): boolean {
  const now = Date.now();
  const entry = activationRateLimits.get(clientIp);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    // New window
    activationRateLimits.set(clientIp, { count: 1, windowStart: now });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return true;
  }

  entry.count++;
  return false;
}

/**
 * Clean up old rate limit entries periodically
 */
function cleanupRateLimits(): void {
  const now = Date.now();
  for (const [ip, entry] of activationRateLimits.entries()) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS * 2) {
      activationRateLimits.delete(ip);
    }
  }
}

// Cleanup stale rate limit entries every 5 minutes
setInterval(cleanupRateLimits, 5 * 60 * 1000);

// ============================================================================
// PHASE 2 & 4: Terminal Management (Spec 0090)
// ============================================================================

// Global TerminalManager instance for tower-managed terminals
// Uses a temporary directory as projectRoot since terminals can be for any project
let terminalManager: TerminalManager | null = null;

// Project terminal registry - tracks which terminals belong to which project
// Map<projectPath, { architect?: terminalId, builders: Map<builderId, terminalId>, shells: Map<shellId, terminalId> }>
interface ProjectTerminals {
  architect?: string;
  builders: Map<string, string>;
  shells: Map<string, string>;
}
const projectTerminals = new Map<string, ProjectTerminals>();

/**
 * Get or create project terminal registry entry
 */
function getProjectTerminalsEntry(projectPath: string): ProjectTerminals {
  let entry = projectTerminals.get(projectPath);
  if (!entry) {
    entry = { builders: new Map(), shells: new Map() };
    projectTerminals.set(projectPath, entry);
  }
  return entry;
}

/**
 * Generate next shell ID for a project
 */
function getNextShellId(projectPath: string): string {
  const entry = getProjectTerminalsEntry(projectPath);
  let maxId = 0;
  for (const id of entry.shells.keys()) {
    const num = parseInt(id.replace('shell-', ''), 10);
    if (!isNaN(num) && num > maxId) maxId = num;
  }
  return `shell-${maxId + 1}`;
}

/**
 * Get or create the global TerminalManager instance
 */
function getTerminalManager(): TerminalManager {
  if (!terminalManager) {
    // Use a neutral projectRoot - terminals specify their own cwd
    const projectRoot = process.env.HOME || '/tmp';
    terminalManager = new TerminalManager({
      projectRoot,
      logDir: path.join(homedir(), '.agent-farm', 'logs'),
      maxSessions: 100,
      ringBufferLines: 1000,
      diskLogEnabled: true,
      diskLogMaxBytes: 50 * 1024 * 1024,
      reconnectTimeoutMs: 300_000,
    });
  }
  return terminalManager;
}

// Import PtySession type for WebSocket handling
import type { PtySession } from '../../terminal/pty-session.js';

/**
 * Handle WebSocket connection to a terminal session
 * Uses hybrid binary protocol (Spec 0085):
 * - 0x00 prefix: Control frame (JSON)
 * - 0x01 prefix: Data frame (raw PTY bytes)
 */
function handleTerminalWebSocket(ws: WebSocket, session: PtySession, req: http.IncomingMessage): void {
  const resumeSeq = req.headers['x-session-resume'];

  // Create a client adapter for the PTY session
  // Uses binary protocol for data frames
  const client = {
    send: (data: Buffer | string) => {
      if (ws.readyState === WebSocket.OPEN) {
        // Encode as binary data frame (0x01 prefix)
        ws.send(encodeData(data));
      }
    },
  };

  // Attach client to session and get replay data
  let replayLines: string[];
  if (resumeSeq && typeof resumeSeq === 'string') {
    replayLines = session.attachResume(client, parseInt(resumeSeq, 10));
  } else {
    replayLines = session.attach(client);
  }

  // Send replay data as binary data frame
  if (replayLines.length > 0) {
    const replayData = replayLines.join('\n');
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encodeData(replayData));
    }
  }

  // Handle incoming messages from client (binary protocol)
  ws.on('message', (rawData: Buffer) => {
    try {
      const frame = decodeFrame(Buffer.from(rawData));

      if (frame.type === 'data') {
        // Write raw input to terminal
        session.write(frame.data.toString('utf-8'));
      } else if (frame.type === 'control') {
        // Handle control messages
        const msg = frame.message;
        if (msg.type === 'resize') {
          const cols = msg.payload.cols as number;
          const rows = msg.payload.rows as number;
          if (typeof cols === 'number' && typeof rows === 'number') {
            session.resize(cols, rows);
          }
        } else if (msg.type === 'ping') {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(encodeControl({ type: 'pong', payload: {} }));
          }
        }
      }
    } catch {
      // If decode fails, try treating as raw UTF-8 input (for simpler clients)
      try {
        session.write(rawData.toString('utf-8'));
      } catch {
        // Ignore malformed input
      }
    }
  });

  ws.on('close', () => {
    session.detach(client);
  });

  ws.on('error', () => {
    session.detach(client);
  });
}

// Parse arguments with Commander
const program = new Command()
  .name('tower-server')
  .description('Tower dashboard for Agent Farm - centralized view of all instances')
  .argument('[port]', 'Port to listen on', String(DEFAULT_PORT))
  .option('-p, --port <port>', 'Port to listen on (overrides positional argument)')
  .option('-l, --log-file <path>', 'Log file path for server output')
  .parse(process.argv);

const opts = program.opts();
const args = program.args;
const portArg = opts.port || args[0] || String(DEFAULT_PORT);
const port = parseInt(portArg, 10);
const logFilePath = opts.logFile;

// Logging utility
function log(level: 'INFO' | 'ERROR' | 'WARN', message: string): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}`;

  // Always log to console
  if (level === 'ERROR') {
    console.error(logLine);
  } else {
    console.log(logLine);
  }

  // Also log to file if configured
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, logLine + '\n');
    } catch {
      // Ignore file write errors
    }
  }
}

// Global exception handlers to catch uncaught errors
process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? `${reason.message}\n${reason.stack}` : String(reason);
  log('ERROR', `Unhandled rejection: ${message}`);
  process.exit(1);
});

// Graceful shutdown handler (Phase 2 - Spec 0090)
async function gracefulShutdown(signal: string): Promise<void> {
  log('INFO', `Received ${signal}, starting graceful shutdown...`);

  // 1. Stop accepting new connections
  server?.close();

  // 2. Close all WebSocket connections
  if (terminalWss) {
    for (const client of terminalWss.clients) {
      client.close(1001, 'Server shutting down');
    }
    terminalWss.close();
  }

  // 3. Kill all PTY sessions
  if (terminalManager) {
    log('INFO', 'Shutting down terminal manager...');
    terminalManager.shutdown();
  }

  // 4. Stop cloudflared tunnel if running
  stopTunnel();

  log('INFO', 'Graceful shutdown complete');
  process.exit(0);
}

// Catch signals for clean shutdown
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

if (isNaN(port) || port < 1 || port > 65535) {
  log('ERROR', `Invalid port "${portArg}". Must be a number between 1 and 65535.`);
  process.exit(1);
}

log('INFO', `Tower server starting on port ${port}`);

// Interface for port registry entries (from SQLite)
interface PortAllocation {
  project_path: string;
  base_port: number;
  pid: number | null;
  registered_at: string;
  last_used_at: string;
}

// Interface for gate status
interface GateStatus {
  hasGate: boolean;
  gateName?: string;
  builderId?: string;
  timestamp?: number;
}

// Interface for terminal entry in tower UI
interface TerminalEntry {
  type: 'architect' | 'builder' | 'shell' | 'file';
  id: string;
  label: string;
  url: string;
  active: boolean;
}

// Interface for instance status returned to UI
interface InstanceStatus {
  projectPath: string;
  projectName: string;
  basePort: number;
  dashboardPort: number;
  architectPort: number;
  registered: string;
  lastUsed?: string;
  running: boolean;
  proxyUrl: string; // Tower proxy URL for dashboard
  architectUrl: string; // Direct URL to architect terminal
  terminals: TerminalEntry[]; // All available terminals
  ports: {
    type: string;
    port: number;
    url: string;
    active: boolean;
  }[];
  gateStatus?: GateStatus;
}

/**
 * Load port allocations from SQLite database
 */
function loadPortAllocations(): PortAllocation[] {
  try {
    const db = getGlobalDb();
    return db.prepare('SELECT * FROM port_allocations ORDER BY last_used_at DESC').all() as PortAllocation[];
  } catch (err) {
    log('ERROR', `Error loading port allocations: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Check if a port is listening
 */
async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      resolve(false);
    });
    socket.connect(port, '127.0.0.1');
  });
}

/**
 * Get project name from path
 */
function getProjectName(projectPath: string): string {
  return path.basename(projectPath);
}

/**
 * Get the base port for a project from global.db
 * Returns null if project not found or not running
 */
async function getBasePortForProject(projectPath: string): Promise<number | null> {
  try {
    const db = getGlobalDb();
    const row = db.prepare(
      'SELECT base_port FROM port_allocations WHERE project_path = ?'
    ).get(projectPath) as { base_port: number } | undefined;

    if (!row) return null;

    // Check if actually running
    const isRunning = await isPortListening(row.base_port);
    return isRunning ? row.base_port : null;
  } catch {
    return null;
  }
}

// Cloudflared tunnel management
let tunnelProcess: ReturnType<typeof spawn> | null = null;
let tunnelUrl: string | null = null;

function isCloudflaredInstalled(): boolean {
  try {
    execSync('which cloudflared', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getTunnelStatus(): { available: boolean; running: boolean; url: string | null } {
  return {
    available: isCloudflaredInstalled(),
    running: tunnelProcess !== null && tunnelUrl !== null,
    url: tunnelUrl,
  };
}

async function startTunnel(port: number): Promise<{ success: boolean; url?: string; error?: string }> {
  if (!isCloudflaredInstalled()) {
    return { success: false, error: 'cloudflared not installed. Install with: brew install cloudflared' };
  }

  if (tunnelProcess) {
    return { success: true, url: tunnelUrl || undefined };
  }

  return new Promise((resolve) => {
    tunnelProcess = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const handleOutput = (data: Buffer) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[0];
        log('INFO', `Cloudflared tunnel started: ${tunnelUrl}`);
        resolve({ success: true, url: tunnelUrl });
      }
    };

    tunnelProcess.stdout?.on('data', handleOutput);
    tunnelProcess.stderr?.on('data', handleOutput);

    tunnelProcess.on('close', (code) => {
      log('INFO', `Cloudflared tunnel closed with code ${code}`);
      tunnelProcess = null;
      tunnelUrl = null;
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!tunnelUrl) {
        tunnelProcess?.kill();
        tunnelProcess = null;
        resolve({ success: false, error: 'Tunnel startup timed out' });
      }
    }, 30000);
  });
}

function stopTunnel(): { success: boolean } {
  if (tunnelProcess) {
    tunnelProcess.kill();
    tunnelProcess = null;
    tunnelUrl = null;
    log('INFO', 'Cloudflared tunnel stopped');
  }
  return { success: true };
}

// SSE (Server-Sent Events) infrastructure for push notifications
interface SSEClient {
  res: http.ServerResponse;
  id: string;
}

const sseClients: SSEClient[] = [];
let notificationIdCounter = 0;

/**
 * Broadcast a notification to all connected SSE clients
 */
function broadcastNotification(notification: { type: string; title: string; body: string; project?: string }): void {
  const id = ++notificationIdCounter;
  const data = JSON.stringify({ ...notification, id });
  const message = `id: ${id}\ndata: ${data}\n\n`;

  for (const client of sseClients) {
    try {
      client.res.write(message);
    } catch {
      // Client disconnected, will be cleaned up on next iteration
    }
  }
}

/**
 * Get gate status for a project by querying its dashboard API.
 * Uses timeout to prevent hung projects from stalling tower status.
 */
async function getGateStatusForProject(basePort: number): Promise<GateStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000); // 2-second timeout

  try {
    const response = await fetch(`http://localhost:${basePort}/api/status`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return { hasGate: false };

    const projectStatus = await response.json();
    // Check if any builder has a pending gate
    const builderWithGate = projectStatus.builders?.find(
      (b: { gateStatus?: { waiting?: boolean }; status?: string; currentGate?: string; id?: string }) =>
        b.gateStatus?.waiting || b.status === 'gate-pending'
    );

    if (builderWithGate) {
      return {
        hasGate: true,
        gateName: builderWithGate.gateStatus?.gateName || builderWithGate.currentGate,
        builderId: builderWithGate.id,
        timestamp: builderWithGate.gateStatus?.timestamp || Date.now(),
      };
    }
  } catch {
    // Project dashboard not responding or timeout
  }
  return { hasGate: false };
}

/**
 * Get terminal list for a project from tower's registry.
 * Phase 4 (Spec 0090): Tower manages terminals directly, no dashboard-server fetch.
 * Returns architect, builders, and shells with their URLs.
 */
function getTerminalsForProject(
  projectPath: string,
  proxyUrl: string
): { terminals: TerminalEntry[]; gateStatus: GateStatus } {
  const entry = projectTerminals.get(projectPath);
  const manager = getTerminalManager();
  const terminals: TerminalEntry[] = [];

  if (!entry) {
    return { terminals: [], gateStatus: { hasGate: false } };
  }

  // Add architect terminal
  if (entry.architect) {
    const session = manager.getSession(entry.architect);
    if (session) {
      terminals.push({
        type: 'architect',
        id: 'architect',
        label: 'Architect',
        url: `${proxyUrl}?tab=architect`,
        active: true,
      });
    }
  }

  // Add builder terminals
  for (const [builderId] of entry.builders) {
    const terminalId = entry.builders.get(builderId);
    if (terminalId) {
      const session = manager.getSession(terminalId);
      if (session) {
        terminals.push({
          type: 'builder',
          id: builderId,
          label: `Builder ${builderId}`,
          url: `${proxyUrl}?tab=builder-${builderId}`,
          active: true,
        });
      }
    }
  }

  // Add shell terminals
  for (const [shellId] of entry.shells) {
    const terminalId = entry.shells.get(shellId);
    if (terminalId) {
      const session = manager.getSession(terminalId);
      if (session) {
        terminals.push({
          type: 'shell',
          id: shellId,
          label: `Shell ${shellId.replace('shell-', '')}`,
          url: `${proxyUrl}?tab=shell-${shellId}`,
          active: true,
        });
      }
    }
  }

  // Gate status - builders don't have gate tracking yet in tower
  // TODO: Add gate status tracking when porch integration is updated
  const gateStatus: GateStatus = { hasGate: false };

  return { terminals, gateStatus };
}

/**
 * Get all instances with their status
 */
async function getInstances(): Promise<InstanceStatus[]> {
  const allocations = loadPortAllocations();
  const instances: InstanceStatus[] = [];

  for (const allocation of allocations) {
    // Skip builder worktrees - they're managed by their parent project
    if (allocation.project_path.includes('/.builders/')) {
      continue;
    }
    const basePort = allocation.base_port;
    const dashboardPort = basePort;

    // Encode project path for proxy URL
    const encodedPath = Buffer.from(allocation.project_path).toString('base64url');
    const proxyUrl = `/project/${encodedPath}/`;

    // Get terminals and gate status from tower's registry
    // Phase 4 (Spec 0090): Tower manages terminals directly - no separate dashboard server
    const { terminals, gateStatus } = getTerminalsForProject(allocation.project_path, proxyUrl);

    // Project is active if it has any terminals (Phase 4: no port check needed)
    const isActive = terminals.length > 0;

    const ports = [
      {
        type: 'Dashboard',
        port: dashboardPort,
        url: proxyUrl, // Use tower proxy URL, not raw localhost
        active: isActive,
      },
    ];

    instances.push({
      projectPath: allocation.project_path,
      projectName: getProjectName(allocation.project_path),
      basePort,
      dashboardPort,
      architectPort: basePort + 1, // Legacy field for backward compat
      registered: allocation.registered_at,
      lastUsed: allocation.last_used_at,
      running: isActive,
      proxyUrl, // Tower proxy URL for dashboard
      architectUrl: `${proxyUrl}?tab=architect`, // Direct URL to architect terminal
      terminals, // All available terminals
      ports,
      gateStatus,
    });
  }

  // Sort: running first, then by last used (most recent first)
  instances.sort((a, b) => {
    if (a.running !== b.running) {
      return a.running ? -1 : 1;
    }
    const aTime = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const bTime = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return bTime - aTime;
  });

  return instances;
}

/**
 * Get directory suggestions for autocomplete
 */
async function getDirectorySuggestions(inputPath: string): Promise<{ path: string; isProject: boolean }[]> {
  // Default to home directory if empty
  if (!inputPath) {
    inputPath = homedir();
  }

  // Expand ~ to home directory
  if (inputPath.startsWith('~')) {
    inputPath = inputPath.replace('~', homedir());
  }

  // Determine the directory to list and the prefix to filter by
  let dirToList: string;
  let prefix: string;

  if (inputPath.endsWith('/')) {
    // User typed a complete directory path, list its contents
    dirToList = inputPath;
    prefix = '';
  } else {
    // User is typing a partial name, list parent and filter
    dirToList = path.dirname(inputPath);
    prefix = path.basename(inputPath).toLowerCase();
  }

  // Check if directory exists
  if (!fs.existsSync(dirToList)) {
    return [];
  }

  const stat = fs.statSync(dirToList);
  if (!stat.isDirectory()) {
    return [];
  }

  // Read directory contents
  const entries = fs.readdirSync(dirToList, { withFileTypes: true });

  // Filter to directories only, apply prefix filter, and check for codev/
  const suggestions: { path: string; isProject: boolean }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // Skip hidden directories

    const name = entry.name.toLowerCase();
    if (prefix && !name.startsWith(prefix)) continue;

    const fullPath = path.join(dirToList, entry.name);
    const isProject = fs.existsSync(path.join(fullPath, 'codev'));

    suggestions.push({ path: fullPath, isProject });
  }

  // Sort: projects first, then alphabetically
  suggestions.sort((a, b) => {
    if (a.isProject !== b.isProject) {
      return a.isProject ? -1 : 1;
    }
    return a.path.localeCompare(b.path);
  });

  // Limit to 20 suggestions
  return suggestions.slice(0, 20);
}

/**
 * Launch a new agent-farm instance
 * Phase 4 (Spec 0090): Tower manages terminals directly, no dashboard-server
 * Auto-adopts non-codev directories and creates architect terminal
 */
async function launchInstance(projectPath: string): Promise<{ success: boolean; error?: string; adopted?: boolean }> {
  // Clean up stale port allocations before launching (handles machine restarts)
  cleanupStaleEntries();

  // Validate path exists
  if (!fs.existsSync(projectPath)) {
    return { success: false, error: `Path does not exist: ${projectPath}` };
  }

  // Validate it's a directory
  const stat = fs.statSync(projectPath);
  if (!stat.isDirectory()) {
    return { success: false, error: `Not a directory: ${projectPath}` };
  }

  // Auto-adopt non-codev directories
  const codevDir = path.join(projectPath, 'codev');
  let adopted = false;
  if (!fs.existsSync(codevDir)) {
    try {
      // Run codev adopt --yes to set up the project
      execSync('npx codev adopt --yes', {
        cwd: projectPath,
        stdio: 'pipe',
        timeout: 30000,
      });
      adopted = true;
      log('INFO', `Auto-adopted codev in: ${projectPath}`);
    } catch (err) {
      return { success: false, error: `Failed to adopt codev: ${(err as Error).message}` };
    }
  }

  // Phase 4 (Spec 0090): Tower manages terminals directly
  // No dashboard-server spawning - tower handles everything
  try {
    // Clear any stale state file
    const stateFile = path.join(projectPath, '.agent-farm', 'state.json');
    if (fs.existsSync(stateFile)) {
      try {
        fs.unlinkSync(stateFile);
      } catch {
        // Ignore - file might not exist or be locked
      }
    }

    // Ensure project has port allocation
    const resolvedPath = fs.realpathSync(projectPath);
    const db = getGlobalDb();
    let allocation = db
      .prepare('SELECT base_port FROM port_allocations WHERE project_path = ? OR project_path = ?')
      .get(projectPath, resolvedPath) as { base_port: number } | undefined;

    if (!allocation) {
      // Allocate a new port for this project
      // Find the next available port block (starting at 4200, incrementing by 100)
      const existingPorts = db
        .prepare('SELECT base_port FROM port_allocations ORDER BY base_port')
        .all() as { base_port: number }[];

      let nextPort = 4200;
      for (const { base_port } of existingPorts) {
        if (base_port >= nextPort) {
          nextPort = base_port + 100;
        }
      }

      db.prepare(
        "INSERT INTO port_allocations (project_path, project_name, base_port, created_at) VALUES (?, ?, ?, datetime('now'))"
      ).run(resolvedPath, path.basename(projectPath), nextPort);

      allocation = { base_port: nextPort };
      log('INFO', `Allocated port ${nextPort} for project: ${projectPath}`);
    }

    // Initialize project terminal entry
    const entry = getProjectTerminalsEntry(resolvedPath);

    // Create architect terminal if not already present
    if (!entry.architect) {
      const manager = getTerminalManager();

      // Read af-config.json to get the architect command
      let architectCmd = 'claude';
      const configPath = path.join(projectPath, 'af-config.json');
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          if (config.shell?.architect) {
            architectCmd = config.shell.architect;
          }
        } catch {
          // Ignore config read errors, use default
        }
      }

      try {
        const session = await manager.createSession({
          command: architectCmd,
          args: [],
          cwd: projectPath,
          label: 'Architect',
          env: process.env as Record<string, string>,
        });

        entry.architect = session.id;
        log('INFO', `Created architect terminal for project: ${projectPath}`);
      } catch (err) {
        log('WARN', `Failed to create architect terminal: ${(err as Error).message}`);
        // Don't fail the launch - project is still active, just without architect
      }
    }

    return { success: true, adopted };
  } catch (err) {
    return { success: false, error: `Failed to launch: ${(err as Error).message}` };
  }
}

/**
 * Get PID of process listening on a port
 */
function getProcessOnPort(targetPort: number): number | null {
  try {
    const result = execSync(`lsof -ti :${targetPort} 2>/dev/null`, { encoding: 'utf-8' });
    const pid = parseInt(result.trim().split('\n')[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Stop an agent-farm instance by killing all its terminals
 * Phase 4 (Spec 0090): Tower manages terminals directly
 */
async function stopInstance(projectPath: string): Promise<{ success: boolean; error?: string; stopped: number[] }> {
  const stopped: number[] = [];
  const manager = getTerminalManager();

  // Resolve symlinks for consistent lookup
  let resolvedPath = projectPath;
  try {
    if (fs.existsSync(projectPath)) {
      resolvedPath = fs.realpathSync(projectPath);
    }
  } catch {
    // Ignore - use original path
  }

  // Get project terminals
  const entry = projectTerminals.get(resolvedPath) || projectTerminals.get(projectPath);

  if (entry) {
    // Kill architect
    if (entry.architect) {
      const session = manager.getSession(entry.architect);
      if (session) {
        manager.killSession(entry.architect);
        stopped.push(session.pid);
      }
    }

    // Kill all shells
    for (const terminalId of entry.shells.values()) {
      const session = manager.getSession(terminalId);
      if (session) {
        manager.killSession(terminalId);
        stopped.push(session.pid);
      }
    }

    // Kill all builders
    for (const terminalId of entry.builders.values()) {
      const session = manager.getSession(terminalId);
      if (session) {
        manager.killSession(terminalId);
        stopped.push(session.pid);
      }
    }

    // Clear project from registry
    projectTerminals.delete(resolvedPath);
    projectTerminals.delete(projectPath);
  }

  if (stopped.length === 0) {
    return { success: true, error: 'No terminals found to stop', stopped };
  }

  return { success: true, stopped };
}

/**
 * Find the tower template
 * Template is bundled with agent-farm package in templates/ directory
 */
function findTemplatePath(): string | null {
  // Templates are at package root: packages/codev/templates/
  // From compiled: dist/agent-farm/servers/ -> ../../../templates/
  // From source: src/agent-farm/servers/ -> ../../../templates/
  const pkgPath = path.resolve(__dirname, '../../../templates/tower.html');
  if (fs.existsSync(pkgPath)) {
    return pkgPath;
  }

  return null;
}

// escapeHtml, parseJsonBody, isRequestAllowed imported from ../utils/server-utils.js

// Find template path
const templatePath = findTemplatePath();

// WebSocket server for terminal connections (Phase 2 - Spec 0090)
let terminalWss: WebSocketServer | null = null;

// React dashboard dist path (for serving directly from tower)
// React dashboard dist path (for serving directly from tower)
// Phase 4 (Spec 0090): Tower serves everything directly, no dashboard-server
const reactDashboardPath = path.resolve(__dirname, '../../../dashboard/dist');
const hasReactDashboard = fs.existsSync(reactDashboardPath);
if (hasReactDashboard) {
  log('INFO', `React dashboard found at: ${reactDashboardPath}`);
} else {
  log('WARN', 'React dashboard not found - project dashboards will not work');
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

/**
 * Serve a static file from the React dashboard dist
 */
function serveStaticFile(filePath: string, res: http.ServerResponse): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// Create server
const server = http.createServer(async (req, res) => {
  // Security: Validate Host and Origin headers
  if (!isRequestAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CORS headers
  const origin = req.headers.origin;
  if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${port}`);

  try {
    // =========================================================================
    // NEW API ENDPOINTS (Spec 0090 - Tower as Single Daemon)
    // =========================================================================

    // Health check endpoint (Spec 0090 Phase 1)
    if (req.method === 'GET' && url.pathname === '/health') {
      const instances = await getInstances();
      const activeCount = instances.filter((i) => i.running).length;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'healthy',
          uptime: process.uptime(),
          activeProjects: activeCount,
          totalProjects: instances.length,
          memoryUsage: process.memoryUsage().heapUsed,
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // API: List all projects (Spec 0090 Phase 1)
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const instances = await getInstances();
      const projects = instances.map((i) => ({
        path: i.projectPath,
        name: i.projectName,
        basePort: i.basePort,
        active: i.running,
        proxyUrl: i.proxyUrl,
        terminals: i.terminals.length,
        lastUsed: i.lastUsed,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ projects }));
      return;
    }

    // API: Project-specific endpoints (Spec 0090 Phase 1)
    // Routes: /api/projects/:encodedPath/activate, /deactivate, /status
    const projectApiMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/(activate|deactivate|status)$/);
    if (projectApiMatch) {
      const [, encodedPath, action] = projectApiMatch;
      let projectPath: string;
      try {
        projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
        if (!projectPath || (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath))) {
          throw new Error('Invalid path');
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project path encoding' }));
        return;
      }

      // GET /api/projects/:path/status
      if (req.method === 'GET' && action === 'status') {
        const instances = await getInstances();
        const instance = instances.find((i) => i.projectPath === projectPath);
        if (!instance) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            path: instance.projectPath,
            name: instance.projectName,
            active: instance.running,
            basePort: instance.basePort,
            terminals: instance.terminals,
            gateStatus: instance.gateStatus,
          })
        );
        return;
      }

      // POST /api/projects/:path/activate
      if (req.method === 'POST' && action === 'activate') {
        // Rate limiting: 10 activations per minute per client
        const clientIp = req.socket.remoteAddress || '127.0.0.1';
        if (isRateLimited(clientIp)) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many activations, try again later' }));
          return;
        }

        const result = await launchInstance(projectPath);
        if (result.success) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, adopted: result.adopted }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: result.error }));
        }
        return;
      }

      // POST /api/projects/:path/deactivate
      if (req.method === 'POST' && action === 'deactivate') {
        // Check if project exists in port allocations
        const allocations = loadPortAllocations();
        const resolvedPath = fs.existsSync(projectPath) ? fs.realpathSync(projectPath) : projectPath;
        const allocation = allocations.find(
          (a) => a.project_path === projectPath || a.project_path === resolvedPath
        );

        if (!allocation) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Project not found' }));
          return;
        }

        // Phase 4: Stop terminals directly via tower
        const result = await stopInstance(projectPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
    }

    // =========================================================================
    // TERMINAL API (Phase 2 - Spec 0090)
    // =========================================================================

    // POST /api/terminals - Create a new terminal
    if (req.method === 'POST' && url.pathname === '/api/terminals') {
      try {
        const body = await parseJsonBody(req);
        const manager = getTerminalManager();
        const info = await manager.createSession({
          command: typeof body.command === 'string' ? body.command : undefined,
          args: Array.isArray(body.args) ? body.args : undefined,
          cols: typeof body.cols === 'number' ? body.cols : undefined,
          rows: typeof body.rows === 'number' ? body.rows : undefined,
          cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
          env: typeof body.env === 'object' && body.env !== null ? (body.env as Record<string, string>) : undefined,
          label: typeof body.label === 'string' ? body.label : undefined,
        });
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...info, wsPath: `/ws/terminal/${info.id}` }));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        log('ERROR', `Failed to create terminal: ${message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR', message }));
      }
      return;
    }

    // GET /api/terminals - List all terminals
    if (req.method === 'GET' && url.pathname === '/api/terminals') {
      const manager = getTerminalManager();
      const terminals = manager.listSessions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ terminals }));
      return;
    }

    // Terminal-specific routes: /api/terminals/:id/*
    const terminalRouteMatch = url.pathname.match(/^\/api\/terminals\/([^/]+)(\/.*)?$/);
    if (terminalRouteMatch) {
      const [, terminalId, subpath] = terminalRouteMatch;
      const manager = getTerminalManager();

      // GET /api/terminals/:id - Get terminal info
      if (req.method === 'GET' && (!subpath || subpath === '')) {
        const session = manager.getSession(terminalId);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session.info));
        return;
      }

      // DELETE /api/terminals/:id - Kill terminal
      if (req.method === 'DELETE' && (!subpath || subpath === '')) {
        if (!manager.killSession(terminalId)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
          return;
        }
        res.writeHead(204);
        res.end();
        return;
      }

      // POST /api/terminals/:id/resize - Resize terminal
      if (req.method === 'POST' && subpath === '/resize') {
        try {
          const body = await parseJsonBody(req);
          if (typeof body.cols !== 'number' || typeof body.rows !== 'number') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'cols and rows must be numbers' }));
            return;
          }
          const info = manager.resizeSession(terminalId, body.cols, body.rows);
          if (!info) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(info));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'INVALID_PARAMS', message: 'Invalid JSON body' }));
        }
        return;
      }

      // GET /api/terminals/:id/output - Get terminal output
      if (req.method === 'GET' && subpath === '/output') {
        const lines = parseInt(url.searchParams.get('lines') ?? '100', 10);
        const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
        const output = manager.getOutput(terminalId, lines, offset);
        if (!output) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'NOT_FOUND', message: `Session ${terminalId} not found` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(output));
        return;
      }
    }

    // =========================================================================
    // EXISTING API ENDPOINTS
    // =========================================================================

    // API: Get status of all instances (legacy - kept for backward compat)
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const instances = await getInstances();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ instances }));
      return;
    }

    // API: Server-Sent Events for push notifications
    if (req.method === 'GET' && url.pathname === '/api/events') {
      const clientId = crypto.randomBytes(8).toString('hex');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      // Send initial connection event
      res.write(`data: ${JSON.stringify({ type: 'connected', id: clientId })}\n\n`);

      const client: SSEClient = { res, id: clientId };
      sseClients.push(client);

      log('INFO', `SSE client connected: ${clientId} (total: ${sseClients.length})`);

      // Clean up on disconnect
      req.on('close', () => {
        const index = sseClients.findIndex((c) => c.id === clientId);
        if (index !== -1) {
          sseClients.splice(index, 1);
        }
        log('INFO', `SSE client disconnected: ${clientId} (total: ${sseClients.length})`);
      });

      return;
    }

    // API: Receive notification from builder
    if (req.method === 'POST' && url.pathname === '/api/notify') {
      const body = await parseJsonBody(req);
      const type = typeof body.type === 'string' ? body.type : 'info';
      const title = typeof body.title === 'string' ? body.title : '';
      const messageBody = typeof body.body === 'string' ? body.body : '';
      const project = typeof body.project === 'string' ? body.project : undefined;

      if (!title || !messageBody) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing title or body' }));
        return;
      }

      // Broadcast to all connected SSE clients
      broadcastNotification({
        type,
        title,
        body: messageBody,
        project,
      });

      log('INFO', `Notification broadcast: ${title}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // API: Browse directories for autocomplete
    if (req.method === 'GET' && url.pathname === '/api/browse') {
      const inputPath = url.searchParams.get('path') || '';

      try {
        const suggestions = await getDirectorySuggestions(inputPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ suggestions }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ suggestions: [], error: (err as Error).message }));
      }
      return;
    }

    // API: Create new project
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const body = await parseJsonBody(req);
      const parentPath = body.parent as string;
      const projectName = body.name as string;

      if (!parentPath || !projectName) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing parent or name' }));
        return;
      }

      // Validate project name
      if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid project name' }));
        return;
      }

      // Expand ~ to home directory
      let expandedParent = parentPath;
      if (expandedParent.startsWith('~')) {
        expandedParent = expandedParent.replace('~', homedir());
      }

      // Validate parent exists
      if (!fs.existsSync(expandedParent)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Parent directory does not exist: ${parentPath}` }));
        return;
      }

      const projectPath = path.join(expandedParent, projectName);

      // Check if project already exists
      if (fs.existsSync(projectPath)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Directory already exists: ${projectPath}` }));
        return;
      }

      try {
        // Run codev init (it creates the directory)
        execSync(`codev init --yes "${projectName}"`, {
          cwd: expandedParent,
          stdio: 'pipe',
          timeout: 60000,
        });

        // Launch the instance
        const launchResult = await launchInstance(projectPath);
        if (!launchResult.success) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: launchResult.error }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, projectPath }));
      } catch (err) {
        // Clean up on failure
        try {
          if (fs.existsSync(projectPath)) {
            fs.rmSync(projectPath, { recursive: true });
          }
        } catch {
          // Ignore cleanup errors
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `Failed to create project: ${(err as Error).message}` }));
      }
      return;
    }

    // API: Launch new instance
    if (req.method === 'POST' && url.pathname === '/api/launch') {
      const body = await parseJsonBody(req);
      const projectPath = body.projectPath as string;

      if (!projectPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing projectPath' }));
        return;
      }

      const result = await launchInstance(projectPath);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: Get tunnel status (cloudflared availability and running tunnel)
    if (req.method === 'GET' && url.pathname === '/api/tunnel/status') {
      const status = getTunnelStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    // API: Start cloudflared tunnel
    if (req.method === 'POST' && url.pathname === '/api/tunnel/start') {
      const result = await startTunnel(port);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: Stop cloudflared tunnel
    if (req.method === 'POST' && url.pathname === '/api/tunnel/stop') {
      const result = stopTunnel();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: Stop an instance
    // Phase 4 (Spec 0090): Accept projectPath or basePort for backwards compat
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const body = await parseJsonBody(req);
      let targetPath = body.projectPath as string;

      // Backwards compat: if basePort provided, find the project path
      if (!targetPath && body.basePort) {
        const allocations = loadPortAllocations();
        const allocation = allocations.find((a) => a.base_port === body.basePort);
        targetPath = allocation?.project_path || '';
      }

      if (!targetPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing projectPath or basePort' }));
        return;
      }

      const result = await stopInstance(targetPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // Serve dashboard
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      if (!templatePath) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Template not found. Make sure tower.html exists in agent-farm/templates/');
        return;
      }

      try {
        const template = fs.readFileSync(templatePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(template);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading template: ' + (err as Error).message);
      }
      return;
    }

    // Project routes: /project/:base64urlPath/*
    // Phase 4 (Spec 0090): Tower serves React dashboard and handles APIs directly
    // Uses Base64URL (RFC 4648) encoding to avoid issues with slashes in paths
    if (url.pathname.startsWith('/project/')) {
      const pathParts = url.pathname.split('/');
      // ['', 'project', base64urlPath, ...rest]
      const encodedPath = pathParts[2];
      const subPath = pathParts.slice(3).join('/');

      if (!encodedPath) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing project path');
        return;
      }

      // Decode Base64URL (RFC 4648)
      let projectPath: string;
      try {
        projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
        // Support both POSIX (/) and Windows (C:\) paths
        if (!projectPath || (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath))) {
          throw new Error('Invalid project path');
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid project path encoding');
        return;
      }

      const basePort = await getBasePortForProject(projectPath);

      // Phase 4 (Spec 0090): Tower handles everything directly
      const isApiCall = subPath.startsWith('api/') || subPath === 'api';
      const isWsPath = subPath.startsWith('ws/') || subPath === 'ws';

      // Serve React dashboard static files directly if:
      // 1. Not an API call
      // 2. Not a WebSocket path
      // 3. React dashboard is available
      // 4. Project doesn't need to be running for static files
      if (!isApiCall && !isWsPath && hasReactDashboard) {
        // Determine which static file to serve
        let staticPath: string;
        if (!subPath || subPath === '' || subPath === 'index.html') {
          staticPath = path.join(reactDashboardPath, 'index.html');
        } else {
          // Check if it's a static asset
          staticPath = path.join(reactDashboardPath, subPath);
        }

        // Try to serve the static file
        if (serveStaticFile(staticPath, res)) {
          return;
        }

        // SPA fallback: serve index.html for client-side routing
        const indexPath = path.join(reactDashboardPath, 'index.html');
        if (serveStaticFile(indexPath, res)) {
          return;
        }
      }

      // Phase 4 (Spec 0090): Handle project APIs directly instead of proxying to dashboard-server
      if (isApiCall) {
        const apiPath = subPath.replace(/^api\/?/, '');

        // GET /api/state - Return project state (architect, builders, shells)
        if (req.method === 'GET' && (apiPath === 'state' || apiPath === '')) {
          const entry = getProjectTerminalsEntry(projectPath);
          const manager = getTerminalManager();

          // Build state response compatible with React dashboard
          const state: {
            architect: { port: number; pid: number; terminalId?: string } | null;
            builders: Array<{ id: string; name: string; port: number; pid: number; status: string; phase: string; worktree: string; branch: string; type: string; terminalId?: string }>;
            utils: Array<{ id: string; name: string; port: number; pid: number; terminalId?: string }>;
            annotations: Array<{ id: string; file: string; port: number; pid: number }>;
            projectName?: string;
          } = {
            architect: null,
            builders: [],
            utils: [],
            annotations: [],
            projectName: path.basename(projectPath),
          };

          // Add architect if exists
          if (entry.architect) {
            const session = manager.getSession(entry.architect);
            state.architect = {
              port: basePort || 0,
              pid: session?.pid || 0,
              terminalId: entry.architect,
            };
          }

          // Add shells
          for (const [shellId, terminalId] of entry.shells) {
            const session = manager.getSession(terminalId);
            state.utils.push({
              id: shellId,
              name: `Shell ${shellId.replace('shell-', '')}`,
              port: basePort || 0,
              pid: session?.pid || 0,
              terminalId,
            });
          }

          // Add builders
          for (const [builderId, terminalId] of entry.builders) {
            const session = manager.getSession(terminalId);
            state.builders.push({
              id: builderId,
              name: `Builder ${builderId}`,
              port: basePort || 0,
              pid: session?.pid || 0,
              status: 'running',
              phase: '',
              worktree: '',
              branch: '',
              type: 'spec',
              terminalId,
            });
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(state));
          return;
        }

        // POST /api/tabs/shell - Create a new shell terminal
        if (req.method === 'POST' && apiPath === 'tabs/shell') {
          try {
            const manager = getTerminalManager();
            const shellId = getNextShellId(projectPath);

            // Create terminal session
            const session = await manager.createSession({
              command: process.env.SHELL || '/bin/bash',
              args: [],
              cwd: projectPath,
              label: `Shell ${shellId.replace('shell-', '')}`,
              env: process.env as Record<string, string>,
            });

            // Register terminal with project
            const entry = getProjectTerminalsEntry(projectPath);
            entry.shells.set(shellId, session.id);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: shellId,
              port: basePort || 0,
              name: `Shell ${shellId.replace('shell-', '')}`,
              terminalId: session.id,
            }));
          } catch (err) {
            log('ERROR', `Failed to create shell: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // DELETE /api/tabs/:id - Delete a terminal tab
        const deleteMatch = apiPath.match(/^tabs\/(.+)$/);
        if (req.method === 'DELETE' && deleteMatch) {
          const tabId = deleteMatch[1];
          const entry = getProjectTerminalsEntry(projectPath);
          const manager = getTerminalManager();

          // Find and delete the terminal
          let terminalId: string | undefined;

          if (tabId.startsWith('shell-')) {
            terminalId = entry.shells.get(tabId);
            if (terminalId) {
              entry.shells.delete(tabId);
            }
          } else if (tabId.startsWith('builder-')) {
            terminalId = entry.builders.get(tabId);
            if (terminalId) {
              entry.builders.delete(tabId);
            }
          } else if (tabId === 'architect') {
            terminalId = entry.architect;
            if (terminalId) {
              entry.architect = undefined;
            }
          }

          if (terminalId) {
            manager.killSession(terminalId);
            res.writeHead(204);
            res.end();
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Tab not found' }));
          }
          return;
        }

        // POST /api/stop - Stop all terminals for project
        if (req.method === 'POST' && apiPath === 'stop') {
          const entry = getProjectTerminalsEntry(projectPath);
          const manager = getTerminalManager();

          // Kill all terminals
          if (entry.architect) {
            manager.killSession(entry.architect);
          }
          for (const terminalId of entry.shells.values()) {
            manager.killSession(terminalId);
          }
          for (const terminalId of entry.builders.values()) {
            manager.killSession(terminalId);
          }

          // Clear registry
          projectTerminals.delete(projectPath);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // Unhandled API route
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API endpoint not found', path: apiPath }));
        return;
      }

      // For WebSocket paths, let the upgrade handler deal with it
      if (isWsPath) {
        // WebSocket paths are handled by the upgrade handler
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('WebSocket connections should use ws:// protocol');
        return;
      }

      // If we get here for non-API, non-WS paths and React dashboard is not available
      if (!hasReactDashboard) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Dashboard not available');
        return;
      }

      // Fallback for unmatched paths
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    log('ERROR', `Request error: ${(err as Error).message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error: ' + (err as Error).message);
  }
});

// SECURITY: Bind to localhost only to prevent network exposure
server.listen(port, '127.0.0.1', () => {
  log('INFO', `Tower server listening at http://localhost:${port}`);
});

// Initialize terminal WebSocket server (Phase 2 - Spec 0090)
terminalWss = new WebSocketServer({ noServer: true });

// WebSocket upgrade handler for terminal connections and proxying
server.on('upgrade', async (req, socket, head) => {
  const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);

  // Phase 2: Handle /ws/terminal/:id routes directly
  const terminalMatch = reqUrl.pathname.match(/^\/ws\/terminal\/([^/]+)$/);
  if (terminalMatch) {
    const terminalId = terminalMatch[1];
    const manager = getTerminalManager();
    const session = manager.getSession(terminalId);

    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    terminalWss!.handleUpgrade(req, socket, head, (ws) => {
      handleTerminalWebSocket(ws, session, req);
    });
    return;
  }

  // Phase 4 (Spec 0090): Handle project WebSocket routes directly
  // Route: /project/:encodedPath/ws/terminal/:terminalId
  if (!reqUrl.pathname.startsWith('/project/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const pathParts = reqUrl.pathname.split('/');
  // ['', 'project', base64urlPath, 'ws', 'terminal', terminalId]
  const encodedPath = pathParts[2];

  if (!encodedPath) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Decode Base64URL (RFC 4648) - NOT URL encoding
  // Wrap in try/catch to handle malformed Base64 input gracefully
  let projectPath: string;
  try {
    projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
    // Support both POSIX (/) and Windows (C:\) paths
    if (!projectPath || (!projectPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(projectPath))) {
      throw new Error('Invalid project path');
    }
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Check for terminal WebSocket route: /project/:path/ws/terminal/:id
  const wsMatch = reqUrl.pathname.match(/^\/project\/[^/]+\/ws\/terminal\/([^/]+)$/);
  if (wsMatch) {
    const terminalId = wsMatch[1];
    const manager = getTerminalManager();
    const session = manager.getSession(terminalId);

    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    terminalWss!.handleUpgrade(req, socket, head, (ws) => {
      handleTerminalWebSocket(ws, session, req);
    });
    return;
  }

  // Unhandled WebSocket route
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${reason}`);
});
