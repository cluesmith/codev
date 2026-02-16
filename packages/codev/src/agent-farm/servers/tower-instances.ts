/**
 * Workspace instance lifecycle for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 3
 *
 * Contains: instance discovery (getInstances), launch/stop lifecycle,
 * known workspace registration, and directory suggestion autocomplete.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';

const execAsync = promisify(exec);
import { getGlobalDb } from '../db/index.js';
import type { GateStatus } from '../utils/gate-status.js';
import type { TerminalManager } from '../../terminal/pty-manager.js';
import type { SessionManager } from '../../terminal/session-manager.js';
import { defaultSessionOptions } from '../../terminal/index.js';
import type { WorkspaceTerminals, TerminalEntry, InstanceStatus } from './tower-types.js';
import {
  normalizeWorkspacePath,
  getWorkspaceName,
  isTempDirectory,
  buildArchitectArgs,
} from './tower-utils.js';

// ============================================================================
// Dependency interface
// ============================================================================

/** Dependencies injected by the orchestrator (tower-server.ts) */
export interface InstanceDeps {
  log: (level: 'INFO' | 'ERROR' | 'WARN', msg: string) => void;
  workspaceTerminals: Map<string, WorkspaceTerminals>;
  getTerminalManager: () => TerminalManager;
  shellperManager: SessionManager | null;
  /** Get or create a workspace's terminal registry entry */
  getWorkspaceTerminalsEntry: (workspacePath: string) => WorkspaceTerminals;
  /** Persist a terminal session row to SQLite */
  saveTerminalSession: (
    id: string, workspacePath: string, type: 'architect' | 'builder' | 'shell',
    roleId: string | null, pid: number | null,
    shellperSocket?: string | null, shellperPid?: number | null, shellperStartTime?: number | null,
  ) => void;
  /** Delete a terminal session row from SQLite */
  deleteTerminalSession: (id: string) => void;
  /** Delete all terminal session rows for a workspace */
  deleteWorkspaceTerminalSessions: (workspacePath: string) => void;
  /** Get terminal list + gate status for a workspace (stays in tower-server.ts until Phase 4) */
  getTerminalsForWorkspace: (
    workspacePath: string, proxyUrl: string,
  ) => Promise<{ terminals: TerminalEntry[]; gateStatus: GateStatus }>;
}

// ============================================================================
// Module-private state
// ============================================================================

let _deps: InstanceDeps | null = null;

// ============================================================================
// Public lifecycle
// ============================================================================

/** Initialize the instances module with dependencies. */
export function initInstances(deps: InstanceDeps): void {
  _deps = deps;
}

/** Tear down the instances module. */
export function shutdownInstances(): void {
  _deps = null;
}

// ============================================================================
// Known workspace registration
// ============================================================================

/**
 * Register a workspace in the known_workspaces table so it persists across restarts
 * even when all terminal sessions are gone.
 */
export function registerKnownWorkspace(workspacePath: string): void {
  try {
    const db = getGlobalDb();
    db.prepare(`
      INSERT INTO known_workspaces (workspace_path, name, last_launched_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(workspace_path) DO UPDATE SET last_launched_at = datetime('now')
    `).run(workspacePath, path.basename(workspacePath));
  } catch {
    // Table may not exist yet (pre-migration)
  }
}

/**
 * Get all known workspace paths from known_workspaces, terminal_sessions, and in-memory cache.
 */
export function getKnownWorkspacePaths(): string[] {
  const workspacePaths = new Set<string>();

  // From known_workspaces table (persists even after all terminals are killed)
  try {
    const db = getGlobalDb();
    const workspaces = db.prepare('SELECT workspace_path FROM known_workspaces').all() as { workspace_path: string }[];
    for (const w of workspaces) {
      workspacePaths.add(w.workspace_path);
    }
  } catch {
    // Table may not exist yet
  }

  // From terminal_sessions table (catches any missed by known_workspaces)
  try {
    const db = getGlobalDb();
    const sessions = db.prepare('SELECT DISTINCT workspace_path FROM terminal_sessions').all() as { workspace_path: string }[];
    for (const s of sessions) {
      workspacePaths.add(s.workspace_path);
    }
  } catch {
    // Table may not exist yet
  }

  // From in-memory cache (includes workspaces activated this session)
  if (_deps) {
    for (const [workspacePath] of _deps.workspaceTerminals) {
      workspacePaths.add(workspacePath);
    }
  }

  return Array.from(workspacePaths);
}

