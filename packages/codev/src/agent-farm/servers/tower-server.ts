#!/usr/bin/env node

/**
 * Tower server for Agent Farm.
 * Provides a centralized view of all agent-farm instances across projects.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { getGlobalDb } from '../db/index.js';
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
  .parse(process.argv);

const opts = program.opts();
const args = program.args;
const portArg = opts.port || args[0] || String(DEFAULT_PORT);
const port = parseInt(portArg, 10);

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`Error: Invalid port "${portArg}". Must be a number between 1 and 65535.`);
  process.exit(1);
}

// Interface for port registry entries (from SQLite)
interface PortAllocation {
  project_path: string;
  base_port: number;
  pid: number | null;
  registered_at: string;
  last_used_at: string;
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
}

/**
 * Load port allocations from SQLite database
 */
function loadPortAllocations(): PortAllocation[] {
  try {
    const db = getGlobalDb();
    return db.prepare('SELECT * FROM port_allocations ORDER BY last_used_at DESC').all() as PortAllocation[];
  } catch (err) {
    console.error('Error loading port allocations:', (err as Error).message);
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
      console.log(`Auto-adopted codev in: ${projectPath}`);
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
    const stopChild = spawn('codev', ['af', 'stop'], {
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

    // Now start using codev af (avoids npx caching issues)
    // Capture output to detect errors
    const child = spawn('codev', ['af', 'start'], {
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

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('Request error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error: ' + (err as Error).message);
  }
});

// SECURITY: Bind to localhost only to prevent network exposure
server.listen(port, '127.0.0.1', () => {
  console.log(`Tower: http://localhost:${port}`);
});
