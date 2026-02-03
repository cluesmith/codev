#!/usr/bin/env node

/**
 * Dashboard server for Agent Farm.
 * Serves the split-pane dashboard UI and provides state/tab management APIs.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import httpProxy from 'http-proxy';
import { spawn, execSync, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execAsync = promisify(exec);
import { Command } from 'commander';
import type { DashboardState, Annotation, UtilTerminal, Builder } from '../types.js';
import { getPortForTerminal } from '../utils/terminal-ports.js';
import {
  escapeHtml,
  parseJsonBody,
  isRequestAllowed as isRequestAllowedBase,
} from '../utils/server-utils.js';
import {
  loadState,
  getAnnotations,
  addAnnotation,
  removeAnnotation,
  getUtils,
  addUtil,
  tryAddUtil,
  removeUtil,
  updateUtil,
  getBuilder,
  getBuilders,
  removeBuilder,
  upsertBuilder,
  clearState,
  getArchitect,
  setArchitect,
} from '../state.js';
import { TerminalManager } from '../../terminal/pty-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Default dashboard port
const DEFAULT_DASHBOARD_PORT = 4200;

// Parse arguments with Commander for proper --help and validation
const program = new Command()
  .name('dashboard-server')
  .description('Dashboard server for Agent Farm')
  .argument('[port]', 'Port to listen on', String(DEFAULT_DASHBOARD_PORT))
  .argument('[bindHost]', 'Host to bind to (default: localhost, use 0.0.0.0 for remote)')
  .option('-p, --port <port>', 'Port to listen on (overrides positional argument)')
  .option('-b, --bind <host>', 'Host to bind to (overrides positional argument)')
  .parse(process.argv);

const opts = program.opts();
const args = program.args;

// Support both positional arg and --port flag (flag takes precedence)
const portArg = opts.port || args[0] || String(DEFAULT_DASHBOARD_PORT);
const port = parseInt(portArg, 10);

// Bind host: flag > positional arg > default (undefined = localhost)
const bindHost = opts.bind || args[1] || undefined;

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`Error: Invalid port "${portArg}". Must be a number between 1 and 65535.`);
  process.exit(1);
}

// Configuration - ports are relative to the dashboard port
// This ensures multi-project support (e.g., dashboard on 4300 uses 4350 for annotations)
const CONFIG = {
  dashboardPort: port,
  architectPort: port + 1,
  builderPortStart: port + 10,
  utilPortStart: port + 30,
  openPortStart: port + 50,
  maxTabs: 20, // DoS protection: max concurrent tabs
};

// Find project root by looking for .agent-farm directory
function findProjectRoot(): string {
  let dir = process.cwd();
  while (dir !== '/') {
    if (fs.existsSync(path.join(dir, '.agent-farm'))) {
      return dir;
    }
    if (fs.existsSync(path.join(dir, 'codev'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// Get project name from root path, with truncation for long names
function getProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  const maxLength = 30;

  if (baseName.length <= maxLength) {
    return baseName;
  }

  // Truncate with ellipsis for very long names
  return '...' + baseName.slice(-(maxLength - 3));
}

// escapeHtml imported from ../utils/server-utils.js

/**
 * Find a template in the agent-farm templates directory
 * Template is bundled with agent-farm package in templates/ directory
 * @param filename - Template filename to find
 * @param required - If true, throws error when not found; if false, returns null
 */
function findTemplatePath(filename: string, required: true): string;
function findTemplatePath(filename: string, required?: false): string | null;
function findTemplatePath(filename: string, required = false): string | null {
  // Templates are at package root: packages/codev/templates/
  // From compiled: dist/agent-farm/servers/ -> ../../../templates/
  // From source: src/agent-farm/servers/ -> ../../../templates/
  const pkgPath = path.resolve(__dirname, '../../../templates/', filename);
  if (fs.existsSync(pkgPath)) return pkgPath;

  if (required) {
    throw new Error(`Template not found: ${filename}`);
  }
  return null;
}

const projectRoot = findProjectRoot();
// Use modular dashboard template (Spec 0060)
const templatePath = findTemplatePath('dashboard/index.html', true);

// Terminal backend is always node-pty (Spec 0085)
const terminalBackend = 'node-pty' as const;

// Load dashboard frontend preference from config (Spec 0085)
function loadDashboardFrontend(): 'react' | 'legacy' {
  const configPath = path.resolve(projectRoot, 'af-config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config?.dashboard?.frontend ?? 'react';
    } catch { /* ignore */ }
  }
  return 'react';
}

const dashboardFrontend = loadDashboardFrontend();

// React dashboard dist path (built by Vite)
const reactDashboardPath = path.resolve(__dirname, '../../../dashboard/dist');
const useReactDashboard = dashboardFrontend === 'react' && fs.existsSync(reactDashboardPath);
if (useReactDashboard) {
  console.log('Dashboard frontend: React');
} else if (dashboardFrontend === 'react') {
  console.log('Dashboard frontend: React (dist not found, falling back to legacy)');
} else {
  console.log('Dashboard frontend: legacy');
}
const terminalManager = new TerminalManager({ projectRoot });
console.log('Terminal backend: node-pty');

// Clear stale terminalIds on startup — TerminalManager starts empty, so any
// persisted terminalId from a previous run is no longer valid.
{
  const arch = getArchitect();
  if (arch?.terminalId) {
    setArchitect({ ...arch, terminalId: undefined });
  }
  for (const builder of getBuilders()) {
    if (builder.terminalId) {
      upsertBuilder({ ...builder, terminalId: undefined });
    }
  }
  for (const util of getUtils()) {
    if (util.terminalId) {
      updateUtil(util.id, { terminalId: undefined });
    }
  }
}

// Auto-create architect PTY session if architect exists with a tmux session
async function initArchitectTerminal(): Promise<void> {
  const architect = getArchitect();
  if (!architect || !architect.tmuxSession || architect.terminalId) return;

  try {
    // Verify the tmux session actually exists before trying to attach.
    // If it doesn't exist, tmux attach exits immediately, leaving a dead terminalId.
    const { spawnSync } = await import('node:child_process');
    const probe = spawnSync('tmux', ['has-session', '-t', architect.tmuxSession], { stdio: 'ignore' });
    if (probe.status !== 0) {
      console.log(`initArchitectTerminal: tmux session '${architect.tmuxSession}' does not exist yet`);
      return;
    }

    // Use tmux directly (not via bash -c) to avoid DA response chaff.
    // bash -c creates a brief window where readline echoes DA responses as text.
    const info = await terminalManager!.createSession({
      command: 'tmux',
      args: ['attach-session', '-t', architect.tmuxSession],
      cwd: projectRoot,
      cols: 200,
      rows: 50,
      label: 'architect',
    });

    // Wait to detect immediate exit (e.g., tmux session disappeared between check and attach)
    await new Promise((resolve) => setTimeout(resolve, 500));
    const session = terminalManager!.getSession(info.id);
    if (!session || session.info.exitCode !== undefined) {
      console.error(`initArchitectTerminal: PTY exited immediately (exit=${session?.info.exitCode})`);
      terminalManager!.killSession(info.id);
      return;
    }

    setArchitect({ ...architect, terminalId: info.id });
    console.log(`Architect terminal session created: ${info.id}`);

    // Listen for exit and auto-restart
    session.on('exit', (exitCode) => {
      console.log(`Architect terminal exited (code=${exitCode}), will attempt restart...`);
      // Clear the terminalId so we can recreate
      const arch = getArchitect();
      if (arch) {
        setArchitect({ ...arch, terminalId: undefined });
      }
      // Schedule restart after a brief delay
      setTimeout(() => {
        console.log('Attempting to restart architect terminal...');
        initArchitectTerminal().catch((err) => {
          console.error('Failed to restart architect terminal:', (err as Error).message);
        });
      }, 2000);
    });
  } catch (err) {
    console.error('Failed to create architect terminal session:', (err as Error).message);
  }
}
// Poll for architect state and create PTY session once available
// start.ts writes architect to DB before spawning this server, but there can be a small delay
(async function waitForArchitectAndInit() {
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const arch = getArchitect();
      if (!arch) continue;
      if (arch.terminalId) return; // Already has terminal
      if (!arch.tmuxSession) continue; // No tmux session yet
      console.log(`initArchitectTerminal: attempt ${attempt + 1}, tmux=${arch.tmuxSession}`);
      await initArchitectTerminal();
      const updated = getArchitect();
      if (updated?.terminalId) {
        console.log(`initArchitectTerminal: success, terminalId=${updated.terminalId}`);
        return;
      }
      console.log(`initArchitectTerminal: attempt ${attempt + 1} failed, terminalId still unset`);
    } catch (err) {
      console.error(`initArchitectTerminal: attempt ${attempt + 1} error:`, (err as Error).message);
    }
  }
  console.warn('initArchitectTerminal: gave up after 30 attempts');
})();
// Log telemetry
try {
  const metricsPath = path.join(projectRoot, '.agent-farm', 'metrics.log');
  fs.mkdirSync(path.dirname(metricsPath), { recursive: true });
  fs.appendFileSync(metricsPath, JSON.stringify({
    event: 'backend_selected',
    backend: 'node-pty',
    timestamp: new Date().toISOString(),
  }) + '\n');
} catch { /* ignore */ }