// ============================================================================
// Instance discovery
// ============================================================================

/**
 * Get all instances with their status.
 */
export async function getInstances(): Promise<InstanceStatus[]> {
  if (!_deps) return []; // Module not yet initialized (startup window)

  const knownPaths = getKnownWorkspacePaths();
  const instances: InstanceStatus[] = [];

  // Build a lookup of last_launched_at from known_workspaces
  const lastLaunchedMap = new Map<string, string>();
  try {
    const db = getGlobalDb();
    const rows = db.prepare('SELECT workspace_path, last_launched_at FROM known_workspaces').all() as { workspace_path: string; last_launched_at: string }[];
    for (const row of rows) {
      lastLaunchedMap.set(row.workspace_path, row.last_launched_at);
    }
  } catch {
    // Table may not exist yet (pre-migration)
  }

  for (const workspacePath of knownPaths) {
    // Skip builder worktrees - they're managed by their parent workspace
    if (workspacePath.includes('/.builders/')) {
      continue;
    }

    // Skip workspaces in temp directories (e.g. test artifacts) or whose directories no longer exist
    if (!workspacePath.startsWith('remote:')) {
      if (!fs.existsSync(workspacePath)) {
        continue;
      }
      if (isTempDirectory(workspacePath)) {
        continue;
      }
    }

    // Encode workspace path for proxy URL
    const encodedPath = Buffer.from(workspacePath).toString('base64url');
    const proxyUrl = `/workspace/${encodedPath}/`;

    // Get terminals and gate status from tower's registry
    // Phase 4 (Spec 0090): Tower manages terminals directly - no separate dashboard server
    const { terminals, gateStatus } = await _deps.getTerminalsForWorkspace(workspacePath, proxyUrl);

    // Workspace is active if it has any terminals (Phase 4: no port check needed)
    const isActive = terminals.length > 0;

    instances.push({
      workspacePath,
      workspaceName: getWorkspaceName(workspacePath),
      running: isActive,
      proxyUrl,
      architectUrl: `${proxyUrl}?tab=architect`,
      terminals,
      gateStatus,
      lastUsed: lastLaunchedMap.get(workspacePath),
    });
  }

  // Sort: running first, then by workspace name
  instances.sort((a, b) => {
    if (a.running !== b.running) {
      return a.running ? -1 : 1;
    }
    return a.workspaceName.localeCompare(b.workspaceName);
  });

  return instances;
}

// ============================================================================
// Directory suggestions (pure — no module state)
// ============================================================================

/**
 * Get directory suggestions for autocomplete.
 */
export async function getDirectorySuggestions(inputPath: string): Promise<{ path: string; isWorkspace: boolean }[]> {
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
  const suggestions: { path: string; isWorkspace: boolean }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue; // Skip hidden directories

    const name = entry.name.toLowerCase();
    if (prefix && !name.startsWith(prefix)) continue;

    const fullPath = path.join(dirToList, entry.name);
    const isWorkspace = fs.existsSync(path.join(fullPath, 'codev'));

    suggestions.push({ path: fullPath, isWorkspace });
  }

  // Sort: workspaces first, then alphabetically
  suggestions.sort((a, b) => {
    if (a.isWorkspace !== b.isWorkspace) {
      return a.isWorkspace ? -1 : 1;
    }
    return a.path.localeCompare(b.path);
  });

  // Limit to 20 suggestions
  return suggestions.slice(0, 20);
}

// ============================================================================
// Instance lifecycle
// ============================================================================

/**
 * Launch a new agent-farm instance.
 * Phase 4 (Spec 0090): Tower manages terminals directly, no dashboard-server.
 * Auto-adopts non-codev directories and creates architect terminal.
 */
