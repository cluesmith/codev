/**
 * Project instance lifecycle for tower server.
 * Spec 0105: Tower Server Decomposition — Phase 3
 *
 * Contains: instance discovery (getInstances), launch/stop lifecycle,
 * known project registration, and directory suggestion autocomplete.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { getGlobalDb } from '../db/index.js';
import type { GateStatus } from '../utils/gate-status.js';
import type { TerminalManager } from '../../terminal/pty-manager.js';
import type { SessionManager } from '../../terminal/session-manager.js';
import type { ProjectTerminals, TerminalEntry, InstanceStatus } from './tower-types.js';
import {
  normalizeProjectPath,
  getProjectName,
  isTempDirectory,
  buildArchitectArgs,
} from './tower-utils.js';

// ============================================================================
// Dependency interface
// ============================================================================

/** Dependencies injected by the orchestrator (tower-server.ts) */
export interface InstanceDeps {
  log: (level: 'INFO' | 'ERROR' | 'WARN', msg: string) => void;
  projectTerminals: Map<string, ProjectTerminals>;
  getTerminalManager: () => TerminalManager;
  shellperManager: SessionManager | null;
  /** Get or create a project's terminal registry entry */
  getProjectTerminalsEntry: (projectPath: string) => ProjectTerminals;
  /** Persist a terminal session row to SQLite */
  saveTerminalSession: (
    id: string, projectPath: string, type: 'architect' | 'builder' | 'shell',
    roleId: string | null, pid: number | null,
    shellperSocket?: string | null, shellperPid?: number | null, shellperStartTime?: number | null,
  ) => void;
  /** Delete a terminal session row from SQLite */
  deleteTerminalSession: (id: string) => void;
  /** Delete all terminal session rows for a project */
  deleteProjectTerminalSessions: (projectPath: string) => void;
  /** Get terminal list + gate status for a project (stays in tower-server.ts until Phase 4) */
  getTerminalsForProject: (
    projectPath: string, proxyUrl: string,
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
// Known project registration
// ============================================================================

/**
 * Register a project in the known_projects table so it persists across restarts
 * even when all terminal sessions are gone.
 */
export function registerKnownProject(projectPath: string): void {
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
 * Get all known project paths from known_projects, terminal_sessions, and in-memory cache.
 */
export function getKnownProjectPaths(): string[] {
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
  if (_deps) {
    for (const [projectPath] of _deps.projectTerminals) {
      projectPaths.add(projectPath);
    }
  }

  return Array.from(projectPaths);
}

// ============================================================================
// Instance discovery
// ============================================================================

/**
 * Get all instances with their status.
 */
export async function getInstances(): Promise<InstanceStatus[]> {
  if (!_deps) return []; // Module not yet initialized (startup window)

  const knownPaths = getKnownProjectPaths();
  const instances: InstanceStatus[] = [];

  // Build a lookup of last_launched_at from known_projects
  const lastLaunchedMap = new Map<string, string>();
  try {
    const db = getGlobalDb();
    const rows = db.prepare('SELECT project_path, last_launched_at FROM known_projects').all() as { project_path: string; last_launched_at: string }[];
    for (const row of rows) {
      lastLaunchedMap.set(row.project_path, row.last_launched_at);
    }
  } catch {
    // Table may not exist yet (pre-migration)
  }

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
    const { terminals, gateStatus } = await _deps.getTerminalsForProject(projectPath, proxyUrl);

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
      lastUsed: lastLaunchedMap.get(projectPath),
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

// ============================================================================
// Directory suggestions (pure — no module state)
// ============================================================================

/**
 * Get directory suggestions for autocomplete.
 */
export async function getDirectorySuggestions(inputPath: string): Promise<{ path: string; isProject: boolean }[]> {
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

// ============================================================================
// Instance lifecycle
// ============================================================================

/**
 * Launch a new agent-farm instance.
 * Phase 4 (Spec 0090): Tower manages terminals directly, no dashboard-server.
 * Auto-adopts non-codev directories and creates architect terminal.
 */
export async function launchInstance(projectPath: string): Promise<{ success: boolean; error?: string; adopted?: boolean }> {
  if (!_deps) return { success: false, error: 'Tower is still starting up. Try again shortly.' };

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
      _deps.log('INFO', `Auto-adopted codev in: ${projectPath}`);
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
    const entry = _deps.getProjectTerminalsEntry(resolvedPath);

    // Create architect terminal if not already present
    if (!entry.architect) {
      const manager = _deps.getTerminalManager();

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
        // Parse command string to separate command and args, inject role prompt
        const cmdParts = architectCmd.split(/\s+/);
        const cmd = cmdParts[0];
        const cmdArgs = buildArchitectArgs(cmdParts.slice(1), projectPath);

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
              cwd: projectPath,
              env: cleanEnv,
              cols: 200,
              rows: 50,
              restartOnExit: true,
              restartDelay: 2000,
              maxRestarts: 50,
            });

            // Get replay data and shellper info
            const replayData = client.getReplayData() ?? Buffer.alloc(0);
            const shellperInfo = _deps.shellperManager.getSessionInfo(sessionId)!;

            // Create a PtySession backed by the shellper client
            const session = manager.createSessionRaw({
              label: 'Architect',
              cwd: projectPath,
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
              ptySession.on('exit', () => {
                const currentEntry = _deps!.getProjectTerminalsEntry(resolvedPath);
                if (currentEntry.architect === session.id) {
                  currentEntry.architect = undefined;
                }
                _deps!.deleteTerminalSession(session.id);
                _deps!.log('INFO', `Architect shellper session exited for ${projectPath}`);
              });
            }

            shellperCreated = true;
            _deps.log('INFO', `Created shellper-backed architect session for project: ${projectPath}`);
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
            cwd: projectPath,
            label: 'Architect',
            env: cleanEnv,
          });

          entry.architect = session.id;
          _deps.saveTerminalSession(session.id, resolvedPath, 'architect', null, session.pid);

          const ptySession = manager.getSession(session.id);
          if (ptySession) {
            ptySession.on('exit', () => {
              const currentEntry = _deps!.getProjectTerminalsEntry(resolvedPath);
              if (currentEntry.architect === session.id) {
                currentEntry.architect = undefined;
              }
              _deps!.deleteTerminalSession(session.id);
              _deps!.log('INFO', `Architect pty exited for ${projectPath}`);
            });
          }

          _deps.log('WARN', `Architect terminal for ${projectPath} is non-persistent (shellper unavailable)`);
        }

        _deps.log('INFO', `Created architect terminal for project: ${projectPath}`);
      } catch (err) {
        _deps.log('WARN', `Failed to create architect terminal: ${(err as Error).message}`);
        // Don't fail the launch - project is still active, just without architect
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
export async function stopInstance(projectPath: string): Promise<{ success: boolean; error?: string; stopped: number[] }> {
  if (!_deps) return { success: false, error: 'Tower is still starting up. Try again shortly.', stopped: [] };

  const stopped: number[] = [];
  const manager = _deps.getTerminalManager();

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
  const entry = _deps.projectTerminals.get(resolvedPath) || _deps.projectTerminals.get(projectPath);

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

    // Clear project from registry
    _deps.projectTerminals.delete(resolvedPath);
    _deps.projectTerminals.delete(projectPath);

    // TICK-001: Delete all terminal sessions from SQLite
    _deps.deleteProjectTerminalSessions(resolvedPath);
    if (resolvedPath !== projectPath) {
      _deps.deleteProjectTerminalSessions(projectPath);
    }
  }

  if (stopped.length === 0) {
    return { success: true, error: 'No terminals found to stop', stopped };
  }

  return { success: true, stopped };
}
