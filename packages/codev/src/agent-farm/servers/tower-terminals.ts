/**
 * Terminal state management for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 4
 *
 * Contains: terminal session CRUD, file tab persistence, shell ID allocation,
 * terminal reconciliation, and terminal list assembly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { AGENT_FARM_DIR, encodeWorkspacePath } from '../lib/tower-client.js';
import type { TerminalType } from '@cluesmith/codev-core/tower-client';
import { loadConfig } from '../../lib/config.js';
import { getGlobalDb } from '../db/index.js';
import {
  saveFileTab as saveFileTabToDb,
  deleteFileTab as deleteFileTabFromDb,
  deleteFileTabsForWorkspace as deleteFileTabsForWorkspaceFromDb,
  deleteFileTabsByPathPrefix as deleteFileTabsByPathPrefixFromDb,
  loadFileTabsForWorkspace as loadFileTabsFromDb,
} from '../utils/file-tabs.js';
import type { FileTab } from '../utils/file-tabs.js';
import { TerminalManager, DEFAULT_DISK_LOG_MAX_BYTES } from '../../terminal/index.js';

/**
 * Extract shellper session UUID from socket path (Spec 468).
 * Socket format: shellper-<UUID>.sock
 */
/**
 * #1198: cap the replay seeded into an adopted PtySession's ring buffer.
 * A long-lived full-screen TUI session's replay can be many MB of
 * newline-free history; seeding it whole means every subsequent viewer
 * attach ships the entire payload to xterm.js in one bracketed write
 * (multi-second parse, webview stalls). Seed only the most recent bytes:
 * the client's post-connect resize nudge repaints full-screen apps, and the
 * shellper retains the full history.
 */
const RING_SEED_MAX_BYTES = 1024 * 1024; // 1MB

function capRingSeed(replayData: Buffer, sessionId: string): Buffer {
  if (replayData.length <= RING_SEED_MAX_BYTES) return replayData;
  _deps?.log('INFO', `Session ${sessionId} replay is ${replayData.length} bytes; seeding the most recent ${RING_SEED_MAX_BYTES}`);
  return replayData.subarray(replayData.length - RING_SEED_MAX_BYTES);
}

function extractShellperSessionId(socketPath: string | null): string | null {
  if (!socketPath) return null;
  const match = path.basename(socketPath).match(/^shellper-(.+)\.sock$/);
  return match ? match[1] : null;
}
import type { SessionManager, ReconnectRestartOptions } from '../../terminal/session-manager.js';
import type { PtySession } from '../../terminal/pty-session.js';
import type { WorkspaceTerminals, TerminalEntry, DbTerminalSession } from './tower-types.js';
import { normalizeWorkspacePath, resolveArchitectRestart, buildArchitectCrashLoopFallback } from './tower-utils.js';
import { setArchitectByName } from '../state.js';
import { isIntentionallyStopping } from './tower-instances.js';

// ============================================================================
// Module-private state (lifecycle driven by orchestrator)
// ============================================================================

let _deps: TerminalDeps | null = null;

/** Workspace terminal registry — tracks which terminals belong to which workspace */
const workspaceTerminals = new Map<string, WorkspaceTerminals>();

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
  /** Register a known workspace path (from tower-instances) */
  registerKnownWorkspace: (workspacePath: string) => void;
  /** Get all known workspace paths (from tower-instances) */
  getKnownWorkspacePaths: () => string[];
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

// ============================================================================
// Startup-readiness barrier (#997)
// ============================================================================
//
// On a Tower restart the HTTP server begins serving before
// reconcileTerminalSessions() has re-registered persistent (shellper-backed)
// sessions in the workspaceTerminals map. During that window /api/state,
// /api/overview, and WS upgrades see a half-populated role→terminalId map and
// a client cannot distinguish "successor not registered yet" from "session
// gone". This barrier lets the readers of reconcile's output wait until the
// startup reconcile has settled exactly once.
//
// Unlike isReconciling() (false both before and after reconcile), this is a
// monotonic "has the startup reconcile completed" signal: it flips false→true
// once and stays true (outside test resets). It is resolved in
// reconcileTerminalSessions()'s finally — including the early !_deps return and
// a thrown reconcile — so a failed or skipped reconcile can never wedge serving
// forever (non-blocking-on-failure).

let _startupReconcileSettled = false;
let _resolveStartupReady!: () => void;
let _startupReadyPromise = new Promise<void>((resolve) => { _resolveStartupReady = resolve; });

/** Defensive cap on how long a request waits for the barrier (env-overridable). */
const STARTUP_READY_TIMEOUT_MS = Math.max(
  parseInt(process.env.CODEV_STARTUP_READY_TIMEOUT_MS || '10000', 10) || 10000,
  0,
);

/** Mark the startup reconcile as settled (idempotent); releases any waiters. */
export function markStartupReconcileSettled(): void {
  if (_startupReconcileSettled) return;
  _startupReconcileSettled = true;
  _resolveStartupReady();
}

/** Synchronous readiness check — true once the startup reconcile completed (#997). Served by GET /health. */
export function isStartupReconcileSettled(): boolean {
  return _startupReconcileSettled;
}