export async function launchInstance(workspacePath: string): Promise<{ success: boolean; error?: string; adopted?: boolean }> {
  if (!_deps) return { success: false, error: 'Tower is still starting up. Try again shortly.' };

  // Validate path exists
  if (!fs.existsSync(workspacePath)) {
    return { success: false, error: `Path does not exist: ${workspacePath}` };
  }

  // Validate it's a directory
  const stat = fs.statSync(workspacePath);
  if (!stat.isDirectory()) {
    return { success: false, error: `Not a directory: ${workspacePath}` };
  }

  // Auto-adopt non-codev directories
  const codevDir = path.join(workspacePath, 'codev');
  let adopted = false;
  if (!fs.existsSync(codevDir)) {
    try {
      // Run codev adopt --yes to set up the workspace
      await execAsync('npx codev adopt --yes', {
        cwd: workspacePath,
        timeout: 30000,
      });
      adopted = true;
      _deps.log('INFO', `Auto-adopted codev in: ${workspacePath}`);
    } catch (err) {
      return { success: false, error: `Failed to adopt codev: ${(err as Error).message}` };
    }
  }

  // Phase 4 (Spec 0090): Tower manages terminals directly
  // No dashboard-server spawning - tower handles everything
  try {
    // Ensure workspace has port allocation
    const resolvedPath = fs.realpathSync(workspacePath);

    // Persist in known_workspaces so the workspace survives terminal cleanup
    registerKnownWorkspace(resolvedPath);

    // Initialize workspace terminal entry
    const entry = _deps.getWorkspaceTerminalsEntry(resolvedPath);

    // Create architect terminal if not already present
    if (!entry.architect) {
      const manager = _deps.getTerminalManager();

      // Read af-config.json to get the architect command
      let architectCmd = 'claude';
      const configPath = path.join(workspacePath, 'af-config.json');
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
        // Parse command string to separate command and args, inject role prompt
        const cmdParts = architectCmd.split(/\s+/);
        const cmd = cmdParts[0];
        const cmdArgs = buildArchitectArgs(cmdParts.slice(1), workspacePath);

        // Build env with CLAUDECODE removed so spawned Claude processes
        // don't detect a nested session
        const cleanEnv = { ...process.env } as Record<string, string>;
        delete cleanEnv['CLAUDECODE'];

        // Try shellper first for persistent session with auto-restart
        let shellperCreated = false;
        if (_deps.shellperManager) {
          try {
            const sessionId = crypto.randomUUID();
            const client = await _deps.shellperManager.createSession({
              sessionId,
              command: cmd,
              args: cmdArgs,
              cwd: workspacePath,
              env: cleanEnv,
              ...defaultSessionOptions({ restartOnExit: true, restartDelay: 2000, maxRestarts: 50 }),
            });

            // Get replay data and shellper info
            const replayData = client.getReplayData() ?? Buffer.alloc(0);
            const shellperInfo = _deps.shellperManager.getSessionInfo(sessionId)!;

            // Create a PtySession backed by the shellper client
            const session = manager.createSessionRaw({
              label: 'Architect',
              cwd: workspacePath,
            });
            const ptySession = manager.getSession(session.id);
            if (ptySession) {
              ptySession.attachShellper(client, replayData, shellperInfo.pid, sessionId);
            }

            entry.architect = session.id;
            _deps.saveTerminalSession(session.id, resolvedPath, 'architect', null, shellperInfo.pid,
              shellperInfo.socketPath, shellperInfo.pid, shellperInfo.startTime);

            // Clean up cache/SQLite when the shellper session exits
            if (ptySession) {
              ptySession.on('exit', (exitCode?: number, signal?: number | string | null) => {
                const currentEntry = _deps!.getWorkspaceTerminalsEntry(resolvedPath);
                if (currentEntry.architect === session.id) {
                  currentEntry.architect = undefined;
                }
                _deps!.deleteTerminalSession(session.id);
                _deps!.log('INFO', `Architect shellper session exited for ${workspacePath} (code=${exitCode ?? null}, signal=${signal ?? null})`);
              });
            }

            shellperCreated = true;
            _deps.log('INFO', `Created shellper-backed architect session for workspace: ${workspacePath}`);
          } catch (shellperErr) {
            _deps.log('WARN', `Shellper creation failed for architect, falling back: ${(shellperErr as Error).message}`);
          }
        }

        // Fallback: non-persistent session (graceful degradation per plan)
        // Shellper is the only persistence backend for new sessions.
        if (!shellperCreated) {
          const session = await manager.createSession({
            command: cmd,
            args: cmdArgs,
            cwd: workspacePath,
            label: 'Architect',
            env: cleanEnv,
          });

          entry.architect = session.id;
          _deps.saveTerminalSession(session.id, resolvedPath, 'architect', null, session.pid);

          const ptySession = manager.getSession(session.id);
          if (ptySession) {
            ptySession.on('exit', () => {
              const currentEntry = _deps!.getWorkspaceTerminalsEntry(resolvedPath);
              if (currentEntry.architect === session.id) {
                currentEntry.architect = undefined;
              }
              _deps!.deleteTerminalSession(session.id);
              _deps!.log('INFO', `Architect pty exited for ${workspacePath}`);
            });
          }

          _deps.log('WARN', `Architect terminal for ${workspacePath} is non-persistent (shellper unavailable)`);
        }

        _deps.log('INFO', `Created architect terminal for workspace: ${workspacePath}`);
      } catch (err) {
        _deps.log('WARN', `Failed to create architect terminal: ${(err as Error).message}`);
        // Don't fail the launch - workspace is still active, just without architect
      }
    }

    return { success: true, adopted };
  } catch (err) {
    return { success: false, error: `Failed to launch: ${(err as Error).message}` };
  }
}

