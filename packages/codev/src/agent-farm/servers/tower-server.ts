#!/usr/bin/env node

/**
 * Tower server for Agent Farm.
 * Provides a centralized view of all agent-farm instances across projects.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { WebSocketServer, WebSocket } from 'ws';
import { getGlobalDb } from '../db/index.js';
import { escapeHtml, parseJsonBody, isRequestAllowed } from '../utils/server-utils.js';
import { getGateStatusForProject } from '../utils/gate-status.js';
import type { GateStatus } from '../utils/gate-status.js';
import { GateWatcher } from '../utils/gate-watcher.js';
import {
  saveFileTab as saveFileTabToDb,
  deleteFileTab as deleteFileTabFromDb,
  loadFileTabsForProject as loadFileTabsFromDb,
} from '../utils/file-tabs.js';
import type { FileTab } from '../utils/file-tabs.js';
import { TerminalManager } from '../../terminal/pty-manager.js';
import { encodeData, encodeControl, decodeFrame } from '../../terminal/ws-protocol.js';
import { TunnelClient, type TunnelState, type TowerMetadata } from '../lib/tunnel-client.js';
import { readCloudConfig, getCloudConfigPath, maskApiKey, type CloudConfig } from '../lib/cloud-config.js';
import { parseTmuxSessionName, type ParsedTmuxSession } from '../utils/session.js';
import { SessionManager } from '../../terminal/session-manager.js';

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
// Cloud Tunnel Client (Spec 0097 Phase 4)
// ============================================================================

/** Tunnel client instance — created on startup or via POST /api/tunnel/connect */
let tunnelClient: TunnelClient | null = null;

/** Config file watcher — watches cloud-config.json for changes */
let configWatcher: fs.FSWatcher | null = null;

/** Debounce timer for config file watcher events */
let configWatchDebounce: ReturnType<typeof setTimeout> | null = null;

/** Default tunnel port for codevos.ai */
// TICK-001: tunnelPort is no longer needed — WebSocket connects on the same port

/** Periodic metadata refresh interval (re-sends metadata to codevos.ai) */
let metadataRefreshInterval: ReturnType<typeof setInterval> | null = null;

/** Metadata refresh period in milliseconds (30 seconds) */
const METADATA_REFRESH_MS = 30_000;

/**
 * Gather current tower metadata (projects + terminals) for codevos.ai.
 */
async function gatherMetadata(): Promise<TowerMetadata> {
  const instances = await getInstances();
  const projects = instances.map((i) => ({
    path: i.projectPath,
    name: i.projectName,
  }));

  // Build reverse mapping: terminal ID → project path
  const terminalToProject = new Map<string, string>();
  for (const [projectPath, entry] of projectTerminals) {
    if (entry.architect) terminalToProject.set(entry.architect, projectPath);
    for (const termId of entry.builders.values()) terminalToProject.set(termId, projectPath);
    for (const termId of entry.shells.values()) terminalToProject.set(termId, projectPath);
  }

  const manager = terminalManager;
  const terminals: TowerMetadata['terminals'] = [];
  if (manager) {
    for (const session of manager.listSessions()) {
      terminals.push({
        id: session.id,
        projectPath: terminalToProject.get(session.id) ?? '',
      });
    }
  }

  return { projects, terminals };
}

/**
 * Start periodic metadata refresh — re-gathers metadata and pushes to codevos.ai
 * every METADATA_REFRESH_MS while the tunnel is connected.
 */
function startMetadataRefresh(): void {
  stopMetadataRefresh();
  metadataRefreshInterval = setInterval(async () => {
    try {
      if (tunnelClient && tunnelClient.getState() === 'connected') {
        const metadata = await gatherMetadata();
        tunnelClient.sendMetadata(metadata);
      }
    } catch (err) {
      log('WARN', `Metadata refresh failed: ${(err as Error).message}`);
    }
  }, METADATA_REFRESH_MS);
}

/**
 * Stop the periodic metadata refresh.
 */
function stopMetadataRefresh(): void {
  if (metadataRefreshInterval) {
    clearInterval(metadataRefreshInterval);
    metadataRefreshInterval = null;
  }
}

/**
 * Create or reconnect the tunnel client using the given config.
 * Sets up state change listeners and sends initial metadata.
 */
async function connectTunnel(config: CloudConfig): Promise<TunnelClient> {
  // Disconnect existing client if any
  if (tunnelClient) {
    tunnelClient.disconnect();
  }

  const client = new TunnelClient({
    serverUrl: config.server_url,
    apiKey: config.api_key,
    towerId: config.tower_id,
    localPort: port,
  });

  client.onStateChange((state: TunnelState, prev: TunnelState) => {
    log('INFO', `Tunnel: ${prev} → ${state}`);
    if (state === 'connected') {
      startMetadataRefresh();
    } else if (prev === 'connected') {
      stopMetadataRefresh();
    }
    if (state === 'auth_failed') {
      log('ERROR', 'Cloud connection failed: API key is invalid or revoked. Run \'af tower register --reauth\' to update credentials.');
    }
  });

  // Gather and set initial metadata before connecting
  const metadata = await gatherMetadata();
  client.sendMetadata(metadata);

  tunnelClient = client;
  client.connect();

  // Ensure config watcher is running — the config directory now exists.
  // Handles the case where Tower booted before registration (directory didn't
  // exist, so startConfigWatcher() silently failed at boot time).
  startConfigWatcher();

  return client;
}

/**
 * Start watching cloud-config.json for changes.
 * On change: reconnect with new credentials.
 * On delete: disconnect tunnel.
 */
function startConfigWatcher(): void {
  stopConfigWatcher();

  const configPath = getCloudConfigPath();
  const configDir = path.dirname(configPath);
  const configFile = path.basename(configPath);

  // Watch the directory (more reliable than watching the file directly)
  try {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if (filename !== configFile) return;

      // Debounce: multiple events fire for a single write
      if (configWatchDebounce) clearTimeout(configWatchDebounce);
      configWatchDebounce = setTimeout(async () => {
        configWatchDebounce = null;
        try {
          const config = readCloudConfig();
          if (config) {
            log('INFO', `Cloud config changed, reconnecting tunnel (key: ${maskApiKey(config.api_key)})`);
            // Reset circuit breaker in case previous key was invalid
            if (tunnelClient) tunnelClient.resetCircuitBreaker();
            await connectTunnel(config);
          } else {
            // Config deleted or invalid
            log('INFO', 'Cloud config removed or invalid, disconnecting tunnel');
            if (tunnelClient) {
              tunnelClient.disconnect();
              tunnelClient = null;
            }
          }
        } catch (err) {
          log('WARN', `Error handling config change: ${(err as Error).message}`);
        }
      }, 500);
    });
  } catch {
    // Directory doesn't exist yet — that's fine, user hasn't registered
  }
}

/**
 * Stop watching cloud-config.json.
 */
function stopConfigWatcher(): void {
  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }
  if (configWatchDebounce) {
    clearTimeout(configWatchDebounce);
    configWatchDebounce = null;
  }
}

// ============================================================================
// PHASE 2 & 4: Terminal Management (Spec 0090)
// ============================================================================

// Global TerminalManager instance for tower-managed terminals
// Uses a temporary directory as projectRoot since terminals can be for any project
let terminalManager: TerminalManager | null = null;

// Project terminal registry - tracks which terminals belong to which project
// Map<projectPath, { architect?: terminalId, builders: Map<builderId, terminalId>, shells: Map<shellId, terminalId> }>
// FileTab type is imported from utils/file-tabs.ts

interface ProjectTerminals {
  architect?: string;
  builders: Map<string, string>;
  shells: Map<string, string>;
  fileTabs: Map<string, FileTab>;
}
const projectTerminals = new Map<string, ProjectTerminals>();

/**
 * Get or create project terminal registry entry.
 * On first access for a project, hydrates file tabs from SQLite so
 * persisted tabs are available immediately (not just after /api/state).
 */
function getProjectTerminalsEntry(projectPath: string): ProjectTerminals {
  let entry = projectTerminals.get(projectPath);
  if (!entry) {
    entry = { builders: new Map(), shells: new Map(), fileTabs: loadFileTabsForProject(projectPath) };
    projectTerminals.set(projectPath, entry);
  }
  // Migration: ensure fileTabs exists for older entries
  if (!entry.fileTabs) {
    entry.fileTabs = new Map();
  }
  return entry;
}

/**
 * Get language identifier for syntax highlighting
 */
function getLanguageForExt(ext: string): string {
  const langMap: Record<string, string> = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', sh: 'bash', bash: 'bash', md: 'markdown',
    html: 'markup', css: 'css', json: 'json', yaml: 'yaml', yml: 'yaml',
    rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
  };
  return langMap[ext] || ext || 'plaintext';
}

/**
 * Get MIME type for file
 */
function getMimeTypeForFile(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    pdf: 'application/pdf', txt: 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
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
      ringBufferLines: 10000,
      diskLogEnabled: true,
      diskLogMaxBytes: 50 * 1024 * 1024,
      reconnectTimeoutMs: 300_000,
    });
  }
  return terminalManager;
}

// ============================================================================
// TICK-001: Terminal Session Persistence and Reconciliation (Spec 0090)
// ============================================================================

interface DbTerminalSession {
  id: string;
  project_path: string;
  type: 'architect' | 'builder' | 'shell';
  role_id: string | null;
  pid: number | null;
  tmux_session: string | null;
  shepherd_socket: string | null;
  shepherd_pid: number | null;
  shepherd_start_time: number | null;
  created_at: string;
}

/**
 * Normalize a project path to its canonical form for consistent SQLite storage.
 * Uses realpath to resolve symlinks and relative paths.
 */
function normalizeProjectPath(projectPath: string): string {
  try {
    return fs.realpathSync(projectPath);
  } catch {
    // Path doesn't exist yet, normalize without realpath
    return path.resolve(projectPath);
  }
}

/**
 * Save a terminal session to SQLite.
 * Guards against race conditions by checking if project is still active.
 */
