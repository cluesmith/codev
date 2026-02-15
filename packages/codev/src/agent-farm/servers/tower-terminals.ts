/**
 * Terminal state management for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 4
 *
 * Contains: terminal session CRUD, file tab persistence, shell ID allocation,
 * terminal reconciliation, and terminal list assembly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { getGlobalDb } from '../db/index.js';
import { getGateStatusForProject } from '../utils/gate-status.js';
import type { GateStatus } from '../utils/gate-status.js';
import {
  saveFileTab as saveFileTabToDb,
  deleteFileTab as deleteFileTabFromDb,
  loadFileTabsForProject as loadFileTabsFromDb,
} from '../utils/file-tabs.js';
import type { FileTab } from '../utils/file-tabs.js';
import { TerminalManager } from '../../terminal/pty-manager.js';
import type { SessionManager, ReconnectRestartOptions } from '../../terminal/session-manager.js';
import type { PtySession } from '../../terminal/pty-session.js';
import type { ProjectTerminals, TerminalEntry, DbTerminalSession } from './tower-types.js';
import { normalizeProjectPath, buildArchitectArgs } from './tower-utils.js';

// ============================================================================
// Module-private state (lifecycle driven by orchestrator)
// ============================================================================

let _deps: TerminalDeps | null = null;

/** Project terminal registry — tracks which terminals belong to which project */
const projectTerminals = new Map<string, ProjectTerminals>();

/** Global TerminalManager instance (lazy singleton) */
let terminalManager: TerminalManager | null = null;

/** True while reconcileTerminalSessions() is running — blocks on-the-fly reconnection (Bugfix #274) */
let _reconciling = false;

// ============================================================================
// Dependency injection interface
// ============================================================================

/** Minimal dependencies required by the terminal module */
export interface TerminalDeps {
  /** Logging function */
  log: (level: 'INFO' | 'ERROR' | 'WARN', msg: string) => void;
  /** Shellper session manager for persistent terminals */
  shellperManager: SessionManager | null;
  /** Register a known project path (from tower-instances) */
  registerKnownProject: (projectPath: string) => void;
  /** Get all known project paths (from tower-instances) */
  getKnownProjectPaths: () => string[];
}

// ============================================================================
// Lifecycle
// ============================================================================

/** Initialize the terminal module with external dependencies */
export function initTerminals(deps: TerminalDeps): void {
  _deps = deps;
}

/** Check if reconciliation is currently in progress (Bugfix #274) */
export function isReconciling(): boolean {
  return _reconciling;
}

/** Tear down the terminal module */
export function shutdownTerminals(): void {
  if (terminalManager) {
    terminalManager.shutdown();
    terminalManager = null;
  }
  _deps = null;
}

// ============================================================================
// Accessors for shared state
// ============================================================================

/** Get the project terminals registry (returns the Map reference) */
export function getProjectTerminals(): Map<string, ProjectTerminals> {
  return projectTerminals;
}

/**
 * Get or create the global TerminalManager instance.
 * Uses a temporary directory as projectRoot since terminals can be for any project.
 */
