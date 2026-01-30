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
import { getGlobalDb } from '../db/index.js';
import { cleanupStaleEntries } from '../utils/port-registry.js';
import { escapeHtml, parseJsonBody, isRequestAllowed } from '../utils/server-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default port for tower dashboard
const DEFAULT_PORT = 4100;

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
    const architectPort = basePort + 1;

    // Check if dashboard is running (main indicator of running instance)
    const dashboardActive = await isPortListening(dashboardPort);

    // Only check architect port if dashboard is active (to avoid unnecessary probing)
    const architectActive = dashboardActive ? await isPortListening(architectPort) : false;

    // Get gate status if running
    const gateStatus = dashboardActive ? await getGateStatusForProject(basePort) : { hasGate: false };

    const ports = [
      {
        type: 'Dashboard',
        port: dashboardPort,
        url: `http://localhost:${dashboardPort}`,
        active: dashboardActive,
      },
      {
        type: 'Architect',
        port: architectPort,
        url: `http://localhost:${architectPort}`,
        active: architectActive,
      },
    ];

    instances.push({
      projectPath: allocation.project_path,
      projectName: getProjectName(allocation.project_path),
      basePort,
      dashboardPort,
      architectPort,
      registered: allocation.registered_at,
      lastUsed: allocation.last_used_at,
      running: dashboardActive,
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
 * First stops any stale state, then starts fresh
 * Auto-adopts non-codev directories
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

  // Use codev af command (avoids npx cache issues)
  // Falls back to npx codev af if codev not in PATH

  // SECURITY: Use spawn with cwd option to avoid command injection
  // Do NOT use bash -c with string concatenation
  try {
    // First, stop any existing (possibly stale) instance
    const stopChild = spawn('codev', ['af', 'dash', 'stop'], {
      cwd: projectPath,
      stdio: 'ignore',
    });
    // Wait for stop to complete
    await new Promise<void>((resolve) => {
      stopChild.on('close', () => resolve());
      stopChild.on('error', () => resolve());
      // Timeout after 3 seconds
      setTimeout(() => resolve(), 3000);
    });

    // Small delay to ensure cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Now start using codev af dash start (avoids npx caching issues)
    // Capture output to detect errors
    const child = spawn('codev', ['af', 'dash', 'start'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: projectPath,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Wait a moment for the process to start (or fail)
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check if the dashboard port is listening
    // Resolve symlinks (macOS /tmp -> /private/tmp)
    const resolvedPath = fs.realpathSync(projectPath);
    const db = getGlobalDb();
    const allocation = db
      .prepare('SELECT base_port FROM port_allocations WHERE project_path = ? OR project_path = ?')
      .get(projectPath, resolvedPath) as { base_port: number } | undefined;

    if (allocation) {
      const dashboardPort = allocation.base_port;
      const isRunning = await isPortListening(dashboardPort);

      if (!isRunning) {
        // Process failed to start - try to get error info
        const errorInfo = stderr || stdout || 'Unknown error - check codev installation';
        child.unref();
        return {
          success: false,
          error: `Failed to start: ${errorInfo.trim().split('\n')[0]}`,
        };
      }
    } else {
      // No allocation found - process might have failed before registering
      if (stderr || stdout) {
        const errorInfo = stderr || stdout;
        child.unref();
        return {
          success: false,
          error: `Failed to start: ${errorInfo.trim().split('\n')[0]}`,
        };
      }
    }

    child.unref();
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
 * Stop an agent-farm instance by killing processes on its ports
 */
async function stopInstance(basePort: number): Promise<{ success: boolean; error?: string; stopped: number[] }> {
  const stopped: number[] = [];

  // Kill processes on the main port range (dashboard, architect, builders)
  // Dashboard is basePort, architect is basePort+1, builders start at basePort+100
  const portsToCheck = [basePort, basePort + 1];

  for (const p of portsToCheck) {
    const pid = getProcessOnPort(p);
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
        stopped.push(p);
      } catch {
        // Process may have already exited
      }
    }
  }

  if (stopped.length === 0) {
    return { success: true, error: 'No processes found to stop', stopped };
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
    // API: Get status of all instances
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
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const body = await parseJsonBody(req);
      const basePort = body.basePort as number;

      if (!basePort) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing basePort' }));
        return;
      }

      const result = await stopInstance(basePort);
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

    // Reverse proxy: /project/:base64urlPath/:terminalType/* → localhost:calculatedPort/*
    // Uses Base64URL (RFC 4648) encoding to avoid issues with slashes in paths
    //
    // Terminal port routing:
    //   /project/<path>/              → base_port (project dashboard)
    //   /project/<path>/architect/    → base_port + 1 (architect terminal)
    //   /project/<path>/builder/<n>/  → base_port + 2 + n (builder terminals)
    if (url.pathname.startsWith('/project/')) {
      const pathParts = url.pathname.split('/');
      // ['', 'project', base64urlPath, terminalType, ...rest]
      const encodedPath = pathParts[2];
      const terminalType = pathParts[3];
      const rest = pathParts.slice(4);

      if (!encodedPath) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing project path');
        return;
      }

      // Decode Base64URL (RFC 4648) - NOT URL encoding
      // Wrap in try/catch to handle malformed Base64 input gracefully
      let projectPath: string;
      try {
        projectPath = Buffer.from(encodedPath, 'base64url').toString('utf-8');
        // Validate decoded path is reasonable (non-empty, looks like absolute path)
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

      if (!basePort) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Project not found or not running');
        return;
      }

      // Calculate target port based on terminal type
      let targetPort = basePort; // Default: project dashboard
      let proxyPath = rest.join('/');

      if (terminalType === 'architect') {
        targetPort = basePort + 1; // Architect terminal
      } else if (terminalType === 'builder' && rest[0]) {
        const builderNum = parseInt(rest[0], 10);
        if (!isNaN(builderNum)) {
          targetPort = basePort + 2 + builderNum; // Builder terminal
          proxyPath = rest.slice(1).join('/'); // Remove builder number from path
        }
      } else if (terminalType) {
        proxyPath = [terminalType, ...rest].join('/'); // Pass through other paths
      }

      // Proxy the request
      const proxyReq = http.request(
        {
          hostname: '127.0.0.1',
          port: targetPort,
          path: '/' + proxyPath + (url.search || ''),
          method: req.method,
          headers: {
            ...req.headers,
            host: `localhost:${targetPort}`,
          },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );

      proxyReq.on('error', (err) => {
        log('ERROR', `Proxy error: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Proxy error: ' + err.message);
      });

      req.pipe(proxyReq);
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

// WebSocket upgrade handler for proxying terminal connections
// Same terminal port routing as HTTP proxy
server.on('upgrade', async (req, socket, head) => {
  const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);

  if (!reqUrl.pathname.startsWith('/project/')) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const pathParts = reqUrl.pathname.split('/');
  // ['', 'project', base64urlPath, terminalType, ...rest]
  const encodedPath = pathParts[2];
  const terminalType = pathParts[3];
  const rest = pathParts.slice(4);

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

  const basePort = await getBasePortForProject(projectPath);

  if (!basePort) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // Calculate target port based on terminal type (same logic as HTTP proxy)
  let targetPort = basePort; // Default: project dashboard
  let proxyPath = rest.join('/');

  if (terminalType === 'architect') {
    targetPort = basePort + 1; // Architect terminal
  } else if (terminalType === 'builder' && rest[0]) {
    const builderNum = parseInt(rest[0], 10);
    if (!isNaN(builderNum)) {
      targetPort = basePort + 2 + builderNum; // Builder terminal
      proxyPath = rest.slice(1).join('/'); // Remove builder number from path
    }
  } else if (terminalType) {
    proxyPath = [terminalType, ...rest].join('/'); // Pass through other paths
  }

  // Connect to target
  const proxySocket = net.connect(targetPort, '127.0.0.1', () => {
    // Rewrite Origin header for WebSocket compatibility
    const headers = { ...req.headers };
    headers.origin = 'http://localhost';
    headers.host = `localhost:${targetPort}`;

    // Forward the upgrade request
    let headerStr = `${req.method} /${proxyPath}${reqUrl.search || ''} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(headers)) {
      if (value) {
        if (Array.isArray(value)) {
          for (const v of value) {
            headerStr += `${key}: ${v}\r\n`;
          }
        } else {
          headerStr += `${key}: ${value}\r\n`;
        }
      }
    }
    headerStr += '\r\n';

    proxySocket.write(headerStr);
    if (head.length > 0) proxySocket.write(head);

    // Pipe bidirectionally
    socket.pipe(proxySocket);
    proxySocket.pipe(socket);
  });

  proxySocket.on('error', (err) => {
    log('ERROR', `WebSocket proxy error: ${err.message}`);
    socket.destroy();
  });

  socket.on('error', () => {
    proxySocket.destroy();
  });
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${reason}`);
});