/**
 * Kill a terminal session, including its shellper auto-restart if applicable.
 * For shellper-backed sessions, calls SessionManager.killSession() which clears
 * the restart timer and removes the session before sending SIGTERM, preventing
 * the shellper from auto-restarting the process.
 */
export async function killTerminalWithShellper(manager: TerminalManager, terminalId: string): Promise<boolean> {
  if (!_deps) return false;

  const session = manager.getSession(terminalId);
  if (!session) return false;

  // If shellper-backed, disable auto-restart via SessionManager before killing the PtySession
  if (session.shellperBacked && session.shellperSessionId && _deps.shellperManager) {
    await _deps.shellperManager.killSession(session.shellperSessionId);
  }

  return manager.killSession(terminalId);
}

/**
 * Stop an agent-farm instance by killing all its terminals.
 * Phase 4 (Spec 0090): Tower manages terminals directly.
 */
export async function stopInstance(workspacePath: string): Promise<{ success: boolean; error?: string; stopped: number[] }> {
  if (!_deps) return { success: false, error: 'Tower is still starting up. Try again shortly.', stopped: [] };

  const stopped: number[] = [];
  const manager = _deps.getTerminalManager();

  // Resolve symlinks for consistent lookup
  let resolvedPath = workspacePath;
  try {
    if (fs.existsSync(workspacePath)) {
      resolvedPath = fs.realpathSync(workspacePath);
    }
  } catch {
    // Ignore - use original path
  }

  // Get workspace terminals
  const entry = _deps.workspaceTerminals.get(resolvedPath) || _deps.workspaceTerminals.get(workspacePath);

  if (entry) {
    // Kill architect (disable shellper auto-restart if applicable)
    if (entry.architect) {
      const session = manager.getSession(entry.architect);
      if (session) {
        await killTerminalWithShellper(manager, entry.architect);
        stopped.push(session.pid);
      }
    }

    // Kill all shells (disable shellper auto-restart if applicable)
    for (const terminalId of entry.shells.values()) {
      const session = manager.getSession(terminalId);
      if (session) {
        await killTerminalWithShellper(manager, terminalId);
        stopped.push(session.pid);
      }
    }

    // Kill all builders (disable shellper auto-restart if applicable)
    for (const terminalId of entry.builders.values()) {
      const session = manager.getSession(terminalId);
      if (session) {
        await killTerminalWithShellper(manager, terminalId);
        stopped.push(session.pid);
      }
    }

    // Clear workspace from registry
    _deps.workspaceTerminals.delete(resolvedPath);
    _deps.workspaceTerminals.delete(workspacePath);

    // TICK-001: Delete all terminal sessions from SQLite
    _deps.deleteWorkspaceTerminalSessions(resolvedPath);
    if (resolvedPath !== workspacePath) {
      _deps.deleteWorkspaceTerminalSessions(workspacePath);
    }
  }

  if (stopped.length === 0) {
    return { success: true, error: 'No terminals found to stop', stopped };
  }

  return { success: true, stopped };
}