export function getTerminalManager(): TerminalManager {
  if (!terminalManager) {
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
// Terminal session CRUD
// ============================================================================

/**
 * Get or create project terminal registry entry.
 * On first access for a project, hydrates file tabs from SQLite so
 * persisted tabs are available immediately (not just after /api/state).
 */
export function getProjectTerminalsEntry(projectPath: string): ProjectTerminals {
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
 * Generate next shell ID for a project
 */
export function getNextShellId(projectPath: string): string {
  const entry = getProjectTerminalsEntry(projectPath);
  let maxId = 0;
  for (const id of entry.shells.keys()) {
    const num = parseInt(id.replace('shell-', ''), 10);
    if (!isNaN(num) && num > maxId) maxId = num;
  }
  return `shell-${maxId + 1}`;
}

/**
 * Save a terminal session to SQLite.
 * Guards against race conditions by checking if project is still active.
 */
export function saveTerminalSession(
  terminalId: string,
  projectPath: string,
  type: 'architect' | 'builder' | 'shell',
  roleId: string | null,
  pid: number | null,
  shellperSocket: string | null = null,
  shellperPid: number | null = null,
  shellperStartTime: number | null = null,
): void {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);

    // Race condition guard: only save if project is still in the active registry
    // This prevents zombie rows when stop races with session creation
    if (!projectTerminals.has(normalizedPath) && !projectTerminals.has(projectPath)) {
      _deps?.log('INFO', `Skipping session save - project no longer active: ${projectPath}`);
      return;
    }

    const db = getGlobalDb();
    db.prepare(`
      INSERT OR REPLACE INTO terminal_sessions (id, project_path, type, role_id, pid, shellper_socket, shellper_pid, shellper_start_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(terminalId, normalizedPath, type, roleId, pid, shellperSocket, shellperPid, shellperStartTime);
    _deps?.log('INFO', `Saved terminal session to SQLite: ${terminalId} (${type}) for ${path.basename(normalizedPath)}`);
  } catch (err) {
    _deps?.log('WARN', `Failed to save terminal session: ${(err as Error).message}`);
  }
}

/**
 * Check if a terminal session is persistent (shellper-backed).
 * A session is persistent if it can survive a Tower restart.
 */
export function isSessionPersistent(_terminalId: string, session: PtySession): boolean {
  return session.shellperBacked;
}

/**
 * Delete a terminal session from SQLite
 */
export function deleteTerminalSession(terminalId: string): void {
  try {
    const db = getGlobalDb();
    db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(terminalId);
  } catch (err) {
    _deps?.log('WARN', `Failed to delete terminal session: ${(err as Error).message}`);
  }
}

/**
 * Delete all terminal sessions for a project from SQLite.
 * Normalizes path to ensure consistent cleanup regardless of how path was provided.
 */
export function deleteProjectTerminalSessions(projectPath: string): void {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);
    const db = getGlobalDb();

    // Delete both normalized and raw path to handle any inconsistencies
    db.prepare('DELETE FROM terminal_sessions WHERE project_path = ?').run(normalizedPath);
    if (normalizedPath !== projectPath) {
      db.prepare('DELETE FROM terminal_sessions WHERE project_path = ?').run(projectPath);
    }
  } catch (err) {
    _deps?.log('WARN', `Failed to delete project terminal sessions: ${(err as Error).message}`);
  }
}

/**
 * Get terminal sessions from SQLite for a project.
 * Normalizes path for consistent lookup.
 */
export function getTerminalSessionsForProject(projectPath: string): DbTerminalSession[] {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);
    const db = getGlobalDb();
    return db.prepare('SELECT * FROM terminal_sessions WHERE project_path = ?').all(normalizedPath) as DbTerminalSession[];
  } catch {
    return [];
  }
}

// ============================================================================
// File tab persistence
// ============================================================================

/**
 * Save a file tab to SQLite for persistence across Tower restarts.
 * Thin wrapper around utils/file-tabs.ts with error handling and path normalization.
 */
export function saveFileTab(id: string, projectPath: string, filePath: string, createdAt: number): void {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);
    saveFileTabToDb(getGlobalDb(), id, normalizedPath, filePath, createdAt);
  } catch (err) {
    _deps?.log('WARN', `Failed to save file tab: ${(err as Error).message}`);
  }
}

/**
 * Delete a file tab from SQLite.
 * Thin wrapper around utils/file-tabs.ts with error handling.
 */
export function deleteFileTab(id: string): void {
  try {
    deleteFileTabFromDb(getGlobalDb(), id);
  } catch (err) {
    _deps?.log('WARN', `Failed to delete file tab: ${(err as Error).message}`);
  }
}

/**
 * Load file tabs for a project from SQLite.
 * Thin wrapper around utils/file-tabs.ts with error handling and path normalization.
 */
export function loadFileTabsForProject(projectPath: string): Map<string, FileTab> {
  try {
    const normalizedPath = normalizeProjectPath(projectPath);
    return loadFileTabsFromDb(getGlobalDb(), normalizedPath);
  } catch (err) {
    _deps?.log('WARN', `Failed to load file tabs: ${(err as Error).message}`);
  }
  return new Map<string, FileTab>();
}

// ============================================================================
// Process utilities
// ============================================================================

/**
 * Check if a process is running
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Terminal reconciliation
// ============================================================================

/**
 * Reconcile terminal sessions on startup.
 *
 * DUAL-SOURCE STRATEGY (shellper + SQLite):
 *
 * Phase 1 — Shellper reconnection:
 *   For SQLite rows with shellper_socket IS NOT NULL, attempt to reconnect
 *   via SessionManager.reconnectSession(). Shellper processes survive Tower
 *   restarts as detached OS processes.
 *
 * Phase 2 — SQLite sweep:
 *   Any rows not matched in Phase 1 are stale → clean up.
 *
 * File tabs are the exception: they have no backing process, so SQLite is
 * the sole source of truth for their persistence (see file_tabs table).
 */
export async function reconcileTerminalSessions(): Promise<void> {
  if (!_deps) return;

  _reconciling = true;
  try {
    await _reconcileTerminalSessionsInner();
  } finally {
    _reconciling = false;
  }
}

async function _reconcileTerminalSessionsInner(): Promise<void> {
  if (!_deps) return; // Redundant guard for TypeScript narrowing
  const manager = getTerminalManager();
  const db = getGlobalDb();

  let shellperReconnected = 0;
  let orphanReconnected = 0;
  let killed = 0;
  let cleaned = 0;

  // Track matched session IDs across all phases
  const matchedSessionIds = new Set<string>();

  // ---- Phase 1: Shellper reconnection ----
  let allDbSessions: DbTerminalSession[];
  try {
    allDbSessions = db.prepare('SELECT * FROM terminal_sessions').all() as DbTerminalSession[];
  } catch (err) {
    _deps.log('WARN', `Failed to read terminal sessions: ${(err as Error).message}`);
    allDbSessions = [];
  }

  const shellperSessions = allDbSessions.filter(s => s.shellper_socket !== null);
  if (shellperSessions.length > 0) {
    _deps.log('INFO', `Found ${shellperSessions.length} shellper session(s) in SQLite — reconnecting...`);
  }

  for (const dbSession of shellperSessions) {
    const projectPath = dbSession.project_path;

    // Skip sessions whose project path doesn't exist or is in temp directory
    if (!fs.existsSync(projectPath)) {
      _deps.log('INFO', `Skipping shellper session ${dbSession.id} — project path no longer exists: ${projectPath}`);
      // Kill orphaned shellper process before removing row
      if (dbSession.shellper_pid && processExists(dbSession.shellper_pid)) {
        try { process.kill(dbSession.shellper_pid, 'SIGTERM'); killed++; } catch { /* not killable */ }
      }
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbSession.id);
      cleaned++;
      continue;
    }
    const tmpDirs = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
    if (tmpDirs.some(d => projectPath === d || projectPath.startsWith(d + '/'))) {
      _deps.log('INFO', `Skipping shellper session ${dbSession.id} — project is in temp directory: ${projectPath}`);
      // Kill orphaned shellper process before removing row
      if (dbSession.shellper_pid && processExists(dbSession.shellper_pid)) {
        try { process.kill(dbSession.shellper_pid, 'SIGTERM'); killed++; } catch { /* not killable */ }
      }
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbSession.id);
      cleaned++;
      continue;
    }

    if (!_deps.shellperManager) {
      _deps.log('WARN', `Shellper manager not initialized — cannot reconnect ${dbSession.id}`);
      continue;
    }

    try {
      // For architect sessions, restore auto-restart behavior after reconnection
      let restartOptions: ReconnectRestartOptions | undefined;
      if (dbSession.type === 'architect') {
        let architectCmd = 'claude';
        const configPath = path.join(projectPath, 'af-config.json');
        if (fs.existsSync(configPath)) {
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            if (config.shell?.architect) {
              architectCmd = config.shell.architect;
            }
          } catch { /* use default */ }
        }
        const cmdParts = architectCmd.split(/\s+/);
        const cleanEnv = { ...process.env } as Record<string, string>;
        delete cleanEnv['CLAUDECODE'];
        restartOptions = {
          command: cmdParts[0],
          args: buildArchitectArgs(cmdParts.slice(1), projectPath),
          cwd: projectPath,
          env: cleanEnv,
          restartDelay: 2000,
          maxRestarts: 50,
        };
      }

      const client = await _deps.shellperManager.reconnectSession(
        dbSession.id,
        dbSession.shellper_socket!,
        dbSession.shellper_pid!,
        dbSession.shellper_start_time!,
        restartOptions,
      );

      if (!client) {
        _deps.log('INFO', `Shellper session ${dbSession.id} is stale (PID/socket dead) — will clean up`);
        continue; // Will be cleaned up in Phase 2
      }

      const replayData = client.getReplayData() ?? Buffer.alloc(0);
      const label = dbSession.type === 'architect' ? 'Architect' : `${dbSession.type} ${dbSession.role_id || 'unknown'}`;

      // Create a PtySession backed by the reconnected shellper client
      const session = manager.createSessionRaw({ label, cwd: projectPath });
      const ptySession = manager.getSession(session.id);
      if (ptySession) {
        ptySession.attachShellper(client, replayData, dbSession.shellper_pid!, dbSession.id);
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
      saveTerminalSession(session.id, projectPath, dbSession.type, dbSession.role_id, dbSession.shellper_pid,
        dbSession.shellper_socket, dbSession.shellper_pid, dbSession.shellper_start_time);
      _deps.registerKnownProject(projectPath);

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
      shellperReconnected++;
      _deps.log('INFO', `Reconnected shellper session → ${session.id} (${dbSession.type} for ${path.basename(projectPath)})`);
    } catch (err) {
      _deps.log('WARN', `Failed to reconnect shellper session ${dbSession.id}: ${(err as Error).message}`);
    }
  }

  // ---- Phase 2: Sweep stale SQLite rows ----
  for (const session of allDbSessions) {
    if (matchedSessionIds.has(session.id)) continue;

    const existing = manager.getSession(session.id);
    if (existing && existing.status !== 'exited') continue;

    // Stale row — kill orphaned process if any, then delete
    if (session.pid && processExists(session.pid)) {
      _deps.log('INFO', `Killing orphaned process: PID ${session.pid} (${session.type} for ${path.basename(session.project_path)})`);
      try {
        process.kill(session.pid, 'SIGTERM');
        killed++;
      } catch { /* process not killable */ }
    }

    db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(session.id);
    cleaned++;
  }

  const total = shellperReconnected + orphanReconnected;
  if (total > 0 || killed > 0 || cleaned > 0) {
    _deps.log('INFO', `Reconciliation complete: ${shellperReconnected} shellper, ${orphanReconnected} orphan, ${killed} killed, ${cleaned} stale rows cleaned`);
  } else {
    _deps.log('INFO', 'No terminal sessions to reconcile');
  }
}

// ============================================================================
// Terminal list assembly
// ============================================================================

/**
 * Get terminal list for a project from tower's registry.
 * Phase 4 (Spec 0090): Tower manages terminals directly, no dashboard-server fetch.
 * Returns architect, builders, and shells with their URLs.
 */
export async function getTerminalsForProject(
  projectPath: string,
  proxyUrl: string
): Promise<{ terminals: TerminalEntry[]; gateStatus: GateStatus }> {
  const manager = getTerminalManager();
  const terminals: TerminalEntry[] = [];

  // Query SQLite first, then augment with shellper reconnection
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

    if (!session && dbSession.shellper_socket && _deps?.shellperManager && !_reconciling) {
      // PTY session gone but shellper may still be alive — reconnect on-the-fly
      // Skip during reconciliation to avoid racing with reconcileTerminalSessions()
      // which also reconnects to shellpers (Bugfix #274).
      try {
        // Restore auto-restart for architect sessions (same as startup reconciliation)
        let restartOptions: ReconnectRestartOptions | undefined;
        if (dbSession.type === 'architect') {
          let architectCmd = 'claude';
          const configPath = path.join(dbSession.project_path, 'af-config.json');
          if (fs.existsSync(configPath)) {
            try {
              const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
              if (config.shell?.architect) {
                architectCmd = config.shell.architect;
              }
            } catch { /* use default */ }
          }
          const cmdParts = architectCmd.split(/\s+/);
          const cleanEnv = { ...process.env } as Record<string, string>;
          delete cleanEnv['CLAUDECODE'];
          restartOptions = {
            command: cmdParts[0],
            args: buildArchitectArgs(cmdParts.slice(1), dbSession.project_path),
            cwd: dbSession.project_path,
            env: cleanEnv,
            restartDelay: 2000,
            maxRestarts: 50,
          };
        }

        const client = await _deps.shellperManager.reconnectSession(
          dbSession.id,
          dbSession.shellper_socket,
          dbSession.shellper_pid!,
          dbSession.shellper_start_time!,
          restartOptions,
        );
        if (client) {
          const replayData = client.getReplayData() ?? Buffer.alloc(0);
          const label = dbSession.type === 'architect' ? 'Architect' : `${dbSession.type} ${dbSession.role_id || dbSession.id}`;
          const newSession = manager.createSessionRaw({ label, cwd: dbSession.project_path });
          const ptySession = manager.getSession(newSession.id);
          if (ptySession) {
            ptySession.attachShellper(client, replayData, dbSession.shellper_pid!, dbSession.id);

            // Clean up on exit (same as startup reconciliation path)
            ptySession.on('exit', () => {
              const currentEntry = getProjectTerminalsEntry(dbSession.project_path);
              if (dbSession.type === 'architect' && currentEntry.architect === newSession.id) {
                currentEntry.architect = undefined;
              }
              deleteTerminalSession(newSession.id);
            });
          }
          deleteTerminalSession(dbSession.id);
          saveTerminalSession(newSession.id, dbSession.project_path, dbSession.type, dbSession.role_id, dbSession.shellper_pid,
            dbSession.shellper_socket, dbSession.shellper_pid, dbSession.shellper_start_time);
          dbSession.id = newSession.id;
          session = manager.getSession(newSession.id);
          _deps.log('INFO', `Reconnected to shellper on-the-fly → ${newSession.id}`);
        }
      } catch (err) {
        _deps.log('WARN', `Failed shellper on-the-fly reconnect for ${dbSession.id}: ${(err as Error).message}`);
      }
    }

    if (!session) {
      // Stale row, nothing to reconnect — clean up
      deleteTerminalSession(dbSession.id);
      continue;
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

  // Atomically replace the cache entry
  projectTerminals.set(normalizedPath, freshEntry);

  // Read gate status from porch YAML files
  const gateStatus = getGateStatusForProject(projectPath);

  return { terminals, gateStatus };
}