/**
 * Await completion of the startup reconcile (#997). Resolves immediately once
 * settled. Bounded by `timeoutMs` (default {@link STARTUP_READY_TIMEOUT_MS}) as
 * defense against a pathological reconcile that never returns: on timeout it
 * logs and resolves anyway, so a single request degrades to possibly-incomplete
 * state rather than hanging forever. Pass 0 to wait indefinitely.
 */
export function whenStartupReconcileSettled(timeoutMs: number = STARTUP_READY_TIMEOUT_MS): Promise<void> {
  if (_startupReconcileSettled) return Promise.resolve();
  if (timeoutMs <= 0) return _startupReadyPromise;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      _deps?.log('WARN', `Startup reconcile not settled within ${timeoutMs}ms — serving possibly-incomplete terminal state`);
      resolve();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    _startupReadyPromise.then(finish);
  });
}

/** Test-only: reset the barrier to its pre-reconcile pending state. */
export function __resetStartupReconcileSettledForTest(): void {
  _startupReconcileSettled = false;
  _startupReadyPromise = new Promise<void>((resolve) => { _resolveStartupReady = resolve; });
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

/** Get the workspace terminals registry (returns the Map reference) */
export function getWorkspaceTerminals(): Map<string, WorkspaceTerminals> {
  return workspaceTerminals;
}

/**
 * Get or create the global TerminalManager instance.
 * Uses a temporary directory as workspaceRoot since terminals can be for any workspace.
 */
export function getTerminalManager(): TerminalManager {
  if (!terminalManager) {
    const workspaceRoot = process.env.HOME || '/tmp';
    terminalManager = new TerminalManager({
      workspaceRoot: workspaceRoot,
      logDir: path.join(AGENT_FARM_DIR, 'logs'),
      maxSessions: 100,
      ringBufferLines: 10000,
      diskLogEnabled: true,
      diskLogMaxBytes: DEFAULT_DISK_LOG_MAX_BYTES,
      reconnectTimeoutMs: 300_000,
    });
  }
  return terminalManager;
}

// ============================================================================
// Terminal session CRUD
// ============================================================================

/**
 * Get or create workspace terminal registry entry.
 * On first access for a workspace, hydrates file tabs from SQLite so
 * persisted tabs are available immediately (not just after /api/state).
 */
export function getWorkspaceTerminalsEntry(workspacePath: string): WorkspaceTerminals {
  let entry = workspaceTerminals.get(workspacePath);
  if (!entry) {
    entry = { architects: new Map(), builders: new Map(), shells: new Map(), fileTabs: loadFileTabsForWorkspace(workspacePath) };
    workspaceTerminals.set(workspacePath, entry);
  }
  // Migration: ensure fileTabs exists for older entries
  if (!entry.fileTabs) {
    entry.fileTabs = new Map();
  }
  // Migration (Spec 755): ensure architects exists for older entries
  if (!entry.architects) {
    entry.architects = new Map();
  }
  return entry;
}

/**
 * Get the wsTerminals entry for a workspace after rehydrating it from SQLite
 * and reconnecting any missing shellper sessions. Use this in any HTTP route
 * that reads wsTerminals to build a UI response — it ensures the read sees
 * a freshly-reconciled entry instead of whatever drift has accumulated since
 * the last write.
 *
 * Bugfix #718: /api/overview previously read wsTerminals directly while
 * /api/state had its own ad-hoc rehydration call. The two endpoints diverged
 * after any state-loss event (Tower restart with non-shellper sessions,
 * crashed builders, etc.), and the extension's sidebar showed empty while
 * the dashboard self-healed. Centralizing the read path here keeps every
 * future endpoint consistent without each having to remember to opt in.
 */
export async function getRehydratedTerminalsEntry(workspacePath: string): Promise<WorkspaceTerminals> {
  // #997: wait for the startup reconcile to finish re-registering persistent
  // sessions before reading the map, so /api/state and /api/overview return a
  // complete role→terminalId mapping on the first post-restart read.
  await whenStartupReconcileSettled();
  const proxyUrl = `/workspace/${encodeWorkspacePath(workspacePath)}/`;
  await getTerminalsForWorkspace(workspacePath, proxyUrl);
  return getWorkspaceTerminalsEntry(workspacePath);
}

/**
 * Generate next shell ID for a workspace
 */
export function getNextShellId(workspacePath: string): string {
  const entry = getWorkspaceTerminalsEntry(workspacePath);
  let maxId = 0;
  for (const id of entry.shells.keys()) {
    const num = parseInt(id.replace('shell-', ''), 10);
    if (!isNaN(num) && num > maxId) maxId = num;
  }
  return `shell-${maxId + 1}`;
}

/**
 * Save a terminal session to SQLite.
 * Guards against race conditions by checking if workspace is still active.
 */
export function saveTerminalSession(
  terminalId: string,
  workspacePath: string,
  type: TerminalType,
  roleId: string | null,
  pid: number | null,
  shellperSocket: string | null = null,
  shellperPid: number | null = null,
  shellperStartTime: number | null = null,
  label: string | null = null,
  cwd: string | null = null,
): void {
  try {
    const normalizedPath = normalizeWorkspacePath(workspacePath);

    // Race condition guard: only save if workspace is still in the active registry
    // This prevents zombie rows when stop races with session creation
    if (!workspaceTerminals.has(normalizedPath) && !workspaceTerminals.has(workspacePath)) {
      _deps?.log('INFO', `Skipping session save - workspace no longer active: ${workspacePath}`);
      return;
    }

    const db = getGlobalDb();
    db.prepare(`
      INSERT OR REPLACE INTO terminal_sessions (id, workspace_path, type, role_id, pid, shellper_socket, shellper_pid, shellper_start_time, label, cwd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(terminalId, normalizedPath, type, roleId, pid, shellperSocket, shellperPid, shellperStartTime, label, cwd);
    _deps?.log('INFO', `Saved terminal session to SQLite: ${terminalId} (${type}) for ${path.basename(normalizedPath)}`);
  } catch (err) {
    _deps?.log('WARN', `Failed to save terminal session: ${(err as Error).message}`);
  }
}

/**
 * Update the label of a terminal session in SQLite (Spec 468).
 */
export function updateTerminalLabel(terminalId: string, label: string): void {
  try {
    const db = getGlobalDb();
    db.prepare('UPDATE terminal_sessions SET label = ? WHERE id = ?').run(label, terminalId);
  } catch (err) {
    _deps?.log('WARN', `Failed to update terminal label: ${(err as Error).message}`);
  }
}

/**
 * Get a terminal session row by its primary key (Spec 468).
 */
export function getTerminalSessionById(terminalId: string): DbTerminalSession | null {
  try {
    const db = getGlobalDb();
    return db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(terminalId) as DbTerminalSession | null;
  } catch {
    return null;
  }
}

/**
 * Get labels of all active shell sessions in a workspace (Spec 468, for dedup).
 */
export function getActiveShellLabels(workspacePath: string, excludeId?: string): string[] {
  try {
    const db = getGlobalDb();
    const normalizedPath = normalizeWorkspacePath(workspacePath);
    if (excludeId) {
      const rows = db.prepare(
        "SELECT label FROM terminal_sessions WHERE workspace_path = ? AND type = 'shell' AND label IS NOT NULL AND id != ?"
      ).all(normalizedPath, excludeId) as Array<{ label: string }>;
      return rows.map(r => r.label);
    }
    const rows = db.prepare(
      "SELECT label FROM terminal_sessions WHERE workspace_path = ? AND type = 'shell' AND label IS NOT NULL"
    ).all(normalizedPath) as Array<{ label: string }>;
    return rows.map(r => r.label);
  } catch {
    return [];
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
 * Remove a terminal from the in-memory workspace registry.
 * Scans all workspaces to find and remove the terminal by its ID.
 * This is needed when a single terminal is killed (e.g. afx cleanup)
 * to keep the in-memory state consistent with SQLite.
 * Bugfix #290: afx cleanup didn't remove terminals from in-memory registry.
 */
export function removeTerminalFromRegistry(terminalId: string): void {
  for (const [, entry] of workspaceTerminals) {
    for (const [name, tid] of entry.architects) {
      if (tid === terminalId) {
        entry.architects.delete(name);
        return;
      }
    }
    for (const [builderId, tid] of entry.builders) {
      if (tid === terminalId) {
        entry.builders.delete(builderId);
        return;
      }
    }
    for (const [shellId, tid] of entry.shells) {
      if (tid === terminalId) {
        entry.shells.delete(shellId);
        return;
      }
    }
  }
}

/**
 * Delete all terminal sessions for a workspace from SQLite.
 * Normalizes path to ensure consistent cleanup regardless of how path was provided.
 */
export function deleteWorkspaceTerminalSessions(workspacePath: string): void {
  try {
    const normalizedPath = normalizeWorkspacePath(workspacePath);
    const db = getGlobalDb();

    // Delete both normalized and raw path to handle any inconsistencies
    db.prepare('DELETE FROM terminal_sessions WHERE workspace_path = ?').run(normalizedPath);
    if (normalizedPath !== workspacePath) {
      db.prepare('DELETE FROM terminal_sessions WHERE workspace_path = ?').run(workspacePath);
    }
  } catch (err) {
    _deps?.log('WARN', `Failed to delete workspace terminal sessions: ${(err as Error).message}`);
  }
}

/**
 * Get terminal sessions from SQLite for a workspace.
 * Normalizes path for consistent lookup.
 */
export function getTerminalSessionsForWorkspace(workspacePath: string): DbTerminalSession[] {
  try {
    const normalizedPath = normalizeWorkspacePath(workspacePath);
    const db = getGlobalDb();
    return db.prepare('SELECT * FROM terminal_sessions WHERE workspace_path = ?').all(normalizedPath) as DbTerminalSession[];
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
export function saveFileTab(id: string, workspacePath: string, filePath: string, createdAt: number): void {
  try {
    const normalizedPath = normalizeWorkspacePath(workspacePath);
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
 * Delete all file tabs for a workspace from SQLite and clear in-memory state.
 * Called when a workspace is stopped or fully cleaned up (Bugfix #474).
 */
export function deleteFileTabsForWorkspace(workspacePath: string): void {
  try {
    const normalizedPath = normalizeWorkspacePath(workspacePath);
    deleteFileTabsForWorkspaceFromDb(getGlobalDb(), normalizedPath);
    if (normalizedPath !== workspacePath) {
      deleteFileTabsForWorkspaceFromDb(getGlobalDb(), workspacePath);
    }
    // Clear in-memory file tabs
    const entry = workspaceTerminals.get(normalizedPath) || workspaceTerminals.get(workspacePath);
    if (entry?.fileTabs) {
      entry.fileTabs.clear();
    }
  } catch (err) {
    _deps?.log('WARN', `Failed to delete workspace file tabs: ${(err as Error).message}`);
  }
}

/**
 * Delete file tabs whose file_path is inside a given directory.
 * Used during builder cleanup to remove tabs pointing into a deleted worktree (Bugfix #474).
 * Also evicts matching entries from the in-memory registry.
 */
export function deleteFileTabsByPathPrefix(pathPrefix: string): number {
  try {
    const deleted = deleteFileTabsByPathPrefixFromDb(getGlobalDb(), pathPrefix);
    // Ensure trailing slash for boundary-safe in-memory matching
    const safePrefix = pathPrefix.endsWith('/') ? pathPrefix : pathPrefix + '/';
    // Evict matching entries from in-memory registries
    for (const [, entry] of workspaceTerminals) {
      if (entry.fileTabs) {
        for (const [id, tab] of entry.fileTabs) {
          if (tab.path.startsWith(safePrefix)) {
            entry.fileTabs.delete(id);
          }
        }
      }
    }
    return deleted;
  } catch (err) {
    _deps?.log('WARN', `Failed to delete file tabs by path prefix: ${(err as Error).message}`);
    return 0;
  }
}

/**
 * Load file tabs for a workspace from SQLite.
 * Thin wrapper around utils/file-tabs.ts with error handling and path normalization.
 */
export function loadFileTabsForWorkspace(workspacePath: string): Map<string, FileTab> {
  try {
    const normalizedPath = normalizeWorkspacePath(workspacePath);
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
  if (!_deps) {
    // Nothing to reconcile (e.g. a non-server context). Still release the
    // readiness barrier so handlers gating on it don't wait forever (#997).
    markStartupReconcileSettled();
    return;
  }

  _reconciling = true;
  try {
    await _reconcileTerminalSessionsInner();
  } finally {
    _reconciling = false;
    // #997: the startup reconcile has completed (or failed) — release request
    // handlers waiting on the readiness barrier. Idempotent: a later reconcile
    // call (none today, but defensively) is harmless.
    markStartupReconcileSettled();
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

  // Pre-filter: remove sessions with invalid workspace paths synchronously
  interface ProbeTask {
    dbSession: DbTerminalSession;
    restartOptions?: ReconnectRestartOptions;
  }
  const probeTasks: ProbeTask[] = [];

  for (const dbSession of shellperSessions) {
    const workspacePath = dbSession.workspace_path;

    // Skip sessions whose workspace path doesn't exist or is in temp directory
    if (!fs.existsSync(workspacePath)) {
      _deps.log('INFO', `Skipping shellper session ${dbSession.id} — workspace path no longer exists: ${workspacePath}`);
      if (dbSession.shellper_pid && processExists(dbSession.shellper_pid)) {
        try { process.kill(dbSession.shellper_pid, 'SIGTERM'); killed++; } catch { /* not killable */ }
      }
      db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbSession.id);
      cleaned++;
      continue;
    }
    const tmpDirs = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];
    if (tmpDirs.some(d => workspacePath === d || workspacePath.startsWith(d + '/'))) {
      _deps.log('INFO', `Skipping shellper session ${dbSession.id} — workspace is in temp directory: ${workspacePath}`);
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

    // Build restart options for architect sessions (synchronous, no I/O)
    let restartOptions: ReconnectRestartOptions | undefined;
    if (dbSession.type === 'architect') {
      let architectCmd = 'claude';
      try {
        const config = loadConfig(workspacePath);
        const shellArchitect = config.shell?.architect;
        if (typeof shellArchitect === 'string') architectCmd = shellArchitect;
        else if (Array.isArray(shellArchitect)) architectCmd = shellArchitect.join(' ');
      } catch { /* use default */ }
      const cmdParts = architectCmd.split(/\s+/);
      const cleanEnv = { ...process.env } as Record<string, string>;
      delete cleanEnv['CLAUDECODE'];
      // Spec 786 Phase 2: preserve architect identity across shellper auto-
      // restart. Without this, the new claude process would inherit Tower's
      // CODEV_ARCHITECT_NAME (or none), and builders spawned by a restarted
      // sibling would lose affinity to the sibling. The `|| 'main'` fallback
      // covers legacy rows where role_id is null (v13 backfill should have
      // populated them; this is belt-and-suspenders).
      const architectName = dbSession.role_id || 'main';
      cleanEnv['CODEV_ARCHITECT_NAME'] = architectName;
      try {
        // Issue #832: bake `--resume <storedId>` into the auto-restart args so a
        // claude crash inside a live shellper revives the SAME conversation (the
        // silent-context-loss path). The id was stored at the original spawn; a
        // legacy architect with none falls through to a fresh session, then self-
        // heals (the next spawn/revival stores an id). The minted id on the fresh
        // branch is not persisted here (the bake precedes the actual restart) —
        // fine, since post-#832 architects always carry a stored id and resume.
        const { args: architectArgs, env: harnessEnv, resumed, storedSessionId, fallback } =
          resolveArchitectRestart(workspacePath, architectName, cmdParts.slice(1));
        if (resumed && storedSessionId) {
          _deps.log('INFO', `Resuming architect '${architectName}' session ${storedSessionId.slice(0, 8)}… on restart in ${workspacePath}`);
        }
        restartOptions = {
          command: cmdParts[0],
          args: architectArgs,
          cwd: workspacePath,
          env: { ...cleanEnv, ...harnessEnv },
          restartDelay: 2000,
          maxRestarts: 50,
        };
        // Issue #1149: if the resumed session fast-fails at runtime (jsonl
        // vanished after the bake, or corrupt), degrade to a fresh launch
        // instead of burning all 50 restarts on identical args.
        if (resumed && storedSessionId && fallback) {
          restartOptions.crashLoopFallback = buildArchitectCrashLoopFallback({
            workspacePath,
            architectName,
            storedSessionId,
            fallback,
            baseEnv: cleanEnv,
            log: _deps.log,
          });
        }
      } catch (err) {
        _deps.log('WARN', `Harness resolution failed for workspace ${workspacePath}: ${err instanceof Error ? err.message : err}`);
        // Fall back to plain command without harness role-prompt args so the
        // session can still reconnect. `cleanEnv` still carries
        // CODEV_ARCHITECT_NAME (set above for Spec 786 Phase 2), so identity
        // is preserved even on harness failure.
        restartOptions = {
          command: cmdParts[0],
          args: cmdParts.slice(1),
          cwd: workspacePath,
          env: cleanEnv,
          restartDelay: 2000,
          maxRestarts: 50,
        };
      }
    }

    probeTasks.push({ dbSession, restartOptions });
  }

  // Probe shellper sockets in parallel with bounded concurrency (Spec 0122 Phase 2)
  const CONCURRENCY_LIMIT = 5;
  type ProbeResult = { dbSession: DbTerminalSession; client: import('../../terminal/shellper-client.js').IShellperClient | null; replayData: Buffer | null; restartOptions?: ReconnectRestartOptions };
  const probeResults: ProbeResult[] = [];

  for (let i = 0; i < probeTasks.length; i += CONCURRENCY_LIMIT) {
    const batch = probeTasks.slice(i, i + CONCURRENCY_LIMIT);
    const results = await Promise.allSettled(
      batch.map(async (task): Promise<ProbeResult> => {
        const client = await _deps!.shellperManager!.reconnectSession(
          task.dbSession.id,
          task.dbSession.shellper_socket!,
          task.dbSession.shellper_pid!,
          task.dbSession.shellper_start_time!,
          task.restartOptions,
        );
        if (!client) {
          return { dbSession: task.dbSession, client: null, replayData: null, restartOptions: task.restartOptions };
        }
        // #1198: the REPLAY frame often arrives in a separate socket read
        // after WELCOME, so a synchronous getReplayData() here raced it and
        // adopted terminals rendered blank until new output arrived. Wait
        // briefly for it. #1215: run this wait inside the same bounded-
        // concurrency batch as the connect, so waits for up to
        // CONCURRENCY_LIMIT sessions overlap instead of stacking in the
        // sequential loop below (worst case for a mostly-idle, pre-upgrade
        // fleet of shellpers was ~10s serialized; see waitForReplay() for
        // how the per-session cost itself is also bounded for legacy peers).
        const replayData = capRingSeed(await client.waitForReplay(), task.dbSession.id);
        return { dbSession: task.dbSession, client, replayData, restartOptions: task.restartOptions };
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        probeResults.push(result.value);
      } else {
        // Find the corresponding task for error logging
        const idx = results.indexOf(result);
        const task = batch[idx];
        _deps.log('WARN', `Failed to reconnect shellper session ${task.dbSession.id}: ${result.reason?.message ?? result.reason}`);
      }
    }
  }

  // Process probe results sequentially (shared state mutations)
  for (const { dbSession, client, replayData } of probeResults) {
    if (!client) {
      _deps.log('INFO', `Shellper session ${dbSession.id} is stale (PID/socket dead) — will clean up`);
      continue; // Will be cleaned up in Phase 2
    }

    const workspacePath = dbSession.workspace_path;
    const sessionCwd = dbSession.cwd ?? workspacePath;
    const label = dbSession.label || (dbSession.type === 'architect' ? 'Architect' : (dbSession.role_id || 'unknown'));

    // Create a PtySession backed by the reconnected shellper client.
    // Reuse the persisted terminal id (#991) so the session keeps its identity
    // across the restart — clients holding `/ws/terminal/<id>` reconnect to the
    // same valid url instead of a dead one. Use stored cwd (worktree path for
    // builders) instead of workspace_path (Bugfix #506).
    const session = manager.createSessionRaw({ label, cwd: sessionCwd, id: dbSession.id });
    const ptySession = manager.getSession(session.id);
    if (ptySession) {
      const shellperSessId = extractShellperSessionId(dbSession.shellper_socket) ?? dbSession.id;
      // replayData is only null when client is null (probe batch above),
      // which the `if (!client)` guard already excluded — fall back to
      // empty defensively rather than asserting.
      ptySession.attachShellper(client, replayData ?? Buffer.alloc(0), dbSession.shellper_pid!, shellperSessId);
      // Architect sessions have auto-restart — keep WebSocket clients connected on exit
      if (dbSession.type === 'architect') {
        ptySession.restartOnExit = true;
      }
    }

    // Register in workspaceTerminals Map
    const entry = getWorkspaceTerminalsEntry(workspacePath);
    if (dbSession.type === 'architect') {
      // Spec 755: role_id stores the architect's name. The v13 backfill
      // populates 'main' for legacy rows where role_id was null.
      entry.architects.set(dbSession.role_id || 'main', session.id);
    } else if (dbSession.type === 'builder') {
      entry.builders.set(dbSession.role_id || dbSession.id, session.id);
    } else if (dbSession.type === 'shell') {
      entry.shells.set(dbSession.role_id || dbSession.id, session.id);
    }

    // Refresh the SQLite row. The id is preserved (#991), so this re-saves the
    // session under the same terminal id with its refreshed shellper info.
    db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(dbSession.id);
    saveTerminalSession(session.id, workspacePath, dbSession.type, dbSession.role_id, dbSession.shellper_pid,
      dbSession.shellper_socket, dbSession.shellper_pid, dbSession.shellper_start_time, dbSession.label, sessionCwd);
    _deps.registerKnownWorkspace(workspacePath);

    // Clean up on exit (only fires for permanent death when restartOnExit is set)
    if (ptySession) {
      ptySession.on('exit', () => {
        const currentEntry = getWorkspaceTerminalsEntry(workspacePath);
        let exitedArchitectName: string | null = null;
        if (dbSession.type === 'architect') {
          // Spec 755: remove the entry whose terminalId matches session.id.
          for (const [name, tid] of currentEntry.architects) {
            if (tid === session.id) {
              exitedArchitectName = name;
              currentEntry.architects.delete(name);
              break;
            }
          }
        }
        deleteTerminalSession(session.id);
        // Spec 786 Phase 3 / OQ-B: delete the persisted architect row on
        // permanent exit; preserve on intentional stop. Symmetric with the
        // four exit handlers in tower-instances.ts.
        if (exitedArchitectName && !isIntentionallyStopping(workspacePath)) {
          try {
            setArchitectByName(workspacePath, exitedArchitectName, null);
          } catch { /* best-effort cleanup */ }
        }
      });
    }

    matchedSessionIds.add(dbSession.id);
    shellperReconnected++;
    _deps.log('INFO', `Reconnected shellper session → ${session.id} (${dbSession.type} for ${path.basename(workspacePath)})`);
  }

  // ---- Phase 2: Sweep stale SQLite rows ----
  for (const session of allDbSessions) {
    if (matchedSessionIds.has(session.id)) continue;

    const existing = manager.getSession(session.id);
    if (existing && existing.status !== 'exited') continue;

    // Stale row — kill orphaned process if any, then delete
    if (session.pid && processExists(session.pid)) {
      _deps.log('INFO', `Killing orphaned process: PID ${session.pid} (${session.type} for ${path.basename(session.workspace_path)})`);
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
 * Get terminal list for a workspace from tower's registry.
 * Phase 4 (Spec 0090): Tower manages terminals directly, no dashboard-server fetch.
 * Returns architect, builders, and shells with their URLs.
 */
export async function getTerminalsForWorkspace(
  workspacePath: string,
  proxyUrl: string
): Promise<{ terminals: TerminalEntry[] }> {
  const manager = getTerminalManager();
  const terminals: TerminalEntry[] = [];

  // Query SQLite first, then augment with shellper reconnection
  const dbSessions = getTerminalSessionsForWorkspace(workspacePath);

  // Use normalized path for cache consistency
  const normalizedPath = normalizeWorkspacePath(workspacePath);

  // Build a fresh entry from SQLite, then replace atomically to avoid
  // destroying in-memory state that was registered via POST /api/terminals.
  // Previous approach cleared the cache then rebuilt, which lost terminals
  // if their SQLite rows were deleted by external interference (e.g., tests).
  const freshEntry: WorkspaceTerminals = { architects: new Map(), builders: new Map(), shells: new Map(), fileTabs: new Map() };

  // Load file tabs from SQLite (persisted across restarts)
  const existingEntry = workspaceTerminals.get(normalizedPath);
  if (existingEntry && existingEntry.fileTabs.size > 0) {
    // Use in-memory state if already populated (avoids redundant DB reads)
    freshEntry.fileTabs = existingEntry.fileTabs;
  } else {
    freshEntry.fileTabs = loadFileTabsForWorkspace(workspacePath);
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
          try {
            const config = loadConfig(dbSession.workspace_path);
            const shellArchitect = config.shell?.architect;
            if (typeof shellArchitect === 'string') architectCmd = shellArchitect;
            else if (Array.isArray(shellArchitect)) architectCmd = shellArchitect.join(' ');
          } catch { /* use default */ }
          const cmdParts = architectCmd.split(/\s+/);
          const cleanEnv = { ...process.env } as Record<string, string>;
          delete cleanEnv['CLAUDECODE'];
          // Spec 786 Phase 2: preserve architect identity across shellper auto-
          // restart (see matching block in reconcileTerminalSessionsInner above).
          const architectName = dbSession.role_id || 'main';
          cleanEnv['CODEV_ARCHITECT_NAME'] = architectName;
          try {
            // Issue #832: revive the same conversation on auto-restart via the
            // stored session id (see matching block above).
            const { args: architectArgs, env: harnessEnv, resumed, storedSessionId, fallback } =
              resolveArchitectRestart(dbSession.workspace_path, architectName, cmdParts.slice(1));
            if (resumed && storedSessionId) {
              _deps.log('INFO', `Resuming architect '${architectName}' session ${storedSessionId.slice(0, 8)}… on reconnect in ${dbSession.workspace_path}`);
            }
            restartOptions = {
              command: cmdParts[0],
              args: architectArgs,
              cwd: dbSession.workspace_path,
              env: { ...cleanEnv, ...harnessEnv },
              restartDelay: 2000,
              maxRestarts: 50,
            };
            // Issue #1149: degrade a fast-failing resume to a fresh launch
            // (see matching block in reconcileTerminalSessionsInner above).
            if (resumed && storedSessionId && fallback) {
              restartOptions.crashLoopFallback = buildArchitectCrashLoopFallback({
                workspacePath: dbSession.workspace_path,
                architectName,
                storedSessionId,
                fallback,
                baseEnv: cleanEnv,
                log: _deps.log,
              });
            }
          } catch (err) {
            _deps.log('WARN', `Harness resolution failed for workspace ${dbSession.workspace_path}: ${err instanceof Error ? err.message : err}`);
            restartOptions = {
              command: cmdParts[0],
              args: cmdParts.slice(1),
              cwd: dbSession.workspace_path,
              env: cleanEnv,
              restartDelay: 2000,
              maxRestarts: 50,
            };
          }
        }

        _deps.log('INFO', `On-the-fly shellper reconnect for ${dbSession.id}`);
        const client = await _deps.shellperManager.reconnectSession(
          dbSession.id,
          dbSession.shellper_socket,
          dbSession.shellper_pid!,
          dbSession.shellper_start_time!,
          restartOptions,
        );
        if (client) {
          // #1198: wait for the REPLAY frame instead of racing it (see the
          // matching change in the startup adoption pass above).
          const replayData = capRingSeed(await client.waitForReplay(), dbSession.id);
          const label = dbSession.label || (dbSession.type === 'architect' ? 'Architect' : (dbSession.role_id || dbSession.id));
          // Reuse the persisted terminal id (#991) so the session keeps its
          // identity across the reconnect — clients holding `/ws/terminal/<id>`
          // stay valid. Use stored cwd (worktree path for builders) instead of
          // workspace_path (Bugfix #506).
          const newSession = manager.createSessionRaw({ label, cwd: dbSession.cwd ?? dbSession.workspace_path, id: dbSession.id });
          const ptySession = manager.getSession(newSession.id);
          if (ptySession) {
            const shellperSessId = extractShellperSessionId(dbSession.shellper_socket) ?? dbSession.id;
            ptySession.attachShellper(client, replayData, dbSession.shellper_pid!, shellperSessId);
            // Architect sessions have auto-restart — keep WebSocket clients connected on exit
            if (dbSession.type === 'architect') {
              ptySession.restartOnExit = true;
            }

            // Clean up on exit (only fires for permanent death when restartOnExit is set)
            ptySession.on('exit', () => {
              const currentEntry = getWorkspaceTerminalsEntry(dbSession.workspace_path);
              let exitedArchitectName: string | null = null;
              if (dbSession.type === 'architect') {
                // Spec 755: remove the entry whose terminalId matches newSession.id.
                for (const [name, tid] of currentEntry.architects) {
                  if (tid === newSession.id) {
                    exitedArchitectName = name;
                    currentEntry.architects.delete(name);
                    break;
                  }
                }
              }
              deleteTerminalSession(newSession.id);
              // Spec 786 Phase 3 / OQ-B: delete the persisted architect row on
              // permanent exit; preserve on intentional stop. Symmetric with
              // the five other exit handlers (4 in tower-instances.ts, 1 in
              // the reconciliation path above).
              if (exitedArchitectName && !isIntentionallyStopping(dbSession.workspace_path)) {
                try {
                  setArchitectByName(dbSession.workspace_path, exitedArchitectName, null);
                } catch { /* best-effort cleanup */ }
              }
            });
          }
          // Refresh the SQLite row under the same (preserved) id.
          deleteTerminalSession(dbSession.id);
          saveTerminalSession(newSession.id, dbSession.workspace_path, dbSession.type, dbSession.role_id, dbSession.shellper_pid,
            dbSession.shellper_socket, dbSession.shellper_pid, dbSession.shellper_start_time, dbSession.label, dbSession.cwd);
          dbSession.id = newSession.id;
          session = manager.getSession(newSession.id);
          _deps.log('INFO', `On-the-fly reconnect succeeded for ${newSession.id} (id preserved)`);
        }
      } catch (err) {
        _deps.log('WARN', `On-the-fly reconnect failed for ${dbSession.id}: ${(err as Error).message}`);
      }
    }

    if (!session) {
      // Stale row, nothing to reconnect — clean up
      deleteTerminalSession(dbSession.id);
      continue;
    }

    if (dbSession.type === 'architect') {
      // Spec 755: role_id stores the architect's name; v13 backfill ensures
      // legacy null role_ids become 'main' before this point. We register
      // every named architect into freshEntry.architects; the actual emission
      // of one terminal entry per architect (with tab id `architect` for main
      // and `architect:<name>` for siblings) happens in the dedicated loop
      // after this main pass (Spec 786 Phase 5 — replaces the Spec 755 v1
      // single-entry collapse).
      const architectName = dbSession.role_id || 'main';
      freshEntry.architects.set(architectName, dbSession.id);
    } else if (dbSession.type === 'builder') {
      const builderId = dbSession.role_id || dbSession.id;
      freshEntry.builders.set(builderId, dbSession.id);
      terminals.push({
        type: 'builder',
        id: builderId,
        label: builderId,
        url: `${proxyUrl}?tab=${builderId}`,
        active: true,
      });
    } else if (dbSession.type === 'shell') {
      const shellId = dbSession.role_id || dbSession.id;
      freshEntry.shells.set(shellId, dbSession.id);
      const shellLabel = session?.label || dbSession.label || `Shell ${shellId.replace('shell-', '')}`;
      terminals.push({
        type: 'shell',
        id: shellId,
        label: shellLabel,
        url: `${proxyUrl}?tab=${shellId}`,
        active: true,
      });
    }
  }

  // Also merge in-memory entries that may not be in SQLite yet
  // (e.g., registered via POST /api/terminals but SQLite row was lost)
  if (existingEntry) {
    // Spec 755: merge each named architect entry the fresh build missed.
    // Note: we register every architect but defer emitting the Architect
    // terminal entry to the single post-loop push below.
    for (const [name, terminalId] of existingEntry.architects) {
      if (freshEntry.architects.has(name)) continue;
      const session = manager.getSession(terminalId);
      if (session && session.status === 'running') {
        freshEntry.architects.set(name, terminalId);
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
            label: builderId,
            url: `${proxyUrl}?tab=${builderId}`,
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
            label: session.label || `Shell ${shellId.replace('shell-', '')}`,
            url: `${proxyUrl}?tab=${shellId}`,
            active: true,
          });
        }
      }
    }
  }

  // Spec 786 Phase 5: emit ONE entry per registered architect. Replaces the
  // Spec 755 v1 collapse that emitted a single "Architect" entry regardless of
  // how many architects existed. The Spec 761 `architectTabId` convention is
  // preserved: `main` always gets the bare `'architect'` id (for deep-link
  // stability), siblings get `architect:<name>`. Iteration order is `main`
  // first (sorted to handle the case where `launchInstance`'s sibling
  // reconciliation could otherwise insert siblings before main).
  const architectNames = [...freshEntry.architects.keys()].sort((a, b) => {
    if (a === 'main') return -1;
    if (b === 'main') return 1;
    return 0;
  });
  for (const architectName of architectNames) {
    const terminalId = freshEntry.architects.get(architectName)!;
    const session = manager.getSession(terminalId);
    if (!session) continue;
    const tabId = architectName === 'main' ? 'architect' : `architect:${architectName}`;
    terminals.push({
      type: 'architect',
      id: tabId,
      label: architectName,
      url: `${proxyUrl}?tab=${tabId}`,
      active: true,
      // Spec 786 Phase 5: extra fields for `afx status` and other enumerators.
      architectName,
      pid: session.pid || undefined,
      // No port assigned to architect terminals today; preserved as an extension
      // point for future per-architect HTTP surfaces.
      // Spec 786 Phase 5: the actual PtySession id (the `id` above is the tab
      // id per Spec 761). Surfaced so `afx status` can show terminal-attach-
      // ready identifiers.
      terminalId,
    });
  }

  // Atomically replace the cache entry
  workspaceTerminals.set(normalizedPath, freshEntry);

  return { terminals };
}