// Clean up dead processes from state (called on state load)
function cleanupDeadProcesses(): void {
  // Clean up dead shell processes
  for (const util of getUtils()) {
    if (!isProcessRunning(util.pid)) {
      console.log(`Auto-closing shell tab ${util.name} (process ${util.pid} exited)`);
      if (util.tmuxSession) {
        killTmuxSession(util.tmuxSession);
      }
      removeUtil(util.id);
    }
  }

  // Clean up dead annotation processes
  for (const annotation of getAnnotations()) {
    if (!isProcessRunning(annotation.pid)) {
      console.log(`Auto-closing file tab ${annotation.file} (process ${annotation.pid} exited)`);
      removeAnnotation(annotation.id);
    }
  }
}

// Load state with cleanup
function loadStateWithCleanup(): DashboardState {
  cleanupDeadProcesses();
  return loadState();
}

// Generate unique ID using crypto for collision resistance
function generateId(prefix: string): string {
  const uuid = randomUUID().replace(/-/g, '').substring(0, 8).toUpperCase();
  return `${prefix}${uuid}`;
}

// Get all ports currently used in state
function getUsedPorts(state: DashboardState): Set<number> {
  const ports = new Set<number>();
  if (state.architect?.port) ports.add(state.architect.port);
  for (const builder of state.builders || []) {
    if (builder.port) ports.add(builder.port);
  }
  for (const util of state.utils || []) {
    if (util.port) ports.add(util.port);
  }
  for (const annotation of state.annotations || []) {
    if (annotation.port) ports.add(annotation.port);
  }
  return ports;
}

// Find available port in range (checks both state and actual availability)
async function findAvailablePort(startPort: number, state?: DashboardState): Promise<number> {
  // Get ports already allocated in state
  const usedPorts = state ? getUsedPorts(state) : new Set<number>();

  // Skip ports already in state
  let port = startPort;
  while (usedPorts.has(port)) {
    port++;
  }

  // Then verify the port is actually available for binding
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      const { port: boundPort } = server.address() as { port: number };
      server.close(() => resolve(boundPort));
    });
    server.on('error', () => {
      resolve(findAvailablePort(port + 1, state));
    });
  });
}

// Wait for a port to be accepting connections (server ready)
async function waitForPortReady(port: number, timeoutMs: number = 5000): Promise<boolean> {
  const startTime = Date.now();
  const pollInterval = 100; // Check every 100ms

  while (Date.now() - startTime < timeoutMs) {
    const isReady = await new Promise<boolean>((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(pollInterval);

      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.on('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, '127.0.0.1');
    });

    if (isReady) {
      return true;
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return false;
}

// Kill tmux session
function killTmuxSession(sessionName: string): void {
  try {
    execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { stdio: 'ignore' });
  } catch {
    // Session may not exist
  }
}

// Check if a process is running
function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 doesn't kill, just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Graceful process termination with two-phase shutdown
async function killProcessGracefully(pid: number, tmuxSession?: string): Promise<void> {
  // First kill tmux session if provided
  if (tmuxSession) {
    killTmuxSession(tmuxSession);
  }

  // Guard: PID 0 sends signal to entire process group — never do that
  if (!pid || pid <= 0) return;

  try {
    // First try SIGTERM
    process.kill(pid, 'SIGTERM');

    // Wait up to 500ms for process to exit
    await new Promise<void>((resolve) => {
      let attempts = 0;
      const checkInterval = setInterval(() => {
        attempts++;
        try {
          // Signal 0 checks if process exists
          process.kill(pid, 0);
          if (attempts >= 5) {
            // Process still alive after 500ms, use SIGKILL
            clearInterval(checkInterval);
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already dead
            }
            resolve();
          }
        } catch {
          // Process is dead
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  } catch {
    // Process may already be dead
  }
}

// Spawn detached process with error handling
function spawnDetached(command: string, args: string[], cwd: string): number | null {
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
    });

    child.on('error', (err) => {
      console.error(`Failed to spawn ${command}:`, err.message);
    });

    child.unref();
    return child.pid || null;
  } catch (err) {
    console.error(`Failed to spawn ${command}:`, (err as Error).message);
    return null;
  }
}

// Check if tmux session exists
function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Create a PTY terminal session via the TerminalManager.
// Returns the terminal session ID, or null on failure.
async function createTerminalSession(
  shellCommand: string,
  cwd: string,
  label?: string,
): Promise<string | null> {
  if (!terminalManager) return null;
  try {
    const info = await terminalManager.createSession({
      command: '/bin/bash',
      args: ['-c', shellCommand],
      cwd,
      cols: 200,
      rows: 50,
      label,
    });
    return info.id;
  } catch (err) {
    console.error(`Failed to create terminal session:`, (err as Error).message);
    return null;
  }
}

/**
 * Generate a short 4-character base64-encoded ID for worktree names
 */
function generateShortId(): string {
  const num = Math.floor(Math.random() * 0xFFFFFF);
  const bytes = new Uint8Array([num >> 16, (num >> 8) & 0xFF, num & 0xFF]);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 4);
}

/**
 * Spawn a worktree builder - creates git worktree and starts builder CLI
 * Similar to shell spawning but with git worktree isolation
 */
async function spawnWorktreeBuilder(
  builderPort: number,
  state: DashboardState
): Promise<{ builder: Builder; pid: number } | null> {
  const shortId = generateShortId();
  const builderId = `worktree-${shortId}`;
  const branchName = `builder/worktree-${shortId}`;
  const worktreePath = path.resolve(projectRoot, '.builders', builderId);
  const sessionName = `builder-${builderId}`;

  try {
    // Ensure .builders directory exists
    const buildersDir = path.resolve(projectRoot, '.builders');
    if (!fs.existsSync(buildersDir)) {
      fs.mkdirSync(buildersDir, { recursive: true });
    }

    // Create git branch and worktree
    execSync(`git branch "${branchName}" HEAD`, { cwd: projectRoot, stdio: 'ignore' });
    execSync(`git worktree add "${worktreePath}" "${branchName}"`, { cwd: projectRoot, stdio: 'ignore' });

    // Get builder command from af-config.json or use default shell
    const afConfigPath = path.resolve(projectRoot, 'af-config.json');
    const defaultShell = process.env.SHELL || 'bash';
    let builderCommand = defaultShell;
    if (fs.existsSync(afConfigPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(afConfigPath, 'utf-8'));
        builderCommand = config?.shell?.builder || defaultShell;
      } catch {
        // Use default
      }
    }

    // Create PTY terminal session via node-pty
    const terminalId = await createTerminalSession(builderCommand, worktreePath, `builder-${builderId}`);
    if (!terminalId) {
      // Cleanup on failure
      try {
        execSync(`git worktree remove "${worktreePath}" --force`, { cwd: projectRoot, stdio: 'ignore' });
        execSync(`git branch -D "${branchName}"`, { cwd: projectRoot, stdio: 'ignore' });
      } catch {
        // Best effort cleanup
      }
      return null;
    }

    const builder: Builder = {
      id: builderId,
      name: `Worktree ${shortId}`,
      port: 0,
      pid: 0,
      status: 'implementing',
      phase: 'interactive',
      worktree: worktreePath,
      branch: branchName,
      tmuxSession: sessionName,
      type: 'worktree',
      terminalId,
    };

    return { builder, pid: 0 };
  } catch (err) {
    console.error(`Failed to spawn worktree builder:`, (err as Error).message);
    // Cleanup any partial state
    killTmuxSession(sessionName);
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { cwd: projectRoot, stdio: 'ignore' });
      execSync(`git branch -D "${branchName}"`, { cwd: projectRoot, stdio: 'ignore' });
    } catch {
      // Best effort cleanup
    }
    return null;
  }
}

// parseJsonBody imported from ../utils/server-utils.js