function saveTerminalSession(
  terminalId: string,
  projectPath: string,
  type: 'architect' | 'builder' | 'shell',
  roleId: string | null,
  pid: number | null,
  tmuxSession: string | null,
  shepherdSocket: string | null = null,
  shepherdPid: number | null = null,
  shepherdStartTime: number | null = null,
): void {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);

    // Race condition guard: only save if project is still in the active registry
    // This prevents zombie rows when stop races with session creation
    if (!projectTerminals.has(normalizedPath) && !projectTerminals.has(projectPath)) {
      log('INFO', `Skipping session save - project no longer active: ${projectPath}`);
      return;
    }

    const db = getGlobalDb();
    db.prepare(`
      INSERT OR REPLACE INTO terminal_sessions (id, project_path, type, role_id, pid, tmux_session, shepherd_socket, shepherd_pid, shepherd_start_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(terminalId, normalizedPath, type, roleId, pid, tmuxSession, shepherdSocket, shepherdPid, shepherdStartTime);
    log('INFO', `Saved terminal session to SQLite: ${terminalId} (${type}) for ${path.basename(normalizedPath)}`);
  } catch (err) {
    log('WARN', `Failed to save terminal session: ${(err as Error).message}`);
  }
}

/**
 * Delete a terminal session from SQLite
 */
function deleteTerminalSession(terminalId: string): void {
  try {
    const db = getGlobalDb();
    db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(terminalId);
  } catch (err) {
    log('WARN', `Failed to delete terminal session: ${(err as Error).message}`);
  }
}

/**
 * Delete all terminal sessions for a project from SQLite.
 * Normalizes path to ensure consistent cleanup regardless of how path was provided.
 */
function deleteProjectTerminalSessions(projectPath: string): void {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);
    const db = getGlobalDb();

    // Delete both normalized and raw path to handle any inconsistencies
    db.prepare('DELETE FROM terminal_sessions WHERE project_path = ?').run(normalizedPath);
    if (normalizedPath !== projectPath) {
      db.prepare('DELETE FROM terminal_sessions WHERE project_path = ?').run(projectPath);
    }
  } catch (err) {
    log('WARN', `Failed to delete project terminal sessions: ${(err as Error).message}`);
  }
}

/**
 * Save a file tab to SQLite for persistence across Tower restarts.
 * Thin wrapper around utils/file-tabs.ts with error handling and path normalization.
 */
function saveFileTab(id: string, projectPath: string, filePath: string, createdAt: number): void {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);
    saveFileTabToDb(getGlobalDb(), id, normalizedPath, filePath, createdAt);
  } catch (err) {
    log('WARN', `Failed to save file tab: ${(err as Error).message}`);
  }
}

/**
 * Delete a file tab from SQLite.
 * Thin wrapper around utils/file-tabs.ts with error handling.
 */
function deleteFileTab(id: string): void {
  try {
    deleteFileTabFromDb(getGlobalDb(), id);
  } catch (err) {
    log('WARN', `Failed to delete file tab: ${(err as Error).message}`);
  }
}

/**
 * Load file tabs for a project from SQLite.
 * Thin wrapper around utils/file-tabs.ts with error handling and path normalization.
 */
function loadFileTabsForProject(projectPath: string): Map<string, FileTab> {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);
    return loadFileTabsFromDb(getGlobalDb(), normalizedPath);
  } catch (err) {
    log('WARN', `Failed to load file tabs: ${(err as Error).message}`);
  }
  return new Map<string, FileTab>();
}

// Whether tmux is available on this system (checked once at startup)
let tmuxAvailable = false;

// Shepherd session manager (initialized at startup)
let shepherdManager: SessionManager | null = null;

/**
 * Check if tmux is installed and available
 */
function checkTmux(): boolean {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize a tmux session name to match what tmux actually creates.
 * tmux replaces dots with underscores and strips colons from session names.
 * Without this, stored names won't match actual tmux session names,
 * causing reconnection to fail (e.g., "builder-codevos.ai-0001" vs "builder-codevos_ai-0001").
 */
function sanitizeTmuxSessionName(name: string): string {
  return name.replace(/\./g, '_').replace(/:/g, '');
}

/**
 * Create a tmux session with the given command.
 * Returns the sanitized session name if created successfully, null on failure.
 * Session names are sanitized to match tmux behavior (dots → underscores, colons stripped).
 */
function createTmuxSession(
  sessionName: string,
  command: string,
  args: string[],
  cwd: string,
  cols: number,
  rows: number
): string | null {
  // Sanitize to match what tmux actually creates (dots → underscores, colons stripped)
  sessionName = sanitizeTmuxSessionName(sessionName);

  // Kill any stale session with this name
  if (tmuxSessionExists(sessionName)) {
    killTmuxSession(sessionName);
  }

  try {
    // Use spawnSync with array args to avoid shell injection via project paths.
    // Wrap command with `env -u CLAUDECODE` to prevent Claude from detecting
    // a nested session when the Tower was started from within Claude Code.
    const tmuxArgs = [
      'new-session', '-d',
      '-s', sessionName,
      '-c', cwd,
      '-x', String(cols),
      '-y', String(rows),
      'env', '-u', 'CLAUDECODE', command, ...args,
    ];
    const result = spawnSync('tmux', tmuxArgs, { stdio: 'ignore' });
    if (result.status !== 0) {
      log('WARN', `tmux new-session exited with code ${result.status} for "${sessionName}"`);
      return null;
    }

    // Hide tmux status bar (dashboard has its own tabs) and enable mouse.
    // NOTE: aggressive-resize was removed — it caused resize bouncing and
    // visual flashing (dots/redraws) when the dashboard sent multiple resize
    // events during layout settling. Default tmux behavior (size to smallest
    // client) is more stable since we only have one client per session.
    spawnSync('tmux', ['set-option', '-t', sessionName, 'status', 'off'], { stdio: 'ignore' });
    // Mouse OFF — xterm.js in the browser handles selection and Cmd+C/Cmd+V
    // clipboard. tmux mouse mode conflicts (auto-copy on selection, intercepts
    // click/drag). See codev/resources/terminal-tmux.md.
    spawnSync('tmux', ['set-option', '-t', sessionName, 'mouse', 'off'], { stdio: 'ignore' });
    // Alternate screen OFF — without this, tmux puts xterm.js into alternate
    // buffer which has no scrollback. xterm.js then translates wheel events
    // to arrow keys (cycling command history). With alternate-screen off,
    // tmux writes to the normal buffer and xterm.js native scroll works.
    spawnSync('tmux', ['set-option', '-t', sessionName, 'alternate-screen', 'off'], { stdio: 'ignore' });
    // Increase tmux scrollback buffer from default 2,000 to 50,000 lines.
    // Even with alternate-screen off, tmux manages its own internal buffer
    // which can limit output flow to xterm.js. See issue #247.
    spawnSync('tmux', ['set-option', '-t', sessionName, 'history-limit', '50000'], { stdio: 'ignore' });
    // Unset CLAUDECODE so spawned Claude processes don't detect a nested session
    spawnSync('tmux', ['set-environment', '-t', sessionName, '-u', 'CLAUDECODE'], { stdio: 'ignore' });

    return sessionName;
  } catch (err) {
    log('WARN', `Failed to create tmux session "${sessionName}": ${(err as Error).message}`);
    return null;
  }
}

/**
 * Check if a tmux session exists.
 * Sanitizes the name to handle legacy entries stored before dot-replacement fix.
 */
function tmuxSessionExists(sessionName: string): boolean {
  const sanitized = sanitizeTmuxSessionName(sessionName);
  try {
    execSync(`tmux has-session -t "${sanitized}" 2>/dev/null`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a process is running
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a tmux session by name
 */
function killTmuxSession(sessionName: string): void {
  try {
    execSync(`tmux kill-session -t "${sessionName}" 2>/dev/null`, { stdio: 'ignore' });
    log('INFO', `Killed orphaned tmux session: ${sessionName}`);
  } catch {
    // Session may have already died
  }
}

// ============================================================================
// Tmux-First Discovery (tmux is source of truth for existence)
// ============================================================================

/**
 * List all tmux sessions that match codev naming conventions.
 * Returns an array of { tmuxName, parsed } for each matching session.
 * Sessions with recognized prefixes (architect-, builder-, shell-) but
 * unparseable ID formats are included with parsed: null for SQLite lookup.
 */
// Cache for listCodevTmuxSessions — avoid shelling out on every dashboard poll
let _tmuxListCache: Array<{ tmuxName: string; parsed: ParsedTmuxSession | null }> = [];
let _tmuxListCacheTime = 0;
const TMUX_LIST_CACHE_TTL = 10_000;  // 10 seconds

function listCodevTmuxSessions(bypassCache = false): Array<{ tmuxName: string; parsed: ParsedTmuxSession | null }> {
  if (!tmuxAvailable) return [];

  const now = Date.now();
  if (!bypassCache && now - _tmuxListCacheTime < TMUX_LIST_CACHE_TTL) {
    return _tmuxListCache;
  }

  try {
    const result = execSync('tmux list-sessions -F "#{session_name}" 2>/dev/null', { encoding: 'utf-8' });
    const sessions = result.trim().split('\n').filter(Boolean);
    const codevSessions: Array<{ tmuxName: string; parsed: ParsedTmuxSession | null }> = [];

    for (const name of sessions) {
      const parsed = parseTmuxSessionName(name);
      if (parsed) {
        codevSessions.push({ tmuxName: name, parsed });
      } else if (/^(?:architect|builder|shell)-/.test(name)) {
        // Recognized codev prefix but unparseable ID format — include for SQLite lookup
        codevSessions.push({ tmuxName: name, parsed: null });
      }
    }

    _tmuxListCache = codevSessions;
    _tmuxListCacheTime = now;
    return codevSessions;
  } catch {
    _tmuxListCache = [];
    _tmuxListCacheTime = now;
    return [];
  }
}

/**
 * Find the SQLite row that matches a given tmux session name.
 * Looks up by tmux_session column directly.
 */
function findSqliteRowForTmuxSession(tmuxName: string): DbTerminalSession | null {
  try {
    const db = getGlobalDb();
    return (db.prepare('SELECT * FROM terminal_sessions WHERE tmux_session = ?').get(tmuxName) as DbTerminalSession) || null;
  } catch {
    return null;
  }
}

/**
 * Find the full project path for a tmux session's project basename.
 * Checks known projects (terminal_sessions + in-memory cache) for a matching basename.
 * Returns null if no match found.
 */
function resolveProjectPathFromBasename(projectBasename: string): string | null {
  const knownPaths = getKnownProjectPaths();
  for (const projectPath of knownPaths) {
    if (path.basename(projectPath) === projectBasename) {
      return normalizeProjectPath(projectPath);
    }
  }

  return null;
}

/**
 * Reconcile terminal sessions on startup.
 *
 * TRIPLE-SOURCE STRATEGY (shepherd + tmux + SQLite):
 *
 * Phase 1 — Shepherd reconnection:
 *   For SQLite rows with shepherd_socket IS NOT NULL, attempt to reconnect
 *   via SessionManager.reconnectSession(). Shepherd processes survive Tower
 *   restarts as detached OS processes.
 *
 * Phase 2 — tmux reconnection (dual-mode legacy support):
 *   For SQLite rows with tmux_session IS NOT NULL AND shepherd_socket IS NULL,
 *   use the original tmux-first discovery logic.
 *
 * Phase 3 — SQLite sweep:
 *   Any rows not matched in Phase 1 or 2 are stale → clean up.
 *
 * File tabs are the exception: they have no backing process, so SQLite is
 * the sole source of truth for their persistence (see file_tabs table).
 */
async function reconcileTerminalSessions(): Promise<void> {
  const manager = getTerminalManager();
  const db = getGlobalDb();

  let shepherdReconnected = 0;
  let tmuxReconnected = 0;
  let orphanReconnected = 0;
  let killed = 0;
  let cleaned = 0;

  // Track matched session IDs across all phases
  const matchedSessionIds = new Set<string>();

  // ---- Phase 1: Shepherd reconnection ----
  let allDbSessions: DbTerminalSession[];
  try {
    allDbSessions = db.prepare('SELECT * FROM terminal_sessions').all() as DbTerminalSession[];
  } catch (err) {
    log('WARN', `Failed to read terminal sessions: ${(err as Error).message}`);
    allDbSessions = [];
  }

  const shepherdSessions = allDbSessions.filter(s => s.shepherd_socket !== null);
  if (shepherdSessions.length > 0) {
    log('INFO', `Found ${shepherdSessions.length} shepherd session(s) in SQLite — reconnecting...`);
  }

  for (const dbSession of shepherdSessions) {
    const projectPath = dbSession.project_path;

    // Skip sessions whose project path doesn't exist or is in temp directory
    if (!fs.existsSync(projectPath)) {
      log('INFO', `Skipping shepherd session ${dbSession.id} — project path no longer exists: ${projectPath}`);
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbSession.id);
      cleaned++;
      continue;
    }
    const tmpDirs = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
    if (tmpDirs.some(d => projectPath.startsWith(d))) {
      log('INFO', `Skipping shepherd session ${dbSession.id} — project is in temp directory: ${projectPath}`);
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbSession.id);
      cleaned++;
      continue;
    }

    if (!shepherdManager) {
      log('WARN', `Shepherd manager not initialized — cannot reconnect ${dbSession.id}`);
      continue;
    }

    try {
      const client = await shepherdManager.reconnectSession(
        dbSession.id,
        dbSession.shepherd_socket!,
        dbSession.shepherd_pid!,
        dbSession.shepherd_start_time!,
      );

      if (!client) {
        log('INFO', `Shepherd session ${dbSession.id} is stale (PID/socket dead) — will clean up`);
        continue; // Will be cleaned up in Phase 3
      }

      const replayData = client.getReplayData() ?? Buffer.alloc(0);
      const label = dbSession.type === 'architect' ? 'Architect' : `${dbSession.type} ${dbSession.role_id || 'unknown'}`;

      // Create a PtySession backed by the reconnected shepherd client
      const session = manager.createSessionRaw({ label, cwd: projectPath });
      const ptySession = manager.getSession(session.id);
      if (ptySession) {
        ptySession.attachShepherd(client, replayData, dbSession.shepherd_pid!);
      }

      // Register in projectTerminals Map
      const entry = getProjectTerminalsEntry(projectPath);
      if (dbSession.type === 'architect') {
        entry.architect = session.id;
      } else if (dbSession.type === 'builder') {
        entry.builders.set(dbSession.role_id || dbSession.id, session.id);
      } else if (dbSession.type === 'shell') {
        entry.shells.set(dbSession.role_id || dbSession.id, session.id);
      }

      // Update SQLite with new terminal ID
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbSession.id);
      saveTerminalSession(session.id, projectPath, dbSession.type, dbSession.role_id, dbSession.shepherd_pid, null,
        dbSession.shepherd_socket, dbSession.shepherd_pid, dbSession.shepherd_start_time);
      registerKnownProject(projectPath);

      // Clean up on exit
      if (ptySession) {
        ptySession.on('exit', () => {
          const currentEntry = getProjectTerminalsEntry(projectPath);
          if (dbSession.type === 'architect' && currentEntry.architect === session.id) {
            currentEntry.architect = undefined;
          }
          deleteTerminalSession(session.id);
        });
      }

      matchedSessionIds.add(dbSession.id);
      shepherdReconnected++;
      log('INFO', `Reconnected shepherd session → ${session.id} (${dbSession.type} for ${path.basename(projectPath)})`);
    } catch (err) {
      log('WARN', `Failed to reconnect shepherd session ${dbSession.id}: ${(err as Error).message}`);
    }
  }

  // ---- Phase 2: tmux reconnection (legacy dual-mode) ----
  const liveTmuxSessions = listCodevTmuxSessions(/* bypassCache */ true);
  const matchedTmuxNames = new Set<string>();

  if (liveTmuxSessions.length > 0) {
    log('INFO', `Found ${liveTmuxSessions.length} live codev tmux session(s) — reconnecting...`);
  }

  for (const { tmuxName, parsed } of liveTmuxSessions) {
    const dbRow = findSqliteRowForTmuxSession(tmuxName);
    matchedTmuxNames.add(tmuxName);

    // Skip if already handled by shepherd phase
    if (dbRow && matchedSessionIds.has(dbRow.id)) continue;

    const projectPath = dbRow?.project_path || (parsed && resolveProjectPathFromBasename(parsed.projectBasename));
    const type = (dbRow?.type || parsed?.type) as 'architect' | 'builder' | 'shell' | undefined;
    const roleId = dbRow?.role_id ?? parsed?.roleId ?? null;

    if (!projectPath || !type) {
      log('WARN', `Cannot resolve metadata for tmux "${tmuxName}" — skipping`);
      continue;
    }

    if (!fs.existsSync(projectPath)) {
      killTmuxSession(tmuxName);
      if (dbRow) db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbRow.id);
      continue;
    }
    const tmpDirs = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
    if (tmpDirs.some(d => projectPath.startsWith(d))) {
      killTmuxSession(tmuxName);
      if (dbRow) db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbRow.id);
      continue;
    }

    try {
      const label = type === 'architect' ? 'Architect' : `${type} ${roleId || 'unknown'}`;
      const newSession = await manager.createSession({
        command: 'tmux',
        args: ['attach-session', '-t', tmuxName],
        cwd: projectPath,
        label,
      });

      const entry = getProjectTerminalsEntry(projectPath);
      if (type === 'architect') {
        entry.architect = newSession.id;
      } else if (type === 'builder') {
        entry.builders.set(roleId || tmuxName, newSession.id);
      } else if (type === 'shell') {
        entry.shells.set(roleId || tmuxName, newSession.id);
      }

      if (dbRow) {
        db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbRow.id);
        matchedSessionIds.add(dbRow.id);
      }
      saveTerminalSession(newSession.id, projectPath, type, roleId, newSession.pid, tmuxName);
      registerKnownProject(projectPath);

      spawnSync('tmux', ['set-option', '-t', tmuxName, 'mouse', 'off'], { stdio: 'ignore' });
      spawnSync('tmux', ['set-option', '-t', tmuxName, 'alternate-screen', 'off'], { stdio: 'ignore' });
      spawnSync('tmux', ['set-option', '-t', tmuxName, 'history-limit', '50000'], { stdio: 'ignore' });

      if (dbRow) {
        tmuxReconnected++;
      } else {
        orphanReconnected++;
      }
      log('INFO', `Reconnected tmux "${tmuxName}" → ${newSession.id} (${type} for ${path.basename(projectPath)})`);
    } catch (err) {
      log('WARN', `Failed to reconnect to tmux "${tmuxName}": ${(err as Error).message}`);
    }
  }

  // ---- Phase 3: Sweep stale SQLite rows ----
  for (const session of allDbSessions) {
    if (matchedSessionIds.has(session.id)) continue;
    if (session.tmux_session && matchedTmuxNames.has(session.tmux_session)) continue;

    const existing = manager.getSession(session.id);
    if (existing && existing.status !== 'exited') continue;

    // Stale row — kill orphaned process if any, then delete
    if (session.pid && processExists(session.pid)) {
      // Don't kill shepherd processes — they may be reconnectable later
      if (!session.shepherd_socket) {
        log('INFO', `Killing orphaned process: PID ${session.pid} (${session.type} for ${path.basename(session.project_path)})`);
        try {
          process.kill(session.pid, 'SIGTERM');
          killed++;
        } catch { /* process not killable */ }
      }
    }

    db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(session.id);
    cleaned++;
  }

  const total = shepherdReconnected + tmuxReconnected + orphanReconnected;
  if (total > 0 || killed > 0 || cleaned > 0) {
    log('INFO', `Reconciliation complete: ${shepherdReconnected} shepherd, ${tmuxReconnected} tmux, ${orphanReconnected} orphan, ${killed} killed, ${cleaned} stale rows cleaned`);
  } else {
    log('INFO', 'No terminal sessions to reconcile');
  }
}

/**
 * Get terminal sessions from SQLite for a project.
 * Normalizes path for consistent lookup.
 */
function getTerminalSessionsForProject(projectPath: string): DbTerminalSession[] {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);
    const db = getGlobalDb();
    return db.prepare('SELECT * FROM terminal_sessions WHERE project_path = ?').all(normalizedPath) as DbTerminalSession[];
  } catch {
    return [];
  }
}

// Import PtySession type for WebSocket handling
import type { PtySession, PtySessionInfo } from '../../terminal/pty-session.js';

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

  // 3b. Shepherd clients: do NOT call shepherdManager.shutdown() here.
  // SessionManager.shutdown() disconnects sockets, which triggers ShepherdClient
  // 'close' events → PtySession exit(-1) → SQLite row deletion. This would erase
  // the rows that reconcileTerminalSessions() needs on restart.
  // Instead, let the process exit naturally — OS closes all sockets, and shepherds
  // detect the disconnection and keep running. SQLite rows are preserved.
  if (shepherdManager) {
    log('INFO', 'Shepherd sessions will continue running (sockets close on process exit)');
  }

  // 4. Stop gate watcher
  if (gateWatcherInterval) {
    clearInterval(gateWatcherInterval);
    gateWatcherInterval = null;
  }

  // 5. Disconnect tunnel (Spec 0097 Phase 4)
  stopMetadataRefresh();
  stopConfigWatcher();
  if (tunnelClient) {
    log('INFO', 'Disconnecting tunnel...');
    tunnelClient.disconnect();
    tunnelClient = null;
  }

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

// GateStatus type is imported from utils/gate-status.ts

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
  running: boolean;
  proxyUrl: string; // Tower proxy URL for dashboard
  architectUrl: string; // Direct URL to architect terminal
  terminals: TerminalEntry[]; // All available terminals
  gateStatus?: GateStatus;
}

/**
 * Register a project in the known_projects table so it persists across restarts
 * even when all terminal sessions are gone.
 */
function registerKnownProject(projectPath: string): void {
  try {
    const db = getGlobalDb();
    db.prepare(`
      INSERT INTO known_projects (project_path, name, last_launched_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(project_path) DO UPDATE SET last_launched_at = datetime('now')
    `).run(projectPath, path.basename(projectPath));
  } catch {
    // Table may not exist yet (pre-migration)
  }
}

/**
 * Get all known project paths from known_projects, terminal_sessions, and in-memory cache
 */
function getKnownProjectPaths(): string[] {
  const projectPaths = new Set<string>();

  // From known_projects table (persists even after all terminals are killed)
  try {
    const db = getGlobalDb();
    const projects = db.prepare('SELECT project_path FROM known_projects').all() as { project_path: string }[];
    for (const p of projects) {
      projectPaths.add(p.project_path);
    }
  } catch {
    // Table may not exist yet
  }

  // From terminal_sessions table (catches any missed by known_projects)
  try {
    const db = getGlobalDb();
    const sessions = db.prepare('SELECT DISTINCT project_path FROM terminal_sessions').all() as { project_path: string }[];
    for (const s of sessions) {
      projectPaths.add(s.project_path);
    }
  } catch {
    // Table may not exist yet
  }

  // From in-memory cache (includes projects activated this session)
  for (const [projectPath] of projectTerminals) {
    projectPaths.add(projectPath);
  }

  return Array.from(projectPaths);
}

/**
 * Get project name from path
 */
function getProjectName(projectPath: string): string {
  return path.basename(projectPath);
}

// Spec 0100: Gate watcher for af send notifications
const gateWatcher = new GateWatcher(log);
let gateWatcherInterval: ReturnType<typeof setInterval> | null = null;

function startGateWatcher(): void {
  gateWatcherInterval = setInterval(async () => {
    const projectPaths = getKnownProjectPaths();
    for (const projectPath of projectPaths) {
      try {
        const gateStatus = getGateStatusForProject(projectPath);
        await gateWatcher.checkAndNotify(gateStatus, projectPath);
      } catch (err) {
        log('WARN', `Gate watcher error for ${projectPath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }, 10_000);
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
 * Get terminal list for a project from tower's registry.
 * Phase 4 (Spec 0090): Tower manages terminals directly, no dashboard-server fetch.
 * Returns architect, builders, and shells with their URLs.
 */
async function getTerminalsForProject(
  projectPath: string,
  proxyUrl: string
): Promise<{ terminals: TerminalEntry[]; gateStatus: GateStatus }> {
  const manager = getTerminalManager();
  const terminals: TerminalEntry[] = [];

  // Query SQLite first, then augment with tmux discovery
  const dbSessions = getTerminalSessionsForProject(projectPath);

  // Use normalized path for cache consistency
  const normalizedPath = normalizeProjectPath(projectPath);

  // Build a fresh entry from SQLite, then replace atomically to avoid
  // destroying in-memory state that was registered via POST /api/terminals.
  // Previous approach cleared the cache then rebuilt, which lost terminals
  // if their SQLite rows were deleted by external interference (e.g., tests).
  const freshEntry: ProjectTerminals = { builders: new Map(), shells: new Map(), fileTabs: new Map() };

  // Load file tabs from SQLite (persisted across restarts)
  const existingEntry = projectTerminals.get(normalizedPath);
  if (existingEntry && existingEntry.fileTabs.size > 0) {
    // Use in-memory state if already populated (avoids redundant DB reads)
    freshEntry.fileTabs = existingEntry.fileTabs;
  } else {
    freshEntry.fileTabs = loadFileTabsForProject(projectPath);
  }

  for (const dbSession of dbSessions) {
    // Verify session still exists in TerminalManager (runtime state)
    let session = manager.getSession(dbSession.id);

    if (!session && dbSession.shepherd_socket && shepherdManager) {
      // PTY session gone but shepherd may still be alive — reconnect on-the-fly
      try {
        const client = await shepherdManager.reconnectSession(
          dbSession.id,
          dbSession.shepherd_socket,
          dbSession.shepherd_pid!,
          dbSession.shepherd_start_time!,
        );
        if (client) {
          const replayData = client.getReplayData() ?? Buffer.alloc(0);
          const label = dbSession.type === 'architect' ? 'Architect' : `${dbSession.type} ${dbSession.role_id || dbSession.id}`;
          const newSession = manager.createSessionRaw({ label, cwd: dbSession.project_path });
          const ptySession = manager.getSession(newSession.id);
          if (ptySession) {
            ptySession.attachShepherd(client, replayData, dbSession.shepherd_pid!);
          }
          deleteTerminalSession(dbSession.id);
          saveTerminalSession(newSession.id, dbSession.project_path, dbSession.type, dbSession.role_id, dbSession.shepherd_pid, null,
            dbSession.shepherd_socket, dbSession.shepherd_pid, dbSession.shepherd_start_time);
          dbSession.id = newSession.id;
          session = manager.getSession(newSession.id);
          log('INFO', `Reconnected to shepherd on-the-fly → ${newSession.id}`);
        }
      } catch (err) {
        log('WARN', `Failed shepherd on-the-fly reconnect for ${dbSession.id}: ${(err as Error).message}`);
      }
    }

    if (!session) {
      // Try tmux fallback for legacy sessions
      const sanitizedTmux = dbSession.tmux_session ? sanitizeTmuxSessionName(dbSession.tmux_session) : null;
      if (sanitizedTmux && tmuxAvailable && tmuxSessionExists(sanitizedTmux)) {
        try {
          const newSession = await manager.createSession({
            command: 'tmux',
            args: ['attach-session', '-t', sanitizedTmux],
            cwd: dbSession.project_path,
            label: dbSession.type === 'architect' ? 'Architect' : `${dbSession.type} ${dbSession.role_id || dbSession.id}`,
            env: process.env as Record<string, string>,
          });
          deleteTerminalSession(dbSession.id);
          saveTerminalSession(newSession.id, dbSession.project_path, dbSession.type, dbSession.role_id, newSession.pid, sanitizedTmux);
          dbSession.id = newSession.id;
          session = manager.getSession(newSession.id);
          spawnSync('tmux', ['set-option', '-t', sanitizedTmux, 'mouse', 'off'], { stdio: 'ignore' });
          spawnSync('tmux', ['set-option', '-t', sanitizedTmux, 'alternate-screen', 'off'], { stdio: 'ignore' });
          spawnSync('tmux', ['set-option', '-t', sanitizedTmux, 'history-limit', '50000'], { stdio: 'ignore' });
          log('INFO', `Reconnected to tmux "${sanitizedTmux}" on-the-fly → ${newSession.id}`);
        } catch (err) {
          log('WARN', `Failed tmux reconnect for "${dbSession.tmux_session}": ${(err as Error).message} — will retry on next poll`);
          continue;
        }
      } else {
        // Stale row, nothing to reconnect — clean up
        deleteTerminalSession(dbSession.id);
        continue;
      }
    }

    if (dbSession.type === 'architect') {
      freshEntry.architect = dbSession.id;
      terminals.push({
        type: 'architect',
        id: 'architect',
        label: 'Architect',
        url: `${proxyUrl}?tab=architect`,
        active: true,
      });
    } else if (dbSession.type === 'builder') {
      const builderId = dbSession.role_id || dbSession.id;
      freshEntry.builders.set(builderId, dbSession.id);
      terminals.push({
        type: 'builder',
        id: builderId,
        label: `Builder ${builderId}`,
        url: `${proxyUrl}?tab=builder-${builderId}`,
        active: true,
      });
    } else if (dbSession.type === 'shell') {
      const shellId = dbSession.role_id || dbSession.id;
      freshEntry.shells.set(shellId, dbSession.id);
      terminals.push({
        type: 'shell',
        id: shellId,
        label: `Shell ${shellId.replace('shell-', '')}`,
        url: `${proxyUrl}?tab=shell-${shellId}`,
        active: true,
      });
    }
  }

  // Also merge in-memory entries that may not be in SQLite yet
  // (e.g., registered via POST /api/terminals but SQLite row was lost)
  if (existingEntry) {
    if (existingEntry.architect && !freshEntry.architect) {
      const session = manager.getSession(existingEntry.architect);
      if (session && session.status === 'running') {
        freshEntry.architect = existingEntry.architect;
        terminals.push({
          type: 'architect',
          id: 'architect',
          label: 'Architect',
          url: `${proxyUrl}?tab=architect`,
          active: true,
        });
      }
    }
    for (const [builderId, terminalId] of existingEntry.builders) {
      if (!freshEntry.builders.has(builderId)) {
        const session = manager.getSession(terminalId);
        if (session && session.status === 'running') {
          freshEntry.builders.set(builderId, terminalId);
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
    for (const [shellId, terminalId] of existingEntry.shells) {
      if (!freshEntry.shells.has(shellId)) {
        const session = manager.getSession(terminalId);
        if (session && session.status === 'running') {
          freshEntry.shells.set(shellId, terminalId);
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
  }

  // Phase 3: tmux discovery — find tmux sessions for this project that are
  // missing from both SQLite and the in-memory cache.
  // This is the safety net: if SQLite rows got deleted but tmux survived,
  // the session will still appear in the dashboard.
  const projectBasename = sanitizeTmuxSessionName(path.basename(normalizedPath));
  const liveTmux = listCodevTmuxSessions();
  for (const { tmuxName, parsed } of liveTmux) {
    // Skip sessions we couldn't fully parse (no projectBasename to match)
    if (!parsed) continue;
    // Only process sessions whose sanitized project basename matches
    if (parsed.projectBasename !== projectBasename) continue;

    // Skip if we already have this session registered (from SQLite or in-memory)
    const alreadyRegistered =
      (parsed.type === 'architect' && freshEntry.architect) ||
      (parsed.type === 'builder' && parsed.roleId && freshEntry.builders.has(parsed.roleId)) ||
      (parsed.type === 'shell' && parsed.roleId && freshEntry.shells.has(parsed.roleId));
    if (alreadyRegistered) continue;

    // Orphaned tmux session — reconnect it.
    // Skip architect sessions: launchInstance handles creation/reconnection.
    if (parsed.type === 'architect') continue;

    try {
      const label = `${parsed.type} ${parsed.roleId || 'unknown'}`;
      const newSession = await manager.createSession({
        command: 'tmux',
        args: ['attach-session', '-t', tmuxName],
        cwd: normalizedPath,
        label,
      });

      const roleId = parsed.roleId;
      if (parsed.type === 'builder' && roleId) {
        freshEntry.builders.set(roleId, newSession.id);
        terminals.push({ type: 'builder', id: roleId, label: `Builder ${roleId}`, url: `${proxyUrl}?tab=builder-${roleId}`, active: true });
      } else if (parsed.type === 'shell' && roleId) {
        freshEntry.shells.set(roleId, newSession.id);
        terminals.push({ type: 'shell', id: roleId, label: `Shell ${roleId.replace('shell-', '')}`, url: `${proxyUrl}?tab=shell-${roleId}`, active: true });
      }

      // Ensure correct tmux options on recovered sessions
      spawnSync('tmux', ['set-option', '-t', tmuxName, 'mouse', 'off'], { stdio: 'ignore' });
      spawnSync('tmux', ['set-option', '-t', tmuxName, 'alternate-screen', 'off'], { stdio: 'ignore' });
      spawnSync('tmux', ['set-option', '-t', tmuxName, 'history-limit', '50000'], { stdio: 'ignore' });

      // Persist to SQLite so future polls find it directly
      saveTerminalSession(newSession.id, normalizedPath, parsed.type, roleId, newSession.pid, tmuxName);
      log('INFO', `[tmux-discovery] Recovered orphaned tmux "${tmuxName}" → ${newSession.id} (${parsed.type})`);
    } catch (err) {
      log('WARN', `[tmux-discovery] Failed to recover tmux "${tmuxName}": ${(err as Error).message}`);
    }
  }

  // Atomically replace the cache entry
  projectTerminals.set(normalizedPath, freshEntry);

  // Read gate status from porch YAML files
  const gateStatus = getGateStatusForProject(projectPath);

  return { terminals, gateStatus };
}

// Resolve once at module load: both symlinked and real temp dir paths
const _tmpDir = tmpdir();
const _tmpDirResolved = (() => {
  try {
    return fs.realpathSync(_tmpDir);
  } catch {
    return _tmpDir;
  }
})();

function isTempDirectory(projectPath: string): boolean {
  return (
    projectPath.startsWith(_tmpDir + '/') ||
    projectPath.startsWith(_tmpDirResolved + '/') ||
    projectPath.startsWith('/tmp/') ||
    projectPath.startsWith('/private/tmp/')
  );
}

/**
 * Get all instances with their status
 */
async function getInstances(): Promise<InstanceStatus[]> {
  const knownPaths = getKnownProjectPaths();
  const instances: InstanceStatus[] = [];

  for (const projectPath of knownPaths) {
    // Skip builder worktrees - they're managed by their parent project
    if (projectPath.includes('/.builders/')) {
      continue;
    }

    // Skip projects in temp directories (e.g. test artifacts) or whose directories no longer exist
    if (!projectPath.startsWith('remote:')) {
      if (!fs.existsSync(projectPath)) {
        continue;
      }
      if (isTempDirectory(projectPath)) {
        continue;
      }
    }

    // Encode project path for proxy URL
    const encodedPath = Buffer.from(projectPath).toString('base64url');
    const proxyUrl = `/project/${encodedPath}/`;

    // Get terminals and gate status from tower's registry
    // Phase 4 (Spec 0090): Tower manages terminals directly - no separate dashboard server
    const { terminals, gateStatus } = await getTerminalsForProject(projectPath, proxyUrl);

    // Project is active if it has any terminals (Phase 4: no port check needed)
    const isActive = terminals.length > 0;

    instances.push({
      projectPath,
      projectName: getProjectName(projectPath),
      running: isActive,
      proxyUrl,
      architectUrl: `${proxyUrl}?tab=architect`,
      terminals,
      gateStatus,
    });
  }

  // Sort: running first, then by project name
  instances.sort((a, b) => {
    if (a.running !== b.running) {
      return a.running ? -1 : 1;
    }
    return a.projectName.localeCompare(b.projectName);
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

  // Relative paths are meaningless for the tower daemon — only absolute paths
  if (!path.isAbsolute(inputPath)) {
    return [];
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
    // Ensure project has port allocation
    const resolvedPath = fs.realpathSync(projectPath);

    // Persist in known_projects so the project survives terminal cleanup
    registerKnownProject(resolvedPath);

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
        // Parse command string to separate command and args
        const cmdParts = architectCmd.split(/\s+/);
        const cmd = cmdParts[0];
        const cmdArgs = cmdParts.slice(1);

        // Build env with CLAUDECODE removed so spawned Claude processes
        // don't detect a nested session
        const cleanEnv = { ...process.env } as Record<string, string>;
        delete cleanEnv['CLAUDECODE'];

        // Try shepherd first for persistent session with auto-restart
        let shepherdCreated = false;
        if (shepherdManager) {
          try {
            const sessionId = crypto.randomUUID();
            const client = await shepherdManager.createSession({
              sessionId,
              command: cmd,
              args: cmdArgs,
              cwd: projectPath,
              env: cleanEnv,
              cols: 200,
              rows: 50,
              restartOnExit: true,
              restartDelay: 2000,
              maxRestarts: 50,
            });

            // Get replay data and shepherd info
            const replayData = client.getReplayData() ?? Buffer.alloc(0);
            const shepherdInfo = shepherdManager.getSessionInfo(sessionId)!;

            // Create a PtySession backed by the shepherd client
            const session = manager.createSessionRaw({
              label: 'Architect',
              cwd: projectPath,
            });
            const ptySession = manager.getSession(session.id);
            if (ptySession) {
              ptySession.attachShepherd(client, replayData, shepherdInfo.pid);
            }

            entry.architect = session.id;
            saveTerminalSession(session.id, resolvedPath, 'architect', null, shepherdInfo.pid, null,
              shepherdInfo.socketPath, shepherdInfo.pid, shepherdInfo.startTime);

            // Clean up cache/SQLite when the shepherd session exits
            if (ptySession) {
              ptySession.on('exit', () => {
                const currentEntry = getProjectTerminalsEntry(resolvedPath);
                if (currentEntry.architect === session.id) {
                  currentEntry.architect = undefined;
                }
                deleteTerminalSession(session.id);
                log('INFO', `Architect shepherd session exited for ${projectPath}`);
              });
            }

            shepherdCreated = true;
            log('INFO', `Created shepherd-backed architect session for project: ${projectPath}`);
          } catch (shepherdErr) {
            log('WARN', `Shepherd creation failed for architect, falling back: ${(shepherdErr as Error).message}`);
          }
        }

        // Fallback: tmux or non-persistent session
        if (!shepherdCreated) {
          let fallbackCmd = cmd;
          let fallbackArgs = cmdArgs;
          let activeTmuxSession: string | null = null;

          if (tmuxAvailable) {
            const tmuxName = `architect-${path.basename(projectPath)}`;
            const sanitizedTmuxName = sanitizeTmuxSessionName(tmuxName);
            if (tmuxSessionExists(sanitizedTmuxName)) {
              fallbackCmd = 'tmux';
              fallbackArgs = ['attach-session', '-t', sanitizedTmuxName];
              activeTmuxSession = sanitizedTmuxName;
            } else {
              const innerCmd = [fallbackCmd, ...fallbackArgs].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
              const loopCmd = `while true; do ${innerCmd}; echo "Architect exited. Restarting in 2s..."; sleep 2; done`;
              const createdName = createTmuxSession(tmuxName, 'sh', ['-c', loopCmd], projectPath, 200, 50);
              if (createdName) {
                fallbackCmd = 'tmux';
                fallbackArgs = ['attach-session', '-t', createdName];
                activeTmuxSession = createdName;
              }
            }
          }

          const session = await manager.createSession({
            command: fallbackCmd,
            args: fallbackArgs,
            cwd: projectPath,
            label: 'Architect',
            env: cleanEnv,
          });

          entry.architect = session.id;
          saveTerminalSession(session.id, resolvedPath, 'architect', null, session.pid, activeTmuxSession);

          const ptySession = manager.getSession(session.id);
          if (ptySession) {
            ptySession.on('exit', () => {
              const currentEntry = getProjectTerminalsEntry(resolvedPath);
              if (currentEntry.architect === session.id) {
                currentEntry.architect = undefined;
              }
              deleteTerminalSession(session.id);
              log('INFO', `Architect pty exited for ${projectPath}`);
            });
          }

          if (!activeTmuxSession) {
            log('WARN', `Architect terminal for ${projectPath} is non-persistent (no shepherd or tmux)`);
          }
        }

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
    // Query SQLite for tmux session names BEFORE deleting rows
    const dbSessions = getTerminalSessionsForProject(resolvedPath);
    const tmuxSessions = dbSessions
      .filter(s => s.tmux_session)
      .map(s => s.tmux_session as string);

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

    // Kill tmux sessions (node-pty kill only detaches, tmux keeps running)
    for (const tmuxName of tmuxSessions) {
      killTmuxSession(tmuxName);
    }

    // Clear project from registry
    projectTerminals.delete(resolvedPath);
    projectTerminals.delete(projectPath);

    // TICK-001: Delete all terminal sessions from SQLite
    deleteProjectTerminalSessions(resolvedPath);
    if (resolvedPath !== projectPath) {
      deleteProjectTerminalSessions(projectPath);
    }
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

/**
 * Handle tunnel management endpoints (Spec 0097 Phase 4).
 * Extracted so both /api/tunnel/* and /project/<encoded>/api/tunnel/* can use it.
 */
async function handleTunnelEndpoint(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  tunnelSub: string
): Promise<void> {
  // POST connect
  if (req.method === 'POST' && tunnelSub === 'connect') {
    try {
      const config = readCloudConfig();
      if (!config) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Not registered. Run \'af tower register\' first.' }));
        return;
      }
      if (tunnelClient) tunnelClient.resetCircuitBreaker();
      const client = await connectTunnel(config);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, state: client.getState() }));
    } catch (err) {
      log('ERROR', `Tunnel connect failed: ${(err as Error).message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: (err as Error).message }));
    }
    return;
  }

  // POST disconnect
  if (req.method === 'POST' && tunnelSub === 'disconnect') {
    if (tunnelClient) {
      tunnelClient.disconnect();
      tunnelClient = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // GET status
  if (req.method === 'GET' && tunnelSub === 'status') {
    let config: CloudConfig | null = null;
    try {
      config = readCloudConfig();
    } catch {
      // Config file may be corrupted — treat as unregistered
    }

    const state = tunnelClient?.getState() ?? 'disconnected';
    const uptime = tunnelClient?.getUptime() ?? null;

    const response: Record<string, unknown> = {
      registered: config !== null,
      state,
      uptime,
    };

    if (config) {
      response.towerId = config.tower_id;
      response.towerName = config.tower_name;
      response.serverUrl = config.server_url;
      response.accessUrl = `${config.server_url}/t/${config.tower_name}/`;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
    return;
  }

  // Unknown tunnel endpoint
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// Create server
const server = http.createServer(async (req, res) => {
  // Security: Validate Host and Origin headers
  if (!isRequestAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CORS headers — allow localhost and tunnel proxy origins
  const origin = req.headers.origin;
  if (origin && (
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:') ||
    origin.startsWith('https://')
  )) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

    // =========================================================================
    // Tunnel Management Endpoints (Spec 0097 Phase 4)
    // Also reachable from /project/<encoded>/api/tunnel/* (see project router)
    // =========================================================================

    if (url.pathname.startsWith('/api/tunnel/')) {
      const tunnelSub = url.pathname.slice('/api/tunnel/'.length);
      await handleTunnelEndpoint(req, res, tunnelSub);
      return;
    }

    // API: List all projects (Spec 0090 Phase 1)
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      const instances = await getInstances();
      const projects = instances.map((i) => ({
        path: i.projectPath,
        name: i.projectName,
        active: i.running,
        proxyUrl: i.proxyUrl,
        terminals: i.terminals.length,
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
        // Normalize to resolve symlinks (e.g. /var/folders → /private/var/folders on macOS)
        projectPath = normalizeProjectPath(projectPath);
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
        // Check if project is known (has terminals or sessions)
        const knownPaths = getKnownProjectPaths();
        const resolvedPath = fs.existsSync(projectPath) ? fs.realpathSync(projectPath) : projectPath;
        const isKnown = knownPaths.some(
          (p) => p === projectPath || p === resolvedPath
        );

        if (!isKnown) {
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

        // Parse request fields
        let command = typeof body.command === 'string' ? body.command : undefined;
        let args = Array.isArray(body.args) ? body.args as string[] : undefined;
        const cols = typeof body.cols === 'number' ? body.cols : undefined;
        const rows = typeof body.rows === 'number' ? body.rows : undefined;
        const cwd = typeof body.cwd === 'string' ? body.cwd : undefined;
        const env = typeof body.env === 'object' && body.env !== null ? (body.env as Record<string, string>) : undefined;
        const label = typeof body.label === 'string' ? body.label : undefined;

        // Optional session persistence: try shepherd first, fall back to tmux
        const tmuxSession = typeof body.tmuxSession === 'string' ? body.tmuxSession : null;
        const projectPath = typeof body.projectPath === 'string' ? body.projectPath : null;
        const termType = typeof body.type === 'string' && ['builder', 'shell'].includes(body.type) ? body.type as 'builder' | 'shell' : null;
        const roleId = typeof body.roleId === 'string' ? body.roleId : null;

        let info: PtySessionInfo | undefined;
        let persistent = false;
        let activeTmuxSession: string | null = null;

        // Try shepherd if persistence was requested (tmuxSession field present)
        if (tmuxSession && shepherdManager && command && cwd) {
          try {
            const sessionId = crypto.randomUUID();
            const client = await shepherdManager.createSession({
              sessionId,
              command,
              args: args || [],
              cwd,
              env: env || process.env as Record<string, string>,
              cols: cols || 200,
              rows: 50,
              restartOnExit: false,
            });

            const replayData = client.getReplayData() ?? Buffer.alloc(0);
            const shepherdInfo = shepherdManager.getSessionInfo(sessionId)!;

            const session = manager.createSessionRaw({
              label: label || `terminal-${sessionId.slice(0, 8)}`,
              cwd,
            });
            const ptySession = manager.getSession(session.id);
            if (ptySession) {
              ptySession.attachShepherd(client, replayData, shepherdInfo.pid);
            }

            info = session;
            persistent = true;

            if (projectPath && termType && roleId) {
              const entry = getProjectTerminalsEntry(normalizeProjectPath(projectPath));
              if (termType === 'builder') {
                entry.builders.set(roleId, session.id);
              } else {
                entry.shells.set(roleId, session.id);
              }
              saveTerminalSession(session.id, projectPath, termType, roleId, shepherdInfo.pid, null,
                shepherdInfo.socketPath, shepherdInfo.pid, shepherdInfo.startTime);
              log('INFO', `Registered shepherd terminal ${session.id} as ${termType} "${roleId}" for project ${projectPath}`);
            }
          } catch (shepherdErr) {
            log('WARN', `Shepherd creation failed for terminal, falling back: ${(shepherdErr as Error).message}`);
          }
        }

        // Fallback: tmux or non-persistent
        if (!info) {
          if (tmuxSession && tmuxAvailable && command && cwd) {
            const sanitizedName = createTmuxSession(
              tmuxSession,
              command,
              args || [],
              cwd,
              cols || 200,
              rows || 50
            );
            if (sanitizedName) {
              command = 'tmux';
              args = ['attach-session', '-t', sanitizedName];
              activeTmuxSession = sanitizedName;
              persistent = true;
              log('INFO', `Created tmux session "${sanitizedName}" for terminal`);
            }
          }

          try {
            info = await manager.createSession({ command, args, cols, rows, cwd, env, label });
          } catch (createErr) {
            if (activeTmuxSession) {
              killTmuxSession(activeTmuxSession);
            }
            throw createErr;
          }

          if (projectPath && termType && roleId) {
            const entry = getProjectTerminalsEntry(normalizeProjectPath(projectPath));
            if (termType === 'builder') {
              entry.builders.set(roleId, info.id);
            } else {
              entry.shells.set(roleId, info.id);
            }
            saveTerminalSession(info.id, projectPath, termType, roleId, info.pid, activeTmuxSession);
            log('INFO', `Registered terminal ${info.id} as ${termType} "${roleId}" for project ${projectPath}${activeTmuxSession ? ` (tmux: ${activeTmuxSession})` : ''}`);
          }
        }

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...info, wsPath: `/ws/terminal/${info.id}`, tmuxSession: activeTmuxSession, persistent }));
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

        // TICK-001: Delete from SQLite
        deleteTerminalSession(terminalId);

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
      let projectPath = body.projectPath as string;

      if (!projectPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing projectPath' }));
        return;
      }

      // Expand ~ to home directory
      if (projectPath.startsWith('~')) {
        projectPath = projectPath.replace('~', homedir());
      }

      // Reject relative paths — tower daemon CWD is unpredictable
      if (!path.isAbsolute(projectPath)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: `Relative paths are not supported. Use an absolute path (e.g., /Users/.../project or ~/Development/project).`,
        }));
        return;
      }

      // Normalize path (resolve .. segments, trailing slashes)
      projectPath = path.resolve(projectPath);

      const result = await launchInstance(projectPath);
      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    // API: Stop an instance
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      const body = await parseJsonBody(req);
      const targetPath = body.projectPath as string;

      if (!targetPath) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing projectPath' }));
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
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing project path' }));
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
        // Normalize to resolve symlinks (e.g. /var/folders → /private/var/folders on macOS)
        projectPath = normalizeProjectPath(projectPath);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid project path encoding' }));
        return;
      }

      // Phase 4 (Spec 0090): Tower handles everything directly
      const isApiCall = subPath.startsWith('api/') || subPath === 'api';
      const isWsPath = subPath.startsWith('ws/') || subPath === 'ws';

      // Tunnel endpoints are tower-level, not project-scoped, but the React
      // dashboard uses relative paths (./api/tunnel/...) which resolve to
      // /project/<encoded>/api/tunnel/... in project context. Handle here by
      // extracting the tunnel sub-path and dispatching to handleTunnelEndpoint().
      if (subPath.startsWith('api/tunnel/')) {
        const tunnelSub = subPath.slice('api/tunnel/'.length); // e.g. "status", "connect", "disconnect"
        await handleTunnelEndpoint(req, res, tunnelSub);
        return;
      }

      // GET /file?path=<relative-path> — Read project file by path (for StatusPanel project list)
      if (req.method === 'GET' && subPath === 'file' && url.searchParams.has('path')) {
        const relPath = url.searchParams.get('path')!;
        const fullPath = path.resolve(projectPath, relPath);
        // Security: ensure resolved path stays within project directory
        if (!fullPath.startsWith(projectPath + path.sep) && fullPath !== projectPath) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Forbidden');
          return;
        }
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(content);
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
        return;
      }

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
          // Refresh cache via getTerminalsForProject (handles SQLite sync,
          // tmux reconnection, and tmux discovery in one place)
          const encodedPath = Buffer.from(projectPath).toString('base64url');
          const proxyUrl = `/project/${encodedPath}/`;
          const { gateStatus } = await getTerminalsForProject(projectPath, proxyUrl);

          // Now read from the refreshed cache
          const entry = getProjectTerminalsEntry(projectPath);
          const manager = getTerminalManager();
          const state: {
            architect: { port: number; pid: number; terminalId?: string; persistent?: boolean } | null;
            builders: Array<{ id: string; name: string; port: number; pid: number; status: string; phase: string; worktree: string; branch: string; type: string; terminalId?: string; persistent?: boolean }>;
            utils: Array<{ id: string; name: string; port: number; pid: number; terminalId?: string; persistent?: boolean }>;
            annotations: Array<{ id: string; file: string; port: number; pid: number }>;
            projectName?: string;
            gateStatus?: { hasGate: boolean; gateName?: string; builderId?: string; requestedAt?: string };
          } = {
            architect: null,
            builders: [],
            utils: [],
            annotations: [],
            projectName: path.basename(projectPath),
            gateStatus,
          };

          // Add architect if exists
          if (entry.architect) {
            const session = manager.getSession(entry.architect);
            if (session) {
              state.architect = {
                port: 0,
                pid: session.pid || 0,
                terminalId: entry.architect,
                persistent: session.shepherdBacked,
              };
            }
          }

          // Add shells from refreshed cache
          for (const [shellId, terminalId] of entry.shells) {
            const session = manager.getSession(terminalId);
            if (session) {
              state.utils.push({
                id: shellId,
                name: `Shell ${shellId.replace('shell-', '')}`,
                port: 0,
                pid: session.pid || 0,
                terminalId,
                persistent: session.shepherdBacked,
              });
            }
          }

          // Add builders from refreshed cache
          for (const [builderId, terminalId] of entry.builders) {
            const session = manager.getSession(terminalId);
            if (session) {
              state.builders.push({
                id: builderId,
                name: `Builder ${builderId}`,
                port: 0,
                pid: session.pid || 0,
                status: 'running',
                phase: '',
                worktree: '',
                branch: '',
                type: 'spec',
                terminalId,
                persistent: session.shepherdBacked,
              });
            }
          }

          // Add file tabs (Spec 0092 - served through Tower, no separate ports)
          for (const [tabId, tab] of entry.fileTabs) {
            state.annotations.push({
              id: tabId,
              file: tab.path,
              port: 0,  // No separate port - served through Tower
              pid: 0,   // No separate process
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
            const shellCmd = process.env.SHELL || '/bin/bash';
            const shellArgs: string[] = [];

            let shellCreated = false;

            // Try shepherd first for persistent shell session
            if (shepherdManager) {
              try {
                const sessionId = crypto.randomUUID();
                const client = await shepherdManager.createSession({
                  sessionId,
                  command: shellCmd,
                  args: shellArgs,
                  cwd: projectPath,
                  env: process.env as Record<string, string>,
                  cols: 200,
                  rows: 50,
                  restartOnExit: false,
                });

                const replayData = client.getReplayData() ?? Buffer.alloc(0);
                const shepherdInfo = shepherdManager.getSessionInfo(sessionId)!;

                const session = manager.createSessionRaw({
                  label: `Shell ${shellId.replace('shell-', '')}`,
                  cwd: projectPath,
                });
                const ptySession = manager.getSession(session.id);
                if (ptySession) {
                  ptySession.attachShepherd(client, replayData, shepherdInfo.pid);
                }

                const entry = getProjectTerminalsEntry(projectPath);
                entry.shells.set(shellId, session.id);
                saveTerminalSession(session.id, projectPath, 'shell', shellId, shepherdInfo.pid, null,
                  shepherdInfo.socketPath, shepherdInfo.pid, shepherdInfo.startTime);

                shellCreated = true;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  id: shellId,
                  port: 0,
                  name: `Shell ${shellId.replace('shell-', '')}`,
                  terminalId: session.id,
                  persistent: true,
                }));
              } catch (shepherdErr) {
                log('WARN', `Shepherd creation failed for shell, falling back: ${(shepherdErr as Error).message}`);
              }
            }

            // Fallback: tmux or non-persistent
            if (!shellCreated) {
              let fallbackCmd = shellCmd;
              let fallbackArgs = shellArgs;
              let activeTmuxSession: string | null = null;

              if (tmuxAvailable) {
                const tmuxName = `shell-${path.basename(projectPath)}-${shellId}`;
                const sanitizedName = createTmuxSession(tmuxName, fallbackCmd, fallbackArgs, projectPath, 200, 50);
                if (sanitizedName) {
                  fallbackCmd = 'tmux';
                  fallbackArgs = ['attach-session', '-t', sanitizedName];
                  activeTmuxSession = sanitizedName;
                }
              }

              const session = await manager.createSession({
                command: fallbackCmd,
                args: fallbackArgs,
                cwd: projectPath,
                label: `Shell ${shellId.replace('shell-', '')}`,
                env: process.env as Record<string, string>,
              });

              const entry = getProjectTerminalsEntry(projectPath);
              entry.shells.set(shellId, session.id);
              saveTerminalSession(session.id, projectPath, 'shell', shellId, session.pid, activeTmuxSession);

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                id: shellId,
                port: 0,
                name: `Shell ${shellId.replace('shell-', '')}`,
                terminalId: session.id,
                persistent: !!activeTmuxSession,
              }));
            }
          } catch (err) {
            log('ERROR', `Failed to create shell: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // POST /api/tabs/file - Create a file tab (Spec 0092)
        if (req.method === 'POST' && apiPath === 'tabs/file') {
          try {
            const body = await new Promise<string>((resolve) => {
              let data = '';
              req.on('data', (chunk: Buffer) => data += chunk.toString());
              req.on('end', () => resolve(data));
            });
            const { path: filePath, line, terminalId } = JSON.parse(body || '{}');

            if (!filePath || typeof filePath !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing path parameter' }));
              return;
            }

            // Resolve path: use terminal's cwd for relative paths when terminalId is provided
            let fullPath: string;
            if (path.isAbsolute(filePath)) {
              fullPath = filePath;
            } else if (terminalId) {
              const manager = getTerminalManager();
              const session = manager.getSession(terminalId);
              if (session) {
                fullPath = path.join(session.cwd, filePath);
              } else {
                log('WARN', `Terminal session ${terminalId} not found, falling back to project root`);
                fullPath = path.join(projectPath, filePath);
              }
            } else {
              fullPath = path.join(projectPath, filePath);
            }

            // Security: symlink-aware containment check
            // For non-existent files, resolve the parent directory to handle
            // intermediate symlinks (e.g., /tmp -> /private/tmp on macOS).
            let resolvedPath: string;
            try {
              resolvedPath = fs.realpathSync(fullPath);
            } catch {
              try {
                resolvedPath = path.join(fs.realpathSync(path.dirname(fullPath)), path.basename(fullPath));
              } catch {
                resolvedPath = path.resolve(fullPath);
              }
            }

            let normalizedProject: string;
            try {
              normalizedProject = fs.realpathSync(projectPath);
            } catch {
              normalizedProject = path.resolve(projectPath);
            }

            const isWithinProject = resolvedPath.startsWith(normalizedProject + path.sep)
              || resolvedPath === normalizedProject;

            if (!isWithinProject) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Path outside project' }));
              return;
            }

            // Non-existent files still create a tab (spec 0101: file viewer shows "File not found")
            const fileExists = fs.existsSync(fullPath);

            const entry = getProjectTerminalsEntry(projectPath);

            // Check if already open
            for (const [id, tab] of entry.fileTabs) {
              if (tab.path === fullPath) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ id, existing: true, line, notFound: !fileExists }));
                return;
              }
            }

            // Create new file tab (write-through: in-memory + SQLite)
            const id = `file-${crypto.randomUUID()}`;
            const createdAt = Date.now();
            entry.fileTabs.set(id, { id, path: fullPath, createdAt });
            saveFileTab(id, projectPath, fullPath, createdAt);

            log('INFO', `Created file tab: ${id} for ${path.basename(fullPath)}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id, existing: false, line, notFound: !fileExists }));
          } catch (err) {
            log('ERROR', `Failed to create file tab: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // GET /api/file/:id - Get file content as JSON (Spec 0092)
        const fileGetMatch = apiPath.match(/^file\/([^/]+)$/);
        if (req.method === 'GET' && fileGetMatch) {
          const tabId = fileGetMatch[1];
          const entry = getProjectTerminalsEntry(projectPath);
          const tab = entry.fileTabs.get(tabId);

          if (!tab) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File tab not found' }));
            return;
          }

          try {
            const ext = path.extname(tab.path).slice(1).toLowerCase();
            const isText = !['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'webm', 'mov', 'pdf'].includes(ext);

            if (isText) {
              const content = fs.readFileSync(tab.path, 'utf-8');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                path: tab.path,
                name: path.basename(tab.path),
                content,
                language: getLanguageForExt(ext),
                isMarkdown: ext === 'md',
                isImage: false,
                isVideo: false,
              }));
            } else {
              // For binary files, just return metadata
              const stat = fs.statSync(tab.path);
              const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
              const isVideo = ['mp4', 'webm', 'mov'].includes(ext);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                path: tab.path,
                name: path.basename(tab.path),
                content: null,
                language: ext,
                isMarkdown: false,
                isImage,
                isVideo,
                size: stat.size,
              }));
            }
          } catch (err) {
            log('ERROR', `GET /api/file/:id failed: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // GET /api/file/:id/raw - Get raw file content (for images/video) (Spec 0092)
        const fileRawMatch = apiPath.match(/^file\/([^/]+)\/raw$/);
        if (req.method === 'GET' && fileRawMatch) {
          const tabId = fileRawMatch[1];
          const entry = getProjectTerminalsEntry(projectPath);
          const tab = entry.fileTabs.get(tabId);

          if (!tab) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File tab not found' }));
            return;
          }

          try {
            const data = fs.readFileSync(tab.path);
            const mimeType = getMimeTypeForFile(tab.path);
            res.writeHead(200, {
              'Content-Type': mimeType,
              'Content-Length': data.length,
              'Cache-Control': 'no-cache',
            });
            res.end(data);
          } catch (err) {
            log('ERROR', `GET /api/file/:id/raw failed: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // POST /api/file/:id/save - Save file content (Spec 0092)
        const fileSaveMatch = apiPath.match(/^file\/([^/]+)\/save$/);
        if (req.method === 'POST' && fileSaveMatch) {
          const tabId = fileSaveMatch[1];
          const entry = getProjectTerminalsEntry(projectPath);
          const tab = entry.fileTabs.get(tabId);

          if (!tab) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File tab not found' }));
            return;
          }

          try {
            const body = await new Promise<string>((resolve) => {
              let data = '';
              req.on('data', (chunk: Buffer) => data += chunk.toString());
              req.on('end', () => resolve(data));
            });
            const { content } = JSON.parse(body || '{}');

            if (typeof content !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing content parameter' }));
              return;
            }

            fs.writeFileSync(tab.path, content, 'utf-8');
            log('INFO', `Saved file: ${tab.path}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (err) {
            log('ERROR', `POST /api/file/:id/save failed: ${(err as Error).message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: (err as Error).message }));
          }
          return;
        }

        // DELETE /api/tabs/:id - Delete a terminal or file tab
        const deleteMatch = apiPath.match(/^tabs\/(.+)$/);
        if (req.method === 'DELETE' && deleteMatch) {
          const tabId = deleteMatch[1];
          const entry = getProjectTerminalsEntry(projectPath);
          const manager = getTerminalManager();

          // Check if it's a file tab first (Spec 0092, write-through: in-memory + SQLite)
          if (tabId.startsWith('file-')) {
            if (entry.fileTabs.has(tabId)) {
              entry.fileTabs.delete(tabId);
              deleteFileTab(tabId);
              log('INFO', `Deleted file tab: ${tabId}`);
              res.writeHead(204);
              res.end();
            } else {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'File tab not found' }));
            }
            return;
          }

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

            // TICK-001: Delete from SQLite
            deleteTerminalSession(terminalId);

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

          // TICK-001: Delete all terminal sessions from SQLite
          deleteProjectTerminalSessions(projectPath);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // GET /api/files - Return project directory tree for file browser (Spec 0092)
        if (req.method === 'GET' && apiPath === 'files') {
          const maxDepth = parseInt(url.searchParams.get('depth') || '3', 10);
          const ignore = new Set(['.git', 'node_modules', '.builders', 'dist', '.agent-farm', '.next', '.cache', '__pycache__']);

          function readTree(dir: string, depth: number): Array<{ name: string; path: string; type: 'file' | 'directory'; children?: Array<unknown> }> {
            if (depth <= 0) return [];
            try {
              const entries = fs.readdirSync(dir, { withFileTypes: true });
              return entries
                .filter(e => !e.name.startsWith('.') || e.name === '.env.example')
                .filter(e => !ignore.has(e.name))
                .sort((a, b) => {
                  // Directories first, then alphabetical
                  if (a.isDirectory() && !b.isDirectory()) return -1;
                  if (!a.isDirectory() && b.isDirectory()) return 1;
                  return a.name.localeCompare(b.name);
                })
                .map(e => {
                  const fullPath = path.join(dir, e.name);
                  const relativePath = path.relative(projectPath, fullPath);
                  if (e.isDirectory()) {
                    return { name: e.name, path: relativePath, type: 'directory' as const, children: readTree(fullPath, depth - 1) };
                  }
                  return { name: e.name, path: relativePath, type: 'file' as const };
                });
            } catch {
              return [];
            }
          }

          const tree = readTree(projectPath, maxDepth);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(tree));
          return;
        }

        // GET /api/git/status - Return git status for file browser (Spec 0092)
        if (req.method === 'GET' && apiPath === 'git/status') {
          try {
            // Get git status in porcelain format for parsing
            const result = execSync('git status --porcelain', {
              cwd: projectPath,
              encoding: 'utf-8',
              timeout: 5000,
            });

            // Parse porcelain output: XY filename
            // X = staging area status, Y = working tree status
            const modified: string[] = [];
            const staged: string[] = [];
            const untracked: string[] = [];

            for (const line of result.split('\n')) {
              if (!line) continue;
              const x = line[0]; // staging area
              const y = line[1]; // working tree
              const filepath = line.slice(3);

              if (x === '?' && y === '?') {
                untracked.push(filepath);
              } else {
                if (x !== ' ' && x !== '?') {
                  staged.push(filepath);
                }
                if (y !== ' ' && y !== '?') {
                  modified.push(filepath);
                }
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ modified, staged, untracked }));
          } catch (err) {
            // Not a git repo or git command failed — return graceful degradation with error field
            log('WARN', `GET /api/git/status failed: ${(err as Error).message}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ modified: [], staged: [], untracked: [], error: (err as Error).message }));
          }
          return;
        }

        // GET /api/files/recent - Return recently opened file tabs (Spec 0092)
        if (req.method === 'GET' && apiPath === 'files/recent') {
          const entry = getProjectTerminalsEntry(projectPath);

          // Get all file tabs sorted by creation time (most recent first)
          const recentFiles = Array.from(entry.fileTabs.values())
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, 10)  // Limit to 10 most recent
            .map(tab => ({
              id: tab.id,
              path: tab.path,
              name: path.basename(tab.path),
              relativePath: path.relative(projectPath, tab.path),
            }));

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(recentFiles));
          return;
        }

        // GET /api/annotate/:tabId/* — Serve rich annotator template and sub-APIs
        const annotateMatch = apiPath.match(/^annotate\/([^/]+)(\/(.*))?$/);
        if (annotateMatch) {
          const tabId = annotateMatch[1];
          const subRoute = annotateMatch[3] || '';
          const entry = getProjectTerminalsEntry(projectPath);
          const tab = entry.fileTabs.get(tabId);

          if (!tab) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File tab not found' }));
            return;
          }

          const filePath = tab.path;
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext);
          const isVideo = ['mp4', 'webm', 'mov'].includes(ext);
          const is3D = ['stl', '3mf'].includes(ext);
          const isPdf = ext === 'pdf';
          const isMarkdown = ext === 'md';

          // Sub-route: GET /file — re-read file content from disk
          if (req.method === 'GET' && subRoute === 'file') {
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end(content);
            } catch (err) {
              log('ERROR', `GET /api/annotate/:id/file failed: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // Sub-route: POST /save — save file content
          if (req.method === 'POST' && subRoute === 'save') {
            try {
              const body = await new Promise<string>((resolve) => {
                let data = '';
                req.on('data', (chunk: Buffer) => data += chunk.toString());
                req.on('end', () => resolve(data));
              });
              const parsed = JSON.parse(body || '{}');
              const fileContent = parsed.content;
              if (typeof fileContent !== 'string') {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                res.end('Missing content');
                return;
              }
              fs.writeFileSync(filePath, fileContent, 'utf-8');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              log('ERROR', `POST /api/annotate/:id/save failed: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // Sub-route: GET /api/mtime — file modification time
          if (req.method === 'GET' && subRoute === 'api/mtime') {
            try {
              const stat = fs.statSync(filePath);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ mtime: stat.mtimeMs }));
            } catch (err) {
              log('ERROR', `GET /api/annotate/:id/api/mtime failed: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // Sub-route: GET /api/image, /api/video, /api/model, /api/pdf — raw binary content
          if (req.method === 'GET' && (subRoute === 'api/image' || subRoute === 'api/video' || subRoute === 'api/model' || subRoute === 'api/pdf')) {
            try {
              const data = fs.readFileSync(filePath);
              const mimeType = getMimeTypeForFile(filePath);
              res.writeHead(200, {
                'Content-Type': mimeType,
                'Content-Length': data.length,
                'Cache-Control': 'no-cache',
              });
              res.end(data);
            } catch (err) {
              log('ERROR', `GET /api/annotate/:id/${subRoute} failed: ${(err as Error).message}`);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }

          // Default: serve the annotator HTML template
          if (req.method === 'GET' && (subRoute === '' || subRoute === undefined)) {
            try {
              const templateFile = is3D ? '3d-viewer.html' : 'open.html';
              const tplPath = path.resolve(__dirname, `../../../templates/${templateFile}`);
              let html = fs.readFileSync(tplPath, 'utf-8');

              const fileName = path.basename(filePath);
              const fileSize = fs.statSync(filePath).size;

              if (is3D) {
                html = html.replace(/\{\{FILE\}\}/g, fileName);
                html = html.replace(/\{\{FILE_PATH_JSON\}\}/g, JSON.stringify(filePath));
                html = html.replace(/\{\{FORMAT\}\}/g, ext);
              } else {
                html = html.replace(/\{\{FILE\}\}/g, fileName);
                html = html.replace(/\{\{FILE_PATH\}\}/g, filePath);
                html = html.replace(/\{\{BUILDER_ID\}\}/g, '');
                html = html.replace(/\{\{LANG\}\}/g, getLanguageForExt(ext));
                html = html.replace(/\{\{IS_MARKDOWN\}\}/g, String(isMarkdown));
                html = html.replace(/\{\{IS_IMAGE\}\}/g, String(isImage));
                html = html.replace(/\{\{IS_VIDEO\}\}/g, String(isVideo));
                html = html.replace(/\{\{IS_PDF\}\}/g, String(isPdf));
                html = html.replace(/\{\{FILE_SIZE\}\}/g, String(fileSize));

                // Inject initialization script (template loads content via fetch)
                let initScript: string;
                if (isImage) {
                  initScript = `initImage(${fileSize});`;
                } else if (isVideo) {
                  initScript = `initVideo(${fileSize});`;
                } else if (isPdf) {
                  initScript = `initPdf(${fileSize});`;
                } else {
                  initScript = `fetch('file').then(r=>r.text()).then(init);`;
                }
                html = html.replace('// FILE_CONTENT will be injected by the server', initScript);
              }

              // Handle ?line= query param for scroll-to-line
              const lineParam = url.searchParams.get('line');
              if (lineParam) {
                const scrollScript = `<script>window.addEventListener('load',()=>{setTimeout(()=>{const el=document.querySelector('[data-line="${lineParam}"]');if(el){el.scrollIntoView({block:'center'});el.classList.add('highlighted-line');}},200);})</script>`;
                html = html.replace('</body>', `${scrollScript}</body>`);
              }

              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(html);
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end(`Failed to serve annotator: ${(err as Error).message}`);
            }
            return;
          }
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
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

// SECURITY: Bind to localhost only to prevent network exposure
server.listen(port, '127.0.0.1', async () => {
  log('INFO', `Tower server listening at http://localhost:${port}`);

  // Check tmux availability once at startup (legacy, used during dual-mode transition)
  tmuxAvailable = checkTmux();
  log('INFO', `tmux available: ${tmuxAvailable}`);

  // Initialize shepherd session manager for persistent terminals
  const socketDir = path.join(homedir(), '.codev', 'run');
  const shepherdScript = path.join(__dirname, '..', '..', 'terminal', 'shepherd-main.js');
  shepherdManager = new SessionManager({
    socketDir,
    shepherdScript,
    nodeExecutable: process.execPath,
  });
  const staleCleaned = await shepherdManager.cleanupStaleSockets();
  if (staleCleaned > 0) {
    log('INFO', `Cleaned up ${staleCleaned} stale shepherd socket(s)`);
  }
  log('INFO', 'Shepherd session manager initialized');

  // TICK-001: Reconcile terminal sessions from previous run
  await reconcileTerminalSessions();

  // Spec 0100: Start background gate watcher for af send notifications
  startGateWatcher();
  log('INFO', 'Gate watcher started (10s poll interval)');

  // Spec 0097 Phase 4: Auto-connect tunnel if registered
  try {
    const config = readCloudConfig();
    if (config) {
      log('INFO', `Cloud config found, connecting tunnel (tower: ${config.tower_name}, key: ${maskApiKey(config.api_key)})`);
      await connectTunnel(config);
    } else {
      log('INFO', 'No cloud config found, operating in local-only mode');
    }
  } catch (err) {
    log('WARN', `Failed to read cloud config: ${(err as Error).message}. Operating in local-only mode.`);
  }

  // Start watching cloud-config.json for changes
  startConfigWatcher();
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
    // Normalize to resolve symlinks (e.g. /var/folders → /private/var/folders on macOS)
    projectPath = normalizeProjectPath(projectPath);
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