// Validate path is within project root (prevent path traversal)
// Handles URL-encoded dots (%2e), symlinks, and other encodings
function validatePathWithinProject(filePath: string): string | null {
  // First decode any URL encoding to catch %2e%2e (encoded ..)
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(filePath);
  } catch {
    // Invalid encoding
    return null;
  }

  // Resolve to absolute path
  const resolvedPath = decodedPath.startsWith('/')
    ? path.resolve(decodedPath)
    : path.resolve(projectRoot, decodedPath);

  // Normalize to remove any .. or . segments
  const normalizedPath = path.normalize(resolvedPath);

  // First check normalized path (for paths that don't exist yet)
  if (!normalizedPath.startsWith(projectRoot + path.sep) && normalizedPath !== projectRoot) {
    return null; // Path escapes project root
  }

  // If file exists, resolve symlinks to prevent symlink-based path traversal
  // An attacker could create a symlink within the repo pointing outside
  if (fs.existsSync(normalizedPath)) {
    try {
      const realPath = fs.realpathSync(normalizedPath);
      if (!realPath.startsWith(projectRoot + path.sep) && realPath !== projectRoot) {
        return null; // Symlink target escapes project root
      }
      return realPath;
    } catch {
      // realpathSync failed (broken symlink, permissions, etc.)
      return null;
    }
  }

  return normalizedPath;
}

// Count total tabs for DoS protection
function countTotalTabs(state: DashboardState): number {
  return state.builders.length + state.utils.length + state.annotations.length;
}

// Find open server script (prefer .ts for dev, .js for compiled)
function getOpenServerPath(): { script: string; useTsx: boolean } {
  const tsPath = path.join(__dirname, 'open-server.ts');
  const jsPath = path.join(__dirname, 'open-server.js');

  if (fs.existsSync(tsPath)) {
    return { script: tsPath, useTsx: true };
  }
  return { script: jsPath, useTsx: false };
}

// ============================================================
// Activity Summary (Spec 0059)
// ============================================================

interface Commit {
  hash: string;
  message: string;
  time: string;
  branch: string;
}

interface PullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
}

interface BuilderActivity {
  id: string;
  status: string;
  startTime: string;
  endTime?: string;
}

interface ProjectChange {
  id: string;
  title: string;
  oldStatus: string;
  newStatus: string;
}

interface TimeTracking {
  activeMinutes: number;
  firstActivity: string;
  lastActivity: string;
}

interface ActivitySummary {
  commits: Commit[];
  prs: PullRequest[];
  builders: BuilderActivity[];
  projectChanges: ProjectChange[];
  files: string[];
  timeTracking: TimeTracking;
  aiSummary?: string;
  error?: string;
}

interface TimeInterval {
  start: Date;
  end: Date;
}

/**
 * Escape a string for safe use in shell commands
 * Handles special characters that could cause command injection
 */
function escapeShellArg(str: string): string {
  // Single-quote the string and escape any single quotes within it
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

/**
 * Get today's git commits from all branches for the current user
 */
async function getGitCommits(projectRoot: string): Promise<Commit[]> {
  try {
    const { stdout: authorRaw } = await execAsync('git config user.name', { cwd: projectRoot });
    const author = authorRaw.trim();
    if (!author) return [];

    // Escape author name to prevent command injection
    const safeAuthor = escapeShellArg(author);

    // Get commits from all branches since midnight
    const { stdout: output } = await execAsync(
      `git log --all --since="midnight" --author=${safeAuthor} --format="%H|%s|%aI|%D"`,
      { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 }
    );

    if (!output.trim()) return [];

    return output.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('|');
      const hash = parts[0] || '';
      const message = parts[1] || '';
      const time = parts[2] || '';
      const refs = parts.slice(3).join('|'); // refs might contain |

      // Extract branch name from refs
      let branch = 'unknown';
      const headMatch = refs.match(/HEAD -> ([^,]+)/);
      const branchMatch = refs.match(/([^,\s]+)$/);
      if (headMatch) {
        branch = headMatch[1];
      } else if (branchMatch && branchMatch[1]) {
        branch = branchMatch[1];
      }

      return {
        hash: hash.slice(0, 7),
        message: message.slice(0, 100), // Truncate long messages
        time,
        branch,
      };
    });
  } catch (err) {
    console.error('Error getting git commits:', (err as Error).message);
    return [];
  }
}

/**
 * Get unique files modified today
 */
async function getModifiedFiles(projectRoot: string): Promise<string[]> {
  try {
    const { stdout: authorRaw } = await execAsync('git config user.name', { cwd: projectRoot });
    const author = authorRaw.trim();
    if (!author) return [];

    // Escape author name to prevent command injection
    const safeAuthor = escapeShellArg(author);

    const { stdout: output } = await execAsync(
      `git log --all --since="midnight" --author=${safeAuthor} --name-only --format=""`,
      { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 }
    );

    if (!output.trim()) return [];

    const files = [...new Set(output.trim().split('\n').filter(Boolean))];
    return files.sort();
  } catch (err) {
    console.error('Error getting modified files:', (err as Error).message);
    return [];
  }
}

/**
 * Get GitHub PRs created or merged today via gh CLI
 * Combines PRs created today AND PRs merged today (which may have been created earlier)
 */
async function getGitHubPRs(projectRoot: string): Promise<PullRequest[]> {
  try {
    // Use local time for the date (spec says "today" means local machine time)
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // Fetch PRs created today AND PRs merged today in parallel
    const [createdResult, mergedResult] = await Promise.allSettled([
      execAsync(
        `gh pr list --author "@me" --state all --search "created:>=${today}" --json number,title,state,url`,
        { cwd: projectRoot, timeout: 15000 }
      ),
      execAsync(
        `gh pr list --author "@me" --state merged --search "merged:>=${today}" --json number,title,state,url`,
        { cwd: projectRoot, timeout: 15000 }
      ),
    ]);

    const prsMap = new Map<number, PullRequest>();

    // Process PRs created today
    if (createdResult.status === 'fulfilled' && createdResult.value.stdout.trim()) {
      const prs = JSON.parse(createdResult.value.stdout) as Array<{ number: number; title: string; state: string; url: string }>;
      for (const pr of prs) {
        prsMap.set(pr.number, {
          number: pr.number,
          title: pr.title.slice(0, 100),
          state: pr.state,
          url: pr.url,
        });
      }
    }

    // Process PRs merged today (may overlap with created, deduped by Map)
    if (mergedResult.status === 'fulfilled' && mergedResult.value.stdout.trim()) {
      const prs = JSON.parse(mergedResult.value.stdout) as Array<{ number: number; title: string; state: string; url: string }>;
      for (const pr of prs) {
        prsMap.set(pr.number, {
          number: pr.number,
          title: pr.title.slice(0, 100),
          state: pr.state,
          url: pr.url,
        });
      }
    }

    return Array.from(prsMap.values());
  } catch (err) {
    // gh CLI might not be available or authenticated
    console.error('Error getting GitHub PRs:', (err as Error).message);
    return [];
  }
}

/**
 * Get builder activity from state.db for today
 * Note: state.json doesn't track timestamps, so we can only report current builders
 * without duration. They'll be counted as activity points, not time intervals.
 */
function getBuilderActivity(): BuilderActivity[] {
  try {
    const builders = getBuilders();

    // Return current builders without time tracking (state.json lacks timestamps)
    // Time tracking will rely primarily on git commits
    return builders.map(b => ({
      id: b.id,
      status: b.status || 'unknown',
      startTime: '', // Unknown - not tracked in state.json
      endTime: undefined,
    }));
  } catch (err) {
    console.error('Error getting builder activity:', (err as Error).message);
    return [];
  }
}

/**
 * Detect project status changes in projectlist.md today
 * Handles YAML format inside Markdown fenced code blocks
 */
async function getProjectChanges(projectRoot: string): Promise<ProjectChange[]> {
  try {
    const projectlistPath = path.join(projectRoot, 'codev/projectlist.md');
    if (!fs.existsSync(projectlistPath)) return [];

    // Get the first commit hash from today that touched projectlist.md
    const { stdout: firstCommitOutput } = await execAsync(
      `git log --since="midnight" --format=%H -- codev/projectlist.md | tail -1`,
      { cwd: projectRoot }
    );

    if (!firstCommitOutput.trim()) return [];

    // Get diff of projectlist.md from that commit's parent to HEAD
    let diff: string;
    try {
      const { stdout } = await execAsync(
        `git diff ${firstCommitOutput.trim()}^..HEAD -- codev/projectlist.md`,
        { cwd: projectRoot, maxBuffer: 1024 * 1024 }
      );
      diff = stdout;
    } catch {
      return [];
    }

    if (!diff.trim()) return [];

    // Parse status changes from diff
    // Format is YAML inside Markdown code blocks:
    //   - id: "0058"
    //     title: "File Search Autocomplete"
    //     status: implementing
    const changes: ProjectChange[] = [];
    const lines = diff.split('\n');
    let currentId = '';
    let currentTitle = '';
    let oldStatus = '';
    let newStatus = '';

    for (const line of lines) {
      // Track current project context from YAML id field
      // Match lines like: "  - id: \"0058\"" or "+  - id: \"0058\""
      const idMatch = line.match(/^[+-]?\s*-\s*id:\s*["']?(\d{4})["']?/);
      if (idMatch) {
        // If we have a pending status change from previous project, emit it
        if (oldStatus && newStatus && currentId) {
          changes.push({
            id: currentId,
            title: currentTitle,
            oldStatus,
            newStatus,
          });
          oldStatus = '';
          newStatus = '';
        }
        currentId = idMatch[1];
        currentTitle = ''; // Will be filled by title line
      }

      // Track title (comes after id in YAML)
      // Match lines like: "    title: \"File Search Autocomplete\""
      const titleMatch = line.match(/^[+-]?\s*title:\s*["']?([^"']+)["']?/);
      if (titleMatch && currentId) {
        currentTitle = titleMatch[1].trim();
      }

      // Track status changes
      // Match lines like: "-    status: implementing" or "+    status: implemented"
      const statusMatch = line.match(/^([+-])\s*status:\s*(\w+)/);
      if (statusMatch) {
        const [, modifier, status] = statusMatch;
        if (modifier === '-') {
          oldStatus = status;
        } else if (modifier === '+') {
          newStatus = status;
        }
      }
    }

    // Emit final pending change if exists
    if (oldStatus && newStatus && currentId) {
      changes.push({
        id: currentId,
        title: currentTitle,
        oldStatus,
        newStatus,
      });
    }

    return changes;
  } catch (err) {
    console.error('Error getting project changes:', (err as Error).message);
    return [];
  }
}

/**
 * Merge overlapping time intervals
 */
function mergeIntervals(intervals: TimeInterval[]): TimeInterval[] {
  if (intervals.length === 0) return [];

  // Sort by start time
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: TimeInterval[] = [{ ...sorted[0] }];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];

    // If overlapping or within 2 hours, merge
    const gapMs = current.start.getTime() - last.end.getTime();
    const twoHoursMs = 2 * 60 * 60 * 1000;

    if (gapMs <= twoHoursMs) {
      last.end = new Date(Math.max(last.end.getTime(), current.end.getTime()));
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/**
 * Calculate active time from commits and builder activity
 */
function calculateTimeTracking(commits: Commit[], builders: BuilderActivity[]): TimeTracking {
  const intervals: TimeInterval[] = [];
  const fiveMinutesMs = 5 * 60 * 1000;

  // Add commit timestamps (treat each as 5-minute interval)
  for (const commit of commits) {
    if (commit.time) {
      const time = new Date(commit.time);
      if (!isNaN(time.getTime())) {
        intervals.push({
          start: time,
          end: new Date(time.getTime() + fiveMinutesMs),
        });
      }
    }
  }

  // Add builder sessions
  for (const builder of builders) {
    if (builder.startTime) {
      const start = new Date(builder.startTime);
      const end = builder.endTime ? new Date(builder.endTime) : new Date();
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        intervals.push({ start, end });
      }
    }
  }

  if (intervals.length === 0) {
    return {
      activeMinutes: 0,
      firstActivity: '',
      lastActivity: '',
    };
  }

  const merged = mergeIntervals(intervals);
  const totalMinutes = merged.reduce((sum, interval) =>
    sum + (interval.end.getTime() - interval.start.getTime()) / (1000 * 60), 0
  );

  return {
    activeMinutes: Math.round(totalMinutes),
    firstActivity: merged[0].start.toISOString(),
    lastActivity: merged[merged.length - 1].end.toISOString(),
  };
}

/**
 * Find the consult CLI path
 * Returns the path to the consult binary, checking multiple locations
 */
function findConsultPath(): string {
  // When running from dist/, check relative paths
  // dist/agent-farm/servers/ -> ../../../bin/consult.js
  const distPath = path.join(__dirname, '../../../bin/consult.js');
  if (fs.existsSync(distPath)) {
    return distPath;
  }

  // When running from src/ with tsx, check src-relative paths
  // src/agent-farm/servers/ -> ../../../bin/consult.js (won't exist, it's .ts in src)
  // But bin/ is at packages/codev/bin/consult.js, so it should still work

  // Fall back to npx consult (works if @cluesmith/codev is installed)
  return 'npx consult';
}

/**
 * Generate AI summary via consult CLI
 */
async function generateAISummary(data: {
  commits: Commit[];
  prs: PullRequest[];
  files: string[];
  timeTracking: TimeTracking;
  projectChanges: ProjectChange[];
}): Promise<string> {
  // Build prompt with commit messages and file names only (security: no full diffs)
  const hours = Math.floor(data.timeTracking.activeMinutes / 60);
  const mins = data.timeTracking.activeMinutes % 60;

  const prompt = `Summarize this developer's activity today for a standup report.

Commits (${data.commits.length}):
${data.commits.slice(0, 20).map(c => `- ${c.message}`).join('\n') || '(none)'}
${data.commits.length > 20 ? `... and ${data.commits.length - 20} more` : ''}

PRs: ${data.prs.map(p => `#${p.number} ${p.title} (${p.state})`).join(', ') || 'None'}

Files modified: ${data.files.length} files
${data.files.slice(0, 10).join(', ')}${data.files.length > 10 ? ` ... and ${data.files.length - 10} more` : ''}

Project status changes:
${data.projectChanges.map(p => `- ${p.id} ${p.title}: ${p.oldStatus} → ${p.newStatus}`).join('\n') || '(none)'}

Active time: ~${hours}h ${mins}m

Write a brief, professional summary (2-3 sentences) focusing on accomplishments. Be concise and suitable for a standup or status report.`;

  try {
    // Use consult CLI to generate summary
    const consultCmd = findConsultPath();
    const safePrompt = escapeShellArg(prompt);

    // Use async exec with timeout
    const { stdout } = await execAsync(
      `${consultCmd} --model gemini general ${safePrompt}`,
      { timeout: 60000, maxBuffer: 1024 * 1024 }
    );

    return stdout.trim();
  } catch (err) {
    console.error('AI summary generation failed:', (err as Error).message);
    return '';
  }
}

/**
 * Collect all activity data for today
 */
async function collectActivitySummary(projectRoot: string): Promise<ActivitySummary> {
  // Collect data from all sources in parallel - these are now truly async
  const [commits, files, prs, builders, projectChanges] = await Promise.all([
    getGitCommits(projectRoot),
    getModifiedFiles(projectRoot),
    getGitHubPRs(projectRoot),
    Promise.resolve(getBuilderActivity()), // This one is sync (reads from state)
    getProjectChanges(projectRoot),
  ]);

  const timeTracking = calculateTimeTracking(commits, builders);

  // Generate AI summary (skip if no activity)
  let aiSummary = '';
  if (commits.length > 0 || prs.length > 0) {
    aiSummary = await generateAISummary({
      commits,
      prs,
      files,
      timeTracking,
      projectChanges,
    });
  }

  return {
    commits,
    prs,
    builders,
    projectChanges,
    files,
    timeTracking,
    aiSummary: aiSummary || undefined,
  };
}


// Insecure remote mode - set when bindHost is 0.0.0.0
const insecureRemoteMode = bindHost === '0.0.0.0';

// ============================================================
// Terminal Proxy (Spec 0062 - Secure Remote Access)
// ============================================================

// Create http-proxy instance for terminal proxying
const terminalProxy = httpProxy.createProxyServer({ ws: true });

// Handle proxy errors gracefully
terminalProxy.on('error', (err, req, res) => {
  console.error('Terminal proxy error:', err.message);
  if (res && 'writeHead' in res && !res.headersSent) {
    (res as http.ServerResponse).writeHead(502, { 'Content-Type': 'application/json' });
    (res as http.ServerResponse).end(JSON.stringify({ error: 'Terminal unavailable' }));
  }
});

// getPortForTerminal is imported from utils/terminal-ports.ts (Spec 0062)

// Security: Validate request origin (uses base from server-utils with insecureRemoteMode override)
function isRequestAllowed(req: http.IncomingMessage): boolean {
  // Skip all security checks in insecure remote mode
  if (insecureRemoteMode) {
    return true;
  }
  return isRequestAllowedBase(req);
}

/**
 * Timing-safe token comparison to prevent timing attacks
 */
function isValidToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;

  // Ensure both strings are same length for timing-safe comparison
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);

  if (providedBuf.length !== expectedBuf.length) {
    // Still do a comparison to maintain constant time
    timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }

  return timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Generate HTML for login page
 */
function getLoginPageHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Dashboard Login</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: system-ui; background: #1a1a2e; color: #eee;
           display: flex; justify-content: center; align-items: center;
           min-height: 100vh; margin: 0; }
    .login { background: #16213e; padding: 2rem; border-radius: 8px;
             max-width: 400px; width: 90%; }
    h1 { margin-top: 0; }
    input { width: 100%; padding: 0.75rem; margin: 0.5rem 0;
            border: 1px solid #444; border-radius: 4px;
            background: #0f0f23; color: #eee; font-size: 1rem;
            box-sizing: border-box; }
    button { width: 100%; padding: 0.75rem; margin-top: 1rem;
             background: #4a7c59; color: white; border: none;
             border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #5a9c69; }
    .error { color: #ff6b6b; margin-top: 0.5rem; display: none; }
  </style>
</head>
<body>
  <div class="login">
    <h1>Agent Farm Login</h1>
    <p>Enter your API key to access the dashboard.</p>
    <input type="password" id="key" placeholder="API Key" autofocus>
    <div class="error" id="error">Invalid API key</div>
    <button onclick="login()">Login</button>
  </div>
  <script>
    // Check for key in URL (from QR code scan) or localStorage
    (async function() {
      const urlParams = new URLSearchParams(window.location.search);
      const keyFromUrl = urlParams.get('key');
      const keyFromStorage = localStorage.getItem('codev_web_key');
      const key = keyFromUrl || keyFromStorage;

      if (key) {
        if (keyFromUrl) {
          localStorage.setItem('codev_web_key', keyFromUrl);
        }
        await verifyAndLoadDashboard(key);
      }
    })();

    async function verifyAndLoadDashboard(key) {
      try {
        // Fetch the actual dashboard with auth header
        const res = await fetch(window.location.pathname, {
          headers: {
            'Authorization': 'Bearer ' + key,
            'Accept': 'text/html'
          }
        });
        if (res.ok) {
          // Replace entire page with dashboard
          const html = await res.text();
          document.open();
          document.write(html);
          document.close();
          // Clean URL without reload
          history.replaceState({}, '', window.location.pathname);
        } else {
          // Key invalid
          localStorage.removeItem('codev_web_key');
          document.getElementById('error').style.display = 'block';
          document.getElementById('error').textContent = 'Invalid API key';
        }
      } catch (e) {
        document.getElementById('error').style.display = 'block';
        document.getElementById('error').textContent = 'Connection error';
      }
    }

    async function login() {
      const key = document.getElementById('key').value;
      if (!key) return;
      localStorage.setItem('codev_web_key', key);
      await verifyAndLoadDashboard(key);
    }
    document.getElementById('key').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') login();
    });
  </script>
</body>
</html>`;
}

// Create server
const server = http.createServer(async (req, res) => {
  // Security: Validate Host and Origin headers
  if (!isRequestAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CRITICAL: When CODEV_WEB_KEY is set, ALL requests require auth
  // NO localhost bypass - tunnel daemons (cloudflared) run locally and proxy
  // to localhost, so checking remoteAddress would incorrectly trust remote traffic
  const webKey = process.env.CODEV_WEB_KEY;

  if (webKey) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');

    if (!isValidToken(token, webKey)) {
      // Return login page for HTML requests, 401 for API
      if (req.headers.accept?.includes('text/html')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getLoginPageHtml());
        return;
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }
  // When CODEV_WEB_KEY is NOT set: no auth required (local dev mode only)

  // CORS headers
  const origin = req.headers.origin;
  if (insecureRemoteMode || webKey) {
    // Allow any origin in insecure remote mode or when using auth (tunnel access)
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else if (origin && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Prevent caching of API responses
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${port}`);

  try {
    // Spec 0085: node-pty terminal manager REST API routes
    if (terminalManager && url.pathname.startsWith('/api/terminals')) {
      if (terminalManager.handleRequest(req, res)) {
        return;
      }
    }

    // API: Get state
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const state = loadStateWithCleanup();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }

    // API: Create file tab (annotation)
    if (req.method === 'POST' && url.pathname === '/api/tabs/file') {
      const body = await parseJsonBody(req);
      const filePath = body.path as string;

      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing path');
        return;
      }

      // Validate path is within project root (prevent path traversal)
      const fullPath = validatePathWithinProject(filePath);
      if (!fullPath) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Path must be within project directory');
        return;
      }

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`File not found: ${filePath}`);
        return;
      }

      // Check if already open
      const annotations = getAnnotations();
      const existing = annotations.find((a) => a.file === fullPath);
      if (existing) {
        // Verify the process is still running
        if (isProcessRunning(existing.pid)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: existing.id, port: existing.port, existing: true }));
          return;
        }
        // Process is dead - clean up stale entry and spawn new one
        console.log(`Cleaning up stale annotation for ${fullPath} (pid ${existing.pid} dead)`);
        removeAnnotation(existing.id);
      }

      // DoS protection: check tab limit
      const state = loadState();
      if (countTotalTabs(state) >= CONFIG.maxTabs) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end(`Tab limit reached (max ${CONFIG.maxTabs}). Close some tabs first.`);
        return;
      }

      // Find available port (pass state to avoid already-allocated ports)
      const openPort = await findAvailablePort(CONFIG.openPortStart, state);

      // Start open server
      const { script: serverScript, useTsx } = getOpenServerPath();
      if (!fs.existsSync(serverScript)) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Open server not found');
        return;
      }

      // Use tsx for TypeScript files, node for compiled JavaScript
      const cmd = useTsx ? 'npx' : 'node';
      const args = useTsx
        ? ['tsx', serverScript, String(openPort), fullPath]
        : [serverScript, String(openPort), fullPath];
      const pid = spawnDetached(cmd, args, projectRoot);

      if (!pid) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to start open server');
        return;
      }

      // Wait for open server to be ready (accepting connections)
      const serverReady = await waitForPortReady(openPort, 5000);
      if (!serverReady) {
        // Server didn't start in time - kill it and report error
        try {
          process.kill(pid);
        } catch {
          // Process may have already died
        }
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Open server failed to start (timeout)');
        return;
      }

      // Create annotation record
      const annotation: Annotation = {
        id: generateId('A'),
        file: fullPath,
        port: openPort,
        pid,
        parent: { type: 'architect' },
      };

      addAnnotation(annotation);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: annotation.id, port: openPort }));
      return;
    }

    // API: Create builder tab (spawns worktree builder with random ID)
    if (req.method === 'POST' && url.pathname === '/api/tabs/builder') {
      const builderState = loadState();

      // DoS protection: check tab limit
      if (countTotalTabs(builderState) >= CONFIG.maxTabs) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end(`Tab limit reached (max ${CONFIG.maxTabs}). Close some tabs first.`);
        return;
      }

      // Find available port for builder
      const builderPort = await findAvailablePort(CONFIG.builderPortStart, builderState);

      // Spawn worktree builder
      const result = await spawnWorktreeBuilder(builderPort, builderState);
      if (!result) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to spawn worktree builder');
        return;
      }

      // Save builder to state
      upsertBuilder(result.builder);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: result.builder.id, port: result.builder.port, name: result.builder.name }));
      return;
    }

    // API: Create shell tab (supports worktree parameter for Spec 0057)
    if (req.method === 'POST' && url.pathname === '/api/tabs/shell') {
      const body = await parseJsonBody(req);
      const name = (body.name as string) || undefined;
      const command = (body.command as string) || undefined;
      const worktree = body.worktree === true;
      const branch = (body.branch as string) || undefined;

      // Validate name if provided (prevent command injection)
      if (name && !/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid name format');
        return;
      }

      // Validate branch name if provided (prevent command injection)
      // Allow: letters, numbers, underscores, hyphens, slashes, dots
      // Reject: control chars, spaces, .., @{, trailing/leading slashes
      if (branch) {
        const invalidPatterns = [
          /[\x00-\x1f\x7f]/,     // Control characters
          /\s/,                   // Whitespace
          /\.\./,                 // Parent directory traversal
          /@\{/,                  // Git reflog syntax
          /^\//,                  // Leading slash
          /\/$/,                  // Trailing slash
          /\/\//,                 // Double slash
          /^-/,                   // Leading hyphen (could be flag)
        ];
        const isInvalid = invalidPatterns.some(p => p.test(branch));
        if (isInvalid) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: 'Invalid branch name. Avoid spaces, control characters, .., @{, and leading/trailing slashes.'
          }));
          return;
        }
      }

      const shellState = loadState();

      // DoS protection: check tab limit
      if (countTotalTabs(shellState) >= CONFIG.maxTabs) {
        res.writeHead(429, { 'Content-Type': 'text/plain' });
        res.end(`Tab limit reached (max ${CONFIG.maxTabs}). Close some tabs first.`);
        return;
      }

      // Determine working directory (project root or worktree)
      let cwd = projectRoot;
      let worktreePath: string | undefined;

      if (worktree) {
        // Create worktree for the shell
        const worktreesDir = path.join(projectRoot, '.worktrees');
        if (!fs.existsSync(worktreesDir)) {
          fs.mkdirSync(worktreesDir, { recursive: true });
        }

        // Generate worktree name
        const worktreeName = branch || `temp-${Date.now()}`;
        worktreePath = path.join(worktreesDir, worktreeName);

        // Check if worktree already exists
        if (fs.existsSync(worktreePath)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Worktree '${worktreeName}' already exists at ${worktreePath}`
          }));
          return;
        }

        // Create worktree
        try {
          let gitCmd: string;
          if (branch) {
            // Check if branch already exists
            let branchExists = false;
            try {
              execSync(`git rev-parse --verify "${branch}"`, { cwd: projectRoot, stdio: 'pipe' });
              branchExists = true;
            } catch {
              // Branch doesn't exist
            }

            if (branchExists) {
              // Checkout existing branch into worktree
              gitCmd = `git worktree add "${worktreePath}" "${branch}"`;
            } else {
              // Create new branch and worktree
              gitCmd = `git worktree add "${worktreePath}" -b "${branch}"`;
            }
          } else {
            // Detached HEAD worktree
            gitCmd = `git worktree add "${worktreePath}" --detach`;
          }
          execSync(gitCmd, { cwd: projectRoot, stdio: 'pipe' });

          // Symlink .env from project root into worktree (if it exists)
          const rootEnvPath = path.join(projectRoot, '.env');
          const worktreeEnvPath = path.join(worktreePath, '.env');
          if (fs.existsSync(rootEnvPath) && !fs.existsSync(worktreeEnvPath)) {
            try {
              fs.symlinkSync(rootEnvPath, worktreeEnvPath);
            } catch {
              // Non-fatal: continue without .env symlink
            }
          }

          cwd = worktreePath;
        } catch (gitError: unknown) {
          const errorMsg = gitError instanceof Error
            ? (gitError as { stderr?: Buffer }).stderr?.toString() || gitError.message
            : 'Unknown error';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: `Git worktree creation failed: ${errorMsg}`
          }));
          return;
        }
      }

      // Generate ID and name
      const id = generateId('U');
      const utilName = name || (worktree ? `worktree-${shellState.utils.length + 1}` : `shell-${shellState.utils.length + 1}`);
      const sessionName = `af-shell-${id}`;

      // Get shell command - if command provided, run it then keep shell open
      const shell = process.env.SHELL || '/bin/bash';
      const shellCommand = command
        ? `${shell} -c '${command.replace(/'/g, "'\\''")}; exec ${shell}'`
        : shell;

      // Create PTY terminal session via node-pty
      const terminalId = await createTerminalSession(shellCommand, cwd, `shell-${utilName}`);
      if (!terminalId) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Failed to create terminal session');
        return;
      }

      const util: UtilTerminal = {
        id,
        name: utilName,
        port: 0,
        pid: 0,
        tmuxSession: sessionName,
        worktreePath: worktreePath,
        terminalId,
      };
      addUtil(util);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, id, port: 0, name: utilName, terminalId }));
      return;
    }

    // API: Check if tab process is running (Bugfix #132)
    if (req.method === 'GET' && url.pathname.match(/^\/api\/tabs\/[^/]+\/running$/)) {
      const match = url.pathname.match(/^\/api\/tabs\/([^/]+)\/running$/);
      if (!match) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid tab ID');
        return;
      }
      const tabId = decodeURIComponent(match[1]);
      let running = false;
      let found = false;

      // Check if it's a shell tab
      if (tabId.startsWith('shell-')) {
        const utilId = tabId.replace('shell-', '');
        const tabUtils = getUtils();
        const util = tabUtils.find((u) => u.id === utilId);
        if (util) {
          found = true;
          // Check tmux session status (Spec 0076)
          if (util.tmuxSession) {
            running = tmuxSessionExists(util.tmuxSession);
          } else {
            // Fallback for shells without tmux session (shouldn't happen in practice)
            running = isProcessRunning(util.pid);
          }
        }
      }

      // Check if it's a builder tab
      if (tabId.startsWith('builder-')) {
        const builderId = tabId.replace('builder-', '');
        const builder = getBuilder(builderId);
        if (builder) {
          found = true;
          // Check tmux session status (Spec 0076)
          if (builder.tmuxSession) {
            running = tmuxSessionExists(builder.tmuxSession);
          } else {
            // Fallback for builders without tmux session (shouldn't happen in practice)
            running = isProcessRunning(builder.pid);
          }
        }
      }

      if (found) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ running: false }));
      }
      return;
    }

    // API: Close tab
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/tabs/')) {
      const tabId = decodeURIComponent(url.pathname.replace('/api/tabs/', ''));
      let found = false;

      // Check if it's a file tab
      if (tabId.startsWith('file-')) {
        const annotationId = tabId.replace('file-', '');
        const tabAnnotations = getAnnotations();
        const annotation = tabAnnotations.find((a) => a.id === annotationId);
        if (annotation) {
          await killProcessGracefully(annotation.pid);
          removeAnnotation(annotationId);
          found = true;
        }
      }

      // Check if it's a builder tab
      if (tabId.startsWith('builder-')) {
        const builderId = tabId.replace('builder-', '');
        const builder = getBuilder(builderId);
        if (builder) {
          await killProcessGracefully(builder.pid);
          removeBuilder(builderId);
          found = true;
        }
      }

      // Check if it's a shell tab
      if (tabId.startsWith('shell-')) {
        const utilId = tabId.replace('shell-', '');
        const tabUtils = getUtils();
        const util = tabUtils.find((u) => u.id === utilId);
        if (util) {
          // Kill PTY session if present
          if (util.terminalId && terminalManager) {
            terminalManager.killSession(util.terminalId);
          }
          await killProcessGracefully(util.pid, util.tmuxSession);
          // Note: worktrees are NOT cleaned up on tab close - they may contain useful context
          // Users can manually clean up with `git worktree list` and `git worktree remove`
          removeUtil(utilId);
          found = true;
        }
      }

      if (found) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Tab not found');
      }
      return;
    }

    // API: Stop all
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const stopState = loadState();

      // Kill all tmux sessions first
      for (const util of stopState.utils) {
        if (util.tmuxSession) {
          killTmuxSession(util.tmuxSession);
        }
      }

      if (stopState.architect?.tmuxSession) {
        killTmuxSession(stopState.architect.tmuxSession);
      }

      // Kill all processes gracefully
      const pids: number[] = [];

      if (stopState.architect) {
        pids.push(stopState.architect.pid);
      }

      for (const builder of stopState.builders) {
        pids.push(builder.pid);
      }

      for (const util of stopState.utils) {
        pids.push(util.pid);
      }

      for (const annotation of stopState.annotations) {
        pids.push(annotation.pid);
      }

      // Kill all processes in parallel
      await Promise.all(pids.map((pid) => killProcessGracefully(pid)));

      // Clear state
      clearState();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, killed: pids.length }));

      // Exit after a short delay
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // Open file route - handles file clicks from terminal
    // Returns a small HTML page that messages the dashboard via BroadcastChannel
    if (req.method === 'GET' && url.pathname === '/open-file') {
      const filePath = url.searchParams.get('path');
      const line = url.searchParams.get('line');
      const sourcePort = url.searchParams.get('sourcePort');

      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing path parameter');
        return;
      }

      // Determine base path for relative path resolution
      // If sourcePort is provided, look up the builder/util to get its worktree
      let basePath = projectRoot;
      if (sourcePort) {
        const portNum = parseInt(sourcePort, 10);
        const builders = getBuilders();

        // Check if it's a builder terminal
        const builder = builders.find((b) => b.port === portNum);
        if (builder && builder.worktree) {
          basePath = builder.worktree;
        }

        // Check if it's a utility terminal (they run in project root, so no change needed)
        // Architect terminal also runs in project root
      }

      // Validate path is within project (or builder worktree)
      // For relative paths, resolve against the determined base path
      let fullPath: string | null;
      if (filePath.startsWith('/')) {
        // Absolute path - validate against project root
        fullPath = validatePathWithinProject(filePath);
      } else {
        // Relative path - resolve against base path, then validate
        const resolvedPath = path.resolve(basePath, filePath);
        // For builder worktrees, the path is within project root (worktrees are under .builders/)
        fullPath = validatePathWithinProject(resolvedPath);
      }

      if (!fullPath) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Path must be within project directory');
        return;
      }

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`File not found: ${filePath}`);
        return;
      }

      // HTML-escape the file path for safe display (uses imported escapeHtml from server-utils.js)
      const safeFilePath = escapeHtml(filePath);
      const safeLineDisplay = line ? ':' + escapeHtml(line) : '';

      // Serve a small HTML page that communicates back to dashboard
      // Note: We only use BroadcastChannel, not API call (dashboard handles tab creation)
      const html = `<!DOCTYPE html>
<html>
<head>
  <title>Opening file...</title>
  <style>
    body {
      font-family: system-ui;
      background: #1a1a1a;
      color: #ccc;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
    }
    .message { text-align: center; }
    .path { color: #3b82f6; font-family: monospace; margin: 8px 0; }
  </style>
</head>
<body>
  <div class="message">
    <p>Opening file...</p>
    <p class="path">${safeFilePath}${safeLineDisplay}</p>
  </div>
  <script>
    (async function() {
      const path = ${JSON.stringify(fullPath)};
      const line = ${line ? parseInt(line, 10) : 'null'};

      // Use BroadcastChannel to message the dashboard
      // Dashboard will handle opening the file tab
      const channel = new BroadcastChannel('agent-farm');
      channel.postMessage({
        type: 'openFile',
        path: path,
        line: line
      });

      // Close this window/tab after a short delay
      setTimeout(() => {
        window.close();
        // If window.close() doesn't work (wasn't opened by script),
        // show success message
        document.body.innerHTML = '<div class="message"><p>File opened in dashboard</p><p class="path">You can close this tab</p></div>';
      }, 500);
    })();
  </script>
</body>
</html>`;

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // API: Check if projectlist.md exists (for starter page polling)
    if (req.method === 'GET' && url.pathname === '/api/projectlist-exists') {
      const projectlistPath = path.join(projectRoot, 'codev/projectlist.md');
      const exists = fs.existsSync(projectlistPath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ exists }));
      return;
    }

    // Read file contents (for Projects tab to read projectlist.md)
    if (req.method === 'GET' && url.pathname === '/file') {
      const filePath = url.searchParams.get('path');

      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing path parameter');
        return;
      }

      // Validate path is within project root (prevent path traversal)
      const fullPath = validatePathWithinProject(filePath);
      if (!fullPath) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Path must be within project directory');
        return;
      }

      // Check file exists
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`File not found: ${filePath}`);
        return;
      }

      // Check if it's a directory
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`Cannot read directory as file: ${filePath}`);
        return;
      }

      // Read and return file contents
      try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(content);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error reading file: ' + (err as Error).message);
      }
      return;
    }

    // API: Get directory tree for file browser (Spec 0055)
    if (req.method === 'GET' && url.pathname === '/api/files') {
      // Directories to exclude from the tree
      const EXCLUDED_DIRS = new Set([
        'node_modules',
        '.git',
        'dist',
        '__pycache__',
        '.next',
        '.nuxt',
        '.turbo',
        'coverage',
        '.nyc_output',
        '.cache',
        '.parcel-cache',
        'build',
        '.svelte-kit',
        'vendor',
        '.venv',
        'venv',
        'env',
      ]);

      interface FileNode {
        name: string;
        path: string;
        type: 'file' | 'dir';
        children?: FileNode[];
      }

      // Recursively build directory tree
      function buildTree(dirPath: string, relativePath: string = ''): FileNode[] {
        const entries: FileNode[] = [];

        try {
          const items = fs.readdirSync(dirPath, { withFileTypes: true });

          for (const item of items) {
            // Skip excluded directories only (allow dotfiles like .github, .eslintrc, etc.)
            if (EXCLUDED_DIRS.has(item.name)) continue;

            const itemRelPath = relativePath ? `${relativePath}/${item.name}` : item.name;
            const itemFullPath = path.join(dirPath, item.name);

            if (item.isDirectory()) {
              const children = buildTree(itemFullPath, itemRelPath);
              entries.push({
                name: item.name,
                path: itemRelPath,
                type: 'dir',
                children,
              });
            } else if (item.isFile()) {
              entries.push({
                name: item.name,
                path: itemRelPath,
                type: 'file',
              });
            }
          }
        } catch (err) {
          // Ignore permission errors or inaccessible directories
          console.error(`Error reading directory ${dirPath}:`, (err as Error).message);
        }

        // Sort: directories first, then files, alphabetically within each group
        entries.sort((a, b) => {
          if (a.type === 'dir' && b.type === 'file') return -1;
          if (a.type === 'file' && b.type === 'dir') return 1;
          return a.name.localeCompare(b.name);
        });

        return entries;
      }

      const tree = buildTree(projectRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tree));
      return;
    }

    // API: Get hash of file tree for change detection (auto-refresh)
    if (req.method === 'GET' && url.pathname === '/api/files/hash') {
      // Build a lightweight hash based on directory mtimes
      // This is faster than building the full tree
      function getTreeHash(dirPath: string): string {
        const EXCLUDED_DIRS = new Set([
          'node_modules', '.git', 'dist', '__pycache__', '.next',
          '.nuxt', '.turbo', 'coverage', '.nyc_output', '.cache',
          '.parcel-cache', 'build', '.svelte-kit', 'vendor', '.venv', 'venv', 'env',
        ]);

        let hash = '';
        function walk(dir: string): void {
          try {
            const stat = fs.statSync(dir);
            hash += `${dir}:${stat.mtimeMs};`;

            const items = fs.readdirSync(dir, { withFileTypes: true });
            for (const item of items) {
              if (EXCLUDED_DIRS.has(item.name)) continue;
              if (item.isDirectory()) {
                walk(path.join(dir, item.name));
              } else if (item.isFile()) {
                // Include file mtime for change detection
                const fileStat = fs.statSync(path.join(dir, item.name));
                hash += `${item.name}:${fileStat.mtimeMs};`;
              }
            }
          } catch {
            // Ignore errors
          }
        }

        walk(dirPath);
        // Simple hash: sum of char codes
        let sum = 0;
        for (let i = 0; i < hash.length; i++) {
          sum = ((sum << 5) - sum + hash.charCodeAt(i)) | 0;
        }
        return sum.toString(16);
      }

      const hash = getTreeHash(projectRoot);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hash }));
      return;
    }

    // API: Create a new file (Bugfix #131)
    if (req.method === 'POST' && url.pathname === '/api/files') {
      const body = await parseJsonBody(req);
      const filePath = body.path as string;
      const content = (body.content as string) || '';

      if (!filePath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing path' }));
        return;
      }

      // Validate path is within project root (prevent path traversal)
      const fullPath = validatePathWithinProject(filePath);
      if (!fullPath) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Path must be within project directory' }));
        return;
      }

      // Check if file already exists
      if (fs.existsSync(fullPath)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File already exists' }));
        return;
      }

      // Additional security: validate parent directories don't symlink outside project
      // Find the deepest existing parent and ensure it's within project
      let checkDir = path.dirname(fullPath);
      while (checkDir !== projectRoot && !fs.existsSync(checkDir)) {
        checkDir = path.dirname(checkDir);
      }
      if (fs.existsSync(checkDir) && checkDir !== projectRoot) {
        try {
          const realParent = fs.realpathSync(checkDir);
          if (!realParent.startsWith(projectRoot + path.sep) && realParent !== projectRoot) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Path must be within project directory' }));
            return;
          }
        } catch {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cannot resolve path' }));
          return;
        }
      }

      try {
        // Create parent directories if they don't exist
        const parentDir = path.dirname(fullPath);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        // Write the file
        fs.writeFileSync(fullPath, content, 'utf-8');

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, path: filePath }));
      } catch (err) {
        console.error('Error creating file:', (err as Error).message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create file: ' + (err as Error).message }));
      }
      return;
    }

    // API: Hot reload check (Spec 0060)
    // Returns modification times for all dashboard CSS/JS files
    if (req.method === 'GET' && url.pathname === '/api/hot-reload') {
      try {
        const dashboardDir = path.join(__dirname, '../../../templates/dashboard');
        const cssDir = path.join(dashboardDir, 'css');
        const jsDir = path.join(dashboardDir, 'js');

        const mtimes: Record<string, number> = {};

        // Collect CSS file modification times
        if (fs.existsSync(cssDir)) {
          for (const file of fs.readdirSync(cssDir)) {
            if (file.endsWith('.css')) {
              const stat = fs.statSync(path.join(cssDir, file));
              mtimes[`css/${file}`] = stat.mtimeMs;
            }
          }
        }

        // Collect JS file modification times
        if (fs.existsSync(jsDir)) {
          for (const file of fs.readdirSync(jsDir)) {
            if (file.endsWith('.js')) {
              const stat = fs.statSync(path.join(jsDir, file));
              mtimes[`js/${file}`] = stat.mtimeMs;
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mtimes }));
      } catch (err) {
        console.error('Hot reload check error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // Serve dashboard CSS files
    if (req.method === 'GET' && url.pathname.startsWith('/dashboard/css/')) {
      const filename = url.pathname.replace('/dashboard/css/', '');
      // Validate filename to prevent path traversal
      if (!filename || filename.includes('..') || filename.includes('/') || !filename.endsWith('.css')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid filename');
        return;
      }
      const cssPath = path.join(__dirname, '../../../templates/dashboard/css', filename);
      if (fs.existsSync(cssPath)) {
        const content = fs.readFileSync(cssPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
        res.end(content);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('CSS file not found');
      return;
    }

    // Serve dashboard JS files
    if (req.method === 'GET' && url.pathname.startsWith('/dashboard/js/')) {
      const filename = url.pathname.replace('/dashboard/js/', '');
      // Validate filename to prevent path traversal
      if (!filename || filename.includes('..') || filename.includes('/') || !filename.endsWith('.js')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid filename');
        return;
      }
      const jsPath = path.join(__dirname, '../../../templates/dashboard/js', filename);
      if (fs.existsSync(jsPath)) {
        const content = fs.readFileSync(jsPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
        res.end(content);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('JS file not found');
      return;
    }

    // Terminal proxy route (Spec 0062 - Secure Remote Access)
    // Routes /terminal/:id to the appropriate terminal instance
    const terminalMatch = url.pathname.match(/^\/terminal\/([^/]+)(\/.*)?$/);
    if (terminalMatch) {
      const terminalId = terminalMatch[1];
      const terminalPort = getPortForTerminal(terminalId, loadState());

      if (!terminalPort) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Terminal not found: ${terminalId}` }));
        return;
      }

      // Rewrite the URL to strip the /terminal/:id prefix
      req.url = terminalMatch[2] || '/';
      terminalProxy.web(req, res, { target: `http://localhost:${terminalPort}` });
      return;
    }

    // Annotation proxy route (Spec 0062 - Secure Remote Access)
    // Routes /annotation/:id to the appropriate open-server instance
    const annotationMatch = url.pathname.match(/^\/annotation\/([^/]+)(\/.*)?$/);
    if (annotationMatch) {
      const annotationId = annotationMatch[1];
      const annotations = getAnnotations();
      const annotation = annotations.find((a) => a.id === annotationId);

      if (!annotation) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Annotation not found: ${annotationId}` }));
        return;
      }

      // Rewrite the URL to strip the /annotation/:id prefix, preserving query string
      const remainingPath = annotationMatch[2] || '/';
      req.url = url.search ? `${remainingPath}${url.search}` : remainingPath;
      terminalProxy.web(req, res, { target: `http://localhost:${annotation.port}` });
      return;
    }

    // Serve dashboard (Spec 0085: React or legacy based on config)
    if (useReactDashboard && req.method === 'GET') {
      // Serve React dashboard static files
      const filePath = url.pathname === '/' || url.pathname === '/index.html'
        ? path.join(reactDashboardPath, 'index.html')
        : path.join(reactDashboardPath, url.pathname);

      // Security: Prevent path traversal
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(reactDashboardPath)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        const ext = path.extname(resolved);
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.map': 'application/json',
        };
        const contentType = mimeTypes[ext] ?? 'application/octet-stream';
        // Cache static assets (hashed filenames) but not index.html
        if (ext !== '.html') {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(resolved).pipe(res);
        return;
      }

      // SPA fallback: serve index.html for client-side routing
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/ws/') && !url.pathname.startsWith('/terminal/') && !url.pathname.startsWith('/annotation/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(path.join(reactDashboardPath, 'index.html')).pipe(res);
        return;
      }
    }

    if (!useReactDashboard && req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      // Legacy vanilla JS dashboard
      try {
        let template = fs.readFileSync(templatePath, 'utf-8');
        const state = loadStateWithCleanup();

        // Inject project name into template (HTML-escaped for security)
        const projectName = escapeHtml(getProjectName(projectRoot));
        template = template.replace(/\{\{PROJECT_NAME\}\}/g, projectName);

        // Inject state into template
        const stateJson = JSON.stringify(state);
        template = template.replace(
          '// STATE_INJECTION_POINT',
          `window.INITIAL_STATE = ${stateJson};`
        );

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(template);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading dashboard: ' + (err as Error).message);
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

// Spec 0085: Attach node-pty WebSocket handler for /ws/terminal/:id routes
if (terminalManager) {
  terminalManager.attachWebSocket(server);
}

// WebSocket upgrade handler for terminal proxy (Spec 0062)
// WebSocket for bidirectional terminal communication
server.on('upgrade', (req, socket, head) => {
  // Security check for non-auth mode
  const host = req.headers.host;
  if (!insecureRemoteMode && !process.env.CODEV_WEB_KEY && host && !host.startsWith('localhost') && !host.startsWith('127.0.0.1')) {
    socket.destroy();
    return;
  }

  // CRITICAL: When CODEV_WEB_KEY is set, ALL WebSocket upgrades require auth
  // NO localhost bypass - tunnel daemons run locally, so remoteAddress is unreliable
  const webKey = process.env.CODEV_WEB_KEY;

  if (webKey && !insecureRemoteMode) {
    // Check Sec-WebSocket-Protocol for auth token
    // Format: "auth-<token>, tty" or just "tty"
    const protocols = req.headers['sec-websocket-protocol']?.split(',').map((p) => p.trim()) || [];
    const authProtocol = protocols.find((p) => p.startsWith('auth-'));
    const token = authProtocol?.substring(5); // Remove 'auth-' prefix

    if (!isValidToken(token, webKey)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Remove auth protocol from the list before forwarding
    const cleanProtocols = protocols.filter((p) => !p.startsWith('auth-'));
    req.headers['sec-websocket-protocol'] = cleanProtocols.join(', ') || 'tty';
  }

  const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
  const terminalMatch = reqUrl.pathname.match(/^\/terminal\/([^/]+)(\/.*)?$/);

  if (terminalMatch) {
    const terminalId = terminalMatch[1];
    const terminalPort = getPortForTerminal(terminalId, loadState());

    if (terminalPort) {
      // Rewrite URL to strip /terminal/:id prefix
      req.url = terminalMatch[2] || '/';
      terminalProxy.ws(req, socket, head, { target: `http://localhost:${terminalPort}` });
    } else {
      // Terminal not found - close the socket
      socket.destroy();
    }
  }
  // Non-terminal WebSocket requests are ignored (socket will time out)
});

// Handle WebSocket proxy errors separately
terminalProxy.on('error', (err, req, socket) => {
  console.error('WebSocket proxy error:', err.message);
  if (socket && 'destroy' in socket && typeof socket.destroy === 'function' && !socket.destroyed) {
    (socket as net.Socket).destroy();
  }
});

// Handle server errors (e.g., port already in use)
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Error: Port ${port} is already in use.`);
    console.error(`Run 'lsof -i :${port}' to find the process, or use 'af ports cleanup' to clean up orphans.`);
    process.exit(1);
  } else {
    console.error(`Server error: ${err.message}`);
    process.exit(1);
  }
});

if (bindHost) {
  server.listen(port, bindHost, () => {
    console.log(`Dashboard: http://${bindHost}:${port}`);
  });
} else {
  server.listen(port, () => {
    console.log(`Dashboard: http://localhost:${port}`);
  });
}

// Spec 0085: Graceful shutdown for node-pty terminal manager
process.on('SIGTERM', () => {
  if (terminalManager) {
    terminalManager.shutdown();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  if (terminalManager) {
    terminalManager.shutdown();
  }
  process.exit(0);
});
