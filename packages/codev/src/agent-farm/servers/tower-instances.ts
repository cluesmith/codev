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
import { encodeWorkspacePath } from '../lib/tower-client.js';
import { loadConfig } from '../../lib/config.js';

const execAsync = promisify(exec);
import { getGlobalDb } from '../db/index.js';
import type { TerminalManager } from '../../terminal/pty-manager.js';
import type { SessionManager } from '../../terminal/session-manager.js';
import { defaultSessionOptions } from '../../terminal/index.js';
import type { TerminalType } from '@cluesmith/codev-core/tower-client';
import type { WorkspaceTerminals, TerminalEntry, InstanceStatus } from './tower-types.js';
import {
  normalizeWorkspacePath,
  getWorkspaceName,
  isTempDirectory,
  resolveArchitectLaunch,
} from './tower-utils.js';
import {
  autoNumberArchitectName,
  validateArchitectName,
  DEFAULT_ARCHITECT_NAME,
} from '../utils/architect-name.js';
import { setArchitect, setArchitectByName, getArchitects, getArchitectByName } from '../state.js';
import { findLatestSessionId } from '../utils/claude-session-discovery.js';

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
    id: string, workspacePath: string, type: TerminalType,
    roleId: string | null, pid: number | null,
    shellperSocket?: string | null, shellperPid?: number | null, shellperStartTime?: number | null,
    label?: string | null, cwd?: string | null,
  ) => void;
  /** Delete a terminal session row from SQLite */
  deleteTerminalSession: (id: string) => void;
  /** Delete all terminal session rows for a workspace */
  deleteWorkspaceTerminalSessions: (workspacePath: string) => void;
  /** Delete all file tabs for a workspace (Bugfix #474) */
  deleteFileTabsForWorkspace: (workspacePath: string) => void;
  /** Get terminal list for a workspace */
  getTerminalsForWorkspace: (
    workspacePath: string, proxyUrl: string,
  ) => Promise<{ terminals: TerminalEntry[] }>;
}

// ============================================================================
// Module-private state
// ============================================================================

let _deps: InstanceDeps | null = null;

/**
 * Spec 786 Phase 3: workspaces currently mid-`stopInstance` shutdown.
 *
 * When a workspace is added to this set, the architect exit handlers (here and
 * in `tower-terminals.ts`) skip deleting the architect's `state.db.architect`
 * row — preserving the registration so the architect survives `afx workspace
 * stop` + `start` and is re-spawned by `launchInstance`'s sibling reconciliation
 * loop. Permanent exit (max-restart exhaustion, explicit `remove-architect`)
 * runs WITHOUT the workspace being in this set, so OQ-B's auto-delete behaviour
 * is preserved.
 *
 * `stopInstance` adds to the set before iterating kills and removes in a
 * `finally` block so the flag is always cleared even on error.
 *
 * Workspace paths are stored as resolved (realpath) paths to match the resolution
 * already done by `stopInstance` and the exit handlers.
 */
const intentionallyStopping = new Set<string>();

/**
 * Spec 786 Phase 3: is the workspace currently mid-graceful-stop?
 * Used by exit handlers (here AND in `tower-terminals.ts`) to decide whether to
 * delete the architect's persisted row. See `intentionallyStopping` above.
 *
 * Exported so `tower-terminals.ts`'s reconciliation exit handler can call it.
 */
export function isIntentionallyStopping(workspacePath: string): boolean {
  return intentionallyStopping.has(workspacePath);
}

/**
 * Spec 786 Phase 3 / PR iter-2 race-fix: await a terminal's `'exit'` event
 * with a timeout safety so callers (`stopInstance`, `removeArchitect`) can
 * ensure the cascaded exit handler has finished BEFORE the
 * `intentionallyStopping` flag is cleared.
 *
 * Why this exists: `killTerminalWithShellper` returns after sending SIGTERM,
 * not after the process is reaped. node-pty's 'exit' event fires later, on
 * its own tick. Without this await, the `finally` block in `stopInstance`
 * clears the flag before the exit handler runs — the handler then reads
 * `isIntentionallyStopping === false` and incorrectly deletes the persisted
 * architect row. Unit tests don't catch it because they mock timing.
 *
 * The timeout (5s) is belt-and-suspenders: if 'exit' never fires (e.g.
 * because the session was already gone), the promise still resolves so we
 * don't block the stop indefinitely.
 */
export function waitForTerminalExit(manager: TerminalManager, terminalId: string, timeoutMs = 5000): Promise<void> {
  const session = manager.getSession(terminalId);
  // Defensive: if the session is gone or doesn't look like an EventEmitter
  // (e.g. a test stub), there's nothing to wait for — resolve immediately so
  // callers aren't blocked.
  if (!session || typeof (session as { once?: unknown }).once !== 'function') {
    return Promise.resolve();
  }
  // The session may have already exited before we attach the listener below.
  // `once('exit')` only catches *future* emissions, so a session that already
  // fired 'exit' would otherwise wait out the full safety timeout. Bugfix #905
  // made shellper exits propagate earlier (EXIT is now replayed to clients that
  // connect after the PTY exits), which surfaced this: short-circuit instead.
  if ((session as { status?: string }).status === 'exited') {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    session.once('exit', finish);
    setTimeout(finish, timeoutMs);
  });
}

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
    const encodedPath = encodeWorkspacePath(workspacePath);
    const proxyUrl = `/workspace/${encodedPath}/`;

    // Get terminals from tower's registry
    // Phase 4 (Spec 0090): Tower manages terminals directly - no separate dashboard server
    const { terminals } = await _deps.getTerminalsForWorkspace(workspacePath, proxyUrl);

    // Workspace is active if it has any terminals (Phase 4: no port check needed)
    const isActive = terminals.length > 0;

    instances.push({
      workspacePath,
      workspaceName: getWorkspaceName(workspacePath),
      running: isActive,
      proxyUrl,
      architectUrl: `${proxyUrl}?tab=architect`,
      terminals,
      lastUsed: lastLaunchedMap.get(workspacePath),
    });
  }

  // Sort: running first (alphabetical), then non-running by most recently used
  instances.sort((a, b) => {
    if (a.running !== b.running) {
      return a.running ? -1 : 1;
    }
    if (a.running) {
      // Running: alphabetical
      return a.workspaceName.localeCompare(b.workspaceName);
    }
    // Non-running (recent): reverse chronological (most recently used first)
    const aTime = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
    const bTime = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
    return bTime - aTime;
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

    // Create architect terminal if `main` is not already present.
    // Spec 755: this is the workspace-start path; it creates the default
    // 'main' architect. Additional named architects come via the Phase 2 CLI.
    // Spec 786 Phase 3: gate changed from `size === 0` to `!has('main')`. The
    // size-based gate was unsafe once `state.db.architect` can carry sibling
    // rows across stop+start — if a reconciliation path repopulated siblings
    // before launchInstance ran, the old gate would have skipped main creation
    // entirely. Gating on `main` specifically guarantees main is always
    // created/present after launchInstance returns success.
    if (!entry.architects.has('main')) {
      const manager = _deps.getTerminalManager();

      // Read architect command: env var override (for CI/testing), unified config, or default
      let architectCmd = process.env.TOWER_ARCHITECT_CMD || '';
      if (!architectCmd) {
        architectCmd = 'claude';
        try {
          const config = loadConfig(workspacePath);
          const shellArchitect = config.shell?.architect;
          if (typeof shellArchitect === 'string') {
            architectCmd = shellArchitect;
          } else if (Array.isArray(shellArchitect)) {
            architectCmd = shellArchitect.join(' ');
          }
        } catch {
          // Config load errors — use default
        }
      }

      try {
        // Parse command string to separate command and args, inject role prompt
        const cmdParts = architectCmd.split(/\s+/);
        const cmd = cmdParts[0];

        // Issue #832: resume main's persisted conversation when its row carries a
        // session id, else spawn fresh and mint one. The returned `sessionId` is
        // stored on the architect row below so the next restart resumes it. A
        // state.db read failure degrades to a fresh spawn rather than aborting.
        //
        // Legacy bridge: a row from before #832 has no stored id. For it, fall back
        // to #830's jsonl-discovery — but ONLY when main is the sole architect, since
        // a cwd shared with siblings makes newest-by-mtime ambiguous (the old
        // `safeToResume` guard, now scoped to just this fallback rather than gating
        // resume wholesale). Stored-UUID resume applies regardless of architect
        // count, so main resumes in multi-architect workspaces too once it has an id.
        // resolveArchitectLaunch persists whatever it resolves back onto the row, so
        // a jsonl-discovered id self-migrates into the stored-UUID path on this same
        // revival — no separate backfill step needed.
        let storedSessionId: string | null = null;
        try {
          storedSessionId = getArchitectByName(resolvedPath, DEFAULT_ARCHITECT_NAME)?.sessionId
            ?? (getArchitects(resolvedPath).length <= 1 ? findLatestSessionId(workspacePath) : null);
        } catch { /* state.db unreadable — spawn fresh */ }
        const { args: cmdArgs, env: harnessEnv, sessionId: mainSessionId, resumed } = resolveArchitectLaunch({
          workspacePath,
          name: DEFAULT_ARCHITECT_NAME,
          baseArgs: cmdParts.slice(1),
          storedSessionId,
        });
        if (resumed && mainSessionId) {
          _deps.log('INFO', `Resuming architect '${DEFAULT_ARCHITECT_NAME}' session ${mainSessionId.slice(0, 8)}… in ${workspacePath}`);
        }

        // Build env with CLAUDECODE removed so spawned Claude processes
        // don't detect a nested session, and merge harness env vars.
        // Spec 755: inject CODEV_ARCHITECT_NAME so afx spawn invocations
        // from inside this terminal can record the spawning architect.
        const cleanEnv = {
          ...process.env,
          ...harnessEnv,
          CODEV_ARCHITECT_NAME: DEFAULT_ARCHITECT_NAME,
        } as Record<string, string>;
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
              // Auto-restart is configured at the shellper level — tell PtySession
              // to keep WebSocket clients connected when the process exits.
              ptySession.restartOnExit = true;
            }

            // Spec 755: default architect is named 'main'; role_id stores the name.
            entry.architects.set('main', session.id);
            _deps.saveTerminalSession(session.id, resolvedPath, 'architect', 'main', shellperInfo.pid,
              shellperInfo.socketPath, shellperInfo.pid, shellperInfo.startTime, null, workspacePath);

            // Spec 755: persist to local state.db (architect table) so afx
            // status / stop see the architect via loadState's scalar shim.
            // Bugfix #826: scoped by workspace_path.
            try {
              setArchitect(resolvedPath, {
                name: DEFAULT_ARCHITECT_NAME,
                cmd: architectCmd,
                startedAt: new Date().toISOString(),
                terminalId: session.id,
                sessionId: mainSessionId ?? undefined,
              });
            } catch (stateErr) {
              _deps.log('WARN', `Failed to persist architect to state.db: ${(stateErr as Error).message}`);
            }

            // Clean up cache/SQLite when the shellper session permanently exits
            // (e.g., max restarts exceeded or killed). With restartOnExit, this
            // only fires for permanent death — normal exits are suppressed by PtySession.
            if (ptySession) {
              ptySession.on('exit', (exitCode?: number, signal?: number | string | null) => {
                const currentEntry = _deps!.getWorkspaceTerminalsEntry(resolvedPath);
                let exitedName: string | null = null;
                for (const [name, tid] of currentEntry.architects) {
                  if (tid === session.id) {
                    exitedName = name;
                    currentEntry.architects.delete(name);
                    break;
                  }
                }
                _deps!.deleteTerminalSession(session.id);
                // Spec 786 Phase 3 / OQ-B: delete the persisted architect row
                // on permanent exit so state.db mirrors reality. Skip on
                // intentional stop so the row survives a graceful stop+start.
                if (exitedName && !isIntentionallyStopping(resolvedPath)) {
                  try {
                    setArchitectByName(resolvedPath, exitedName, null);
                  } catch { /* best-effort cleanup */ }
                }
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

          // Spec 755: default architect is named 'main'; role_id stores the name.
          entry.architects.set('main', session.id);
          _deps.saveTerminalSession(session.id, resolvedPath, 'architect', 'main', session.pid, null, null, null, null, workspacePath);

          // Spec 755: persist to local state.db so afx status / stop see it.
          // Bugfix #826: scoped by workspace_path.
          try {
            setArchitect(resolvedPath, {
              name: DEFAULT_ARCHITECT_NAME,
              cmd: architectCmd,
              startedAt: new Date().toISOString(),
              terminalId: session.id,
              sessionId: mainSessionId ?? undefined,
            });
          } catch (stateErr) {
            _deps.log('WARN', `Failed to persist architect to state.db: ${(stateErr as Error).message}`);
          }

          const ptySession = manager.getSession(session.id);
          if (ptySession) {
            ptySession.on('exit', () => {
              const currentEntry = _deps!.getWorkspaceTerminalsEntry(resolvedPath);
              let exitedName: string | null = null;
              for (const [name, tid] of currentEntry.architects) {
                if (tid === session.id) {
                  exitedName = name;
                  currentEntry.architects.delete(name);
                  break;
                }
              }
              _deps!.deleteTerminalSession(session.id);
              // Spec 786 Phase 3 / OQ-B: delete the persisted architect row
              // on permanent exit; preserve on intentional stop.
              if (exitedName && !isIntentionallyStopping(resolvedPath)) {
                try {
                  setArchitectByName(resolvedPath, exitedName, null);
                } catch { /* best-effort cleanup */ }
              }
              _deps!.log('INFO', `Architect pty exited for ${workspacePath}`);
            });
          }

          _deps.log('WARN', `Architect terminal for ${workspacePath} is non-persistent (shellper unavailable)`);
        }

        _deps.log('INFO', `Created architect terminal for workspace: ${workspacePath}`);
      } catch (err) {
        const errMsg = `Failed to create architect terminal: ${(err as Error).message}`;
        _deps.log('ERROR', errMsg);
        return { success: false, error: errMsg, adopted };
      }
    }

    // Spec 786 Phase 3: re-spawn persisted sibling architects.
    //
    // After `main` is guaranteed present (above), iterate any non-main rows in
    // `state.db.architect` FOR THIS WORKSPACE and call `addArchitect()` for
    // each. This restores siblings that survived `afx workspace stop` (the
    // intentional-stop flag preserved their rows). The ordering is critical:
    // `addArchitect()` rejects when `entry.architects.size === 0`, so it MUST
    // run after main creation.
    //
    // Bugfix #826: `getArchitects(resolvedPath)` reads ONLY rows whose
    // `workspace_path` matches — migration v11 added that column to the
    // architect table as part of the composite primary key. Workspaces are
    // isolated by construction; the cross-workspace leak is eliminated at the
    // schema level rather than via per-call-site guards.
    //
    // Idempotency: skip names already in `entry.architects` so a re-entrant
    // launch (or a race with `reconcileTerminalSessions`) doesn't double-spawn.
    try {
      const persisted = getArchitects(resolvedPath);
      for (const a of persisted) {
        if (a.name === 'main') continue;
        if (entry.architects.has(a.name)) continue;
        const res = await addArchitect(workspacePath, a.name);
        if (!res.success) {
          _deps.log('WARN', `Failed to re-spawn persisted sibling architect '${a.name}': ${res.error}`);
        }
      }
    } catch (siblingErr) {
      _deps.log('WARN', `Sibling reconciliation failed: ${(siblingErr as Error).message}`);
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

  // Spec 786 Phase 3: mark the workspace as "intentionally stopping" so the
  // architect exit handlers triggered by the upcoming kills know NOT to delete
  // the persisted `state.db.architect` rows. The flag is cleared in `finally`
  // so any thrown error still releases it. Without this, the cascaded exit
  // handlers in tower-instances.ts (4 handlers) and tower-terminals.ts (1
  // handler) would delete sibling rows on every stop — making it impossible
  // for siblings to survive `afx workspace stop` + `start`.
  intentionallyStopping.add(resolvedPath);
  if (resolvedPath !== workspacePath) intentionallyStopping.add(workspacePath);
  try {
    if (entry) {
      // Spec 786 Phase 3 / PR iter-2 race-fix: register exit-promises for
      // every terminal BEFORE we kill anything. `killTerminalWithShellper`
      // sends SIGTERM and returns; node-pty's 'exit' event fires later, on
      // its own tick. If we cleared the flag in `finally` before 'exit'
      // fired, the cascaded architect exit handler would see
      // `isIntentionallyStopping === false` and incorrectly delete the
      // persisted `state.db.architect` row — defeating the entire Phase 3
      // persistence story. We await all 'exit' events (with a 5s safety
      // timeout per terminal) before falling through to the finally.
      const exitPromises: Promise<void>[] = [];

      // Kill all architects (disable shellper auto-restart if applicable)
      // Spec 755: iterate the named-architect Map instead of the old scalar.
      for (const terminalId of entry.architects.values()) {
        const session = manager.getSession(terminalId);
        if (session) {
          exitPromises.push(waitForTerminalExit(manager, terminalId));
          await killTerminalWithShellper(manager, terminalId);
          stopped.push(session.pid);
        }
      }

      // Kill all shells (disable shellper auto-restart if applicable)
      for (const terminalId of entry.shells.values()) {
        const session = manager.getSession(terminalId);
        if (session) {
          exitPromises.push(waitForTerminalExit(manager, terminalId));
          await killTerminalWithShellper(manager, terminalId);
          stopped.push(session.pid);
        }
      }

      // Kill all builders (disable shellper auto-restart if applicable)
      for (const terminalId of entry.builders.values()) {
        const session = manager.getSession(terminalId);
        if (session) {
          exitPromises.push(waitForTerminalExit(manager, terminalId));
          await killTerminalWithShellper(manager, terminalId);
          stopped.push(session.pid);
        }
      }

      // Await every 'exit' event before clearing the intentional-stop flag.
      // Each promise has its own 5s safety timeout so a stuck process never
      // blocks the stop indefinitely.
      if (exitPromises.length > 0) {
        await Promise.all(exitPromises);
      }

      // Clear workspace from registry
      _deps.workspaceTerminals.delete(resolvedPath);
      _deps.workspaceTerminals.delete(workspacePath);

      // TICK-001: Delete all terminal sessions from SQLite
      // Spec 786 Phase 3 Cl2: this is a full wipe of `terminal_sessions` rows.
      // Sibling architect rows in `state.db.architect` are preserved by the
      // intentional-stop flag above; on next launchInstance, siblings are
      // re-spawned via addArchitect which creates fresh terminal_sessions rows.
      _deps.deleteWorkspaceTerminalSessions(resolvedPath);
      if (resolvedPath !== workspacePath) {
        _deps.deleteWorkspaceTerminalSessions(workspacePath);
      }

      // Bugfix #474: Delete all file tabs for this workspace
      _deps.deleteFileTabsForWorkspace(resolvedPath);
      if (resolvedPath !== workspacePath) {
        _deps.deleteFileTabsForWorkspace(workspacePath);
      }
    }
  } finally {
    intentionallyStopping.delete(resolvedPath);
    if (resolvedPath !== workspacePath) intentionallyStopping.delete(workspacePath);
  }

  if (stopped.length === 0) {
    return { success: true, error: 'No terminals found to stop', stopped };
  }

  return { success: true, stopped };
}

// ============================================================================
// addArchitect (Spec 755) — register an additional named architect terminal
// ============================================================================

export interface AddArchitectResult {
  success: boolean;
  name?: string;
  terminalId?: string;
  error?: string;
}

/**
 * Add a named architect terminal to an already-active workspace (Spec 755).
 *
 * Differs from `launchInstance` in that:
 *   - The workspace must already be running (a 'main' architect must exist).
 *   - Either accepts an explicit `name` (validated) or auto-numbers as
 *     `architect-<N>` (smallest unused integer ≥ 2).
 *   - Rejects collisions on already-registered names.
 *
 * On success returns the chosen name and the new terminal session ID.
 */
export async function addArchitect(
  workspacePath: string,
  requestedName?: string,
): Promise<AddArchitectResult> {
  if (!_deps) return { success: false, error: 'Tower is still starting up. Try again shortly.' };

  // Resolve symlinks for consistent lookup
  let resolvedPath = workspacePath;
  try {
    if (fs.existsSync(workspacePath)) {
      resolvedPath = fs.realpathSync(workspacePath);
    }
  } catch {
    // Use original path on resolution failure
  }

  const entry = _deps.workspaceTerminals.get(resolvedPath) || _deps.workspaceTerminals.get(workspacePath);
  if (!entry || entry.architects.size === 0) {
    return {
      success: false,
      error: `Workspace '${workspacePath}' is not running. Start it with 'afx workspace start' first.`,
    };
  }

  // Pick the architect's name: explicit or auto-numbered.
  // Spec 755: distinguish "no name supplied" (undefined, auto-number) from
  // "name supplied with empty value" (rejected — would otherwise silently
  // auto-number, bypassing validation).
  let name: string;
  if (requestedName !== undefined) {
    const trimmed = requestedName.trim();
    if (trimmed === '') {
      return {
        success: false,
        error: 'Architect name cannot be empty. Omit the name to auto-number, or supply a valid name.',
      };
    }
    const validationError = validateArchitectName(trimmed);
    if (validationError) {
      return { success: false, error: validationError };
    }
    if (entry.architects.has(trimmed)) {
      return {
        success: false,
        error: `Architect '${trimmed}' is already registered in this workspace.`,
      };
    }
    name = trimmed;
  } else {
    name = autoNumberArchitectName(entry.architects.keys());
  }

  // Resolve architect command (mirrors launchInstance — env var, config, default).
  let architectCmd = process.env.TOWER_ARCHITECT_CMD || '';
  if (!architectCmd) {
    architectCmd = 'claude';
    try {
      const config = loadConfig(workspacePath);
      const shellArchitect = config.shell?.architect;
      if (typeof shellArchitect === 'string') {
        architectCmd = shellArchitect;
      } else if (Array.isArray(shellArchitect)) {
        architectCmd = shellArchitect.join(' ');
      }
    } catch {
      // Config load errors — use default
    }
  }

  const manager = _deps.getTerminalManager();
  const cmdParts = architectCmd.split(/\s+/);
  const cmd = cmdParts[0];
  // Issue #832: resume this sibling's persisted conversation when its row carries
  // a session id, else spawn fresh and mint one. The same call serves both a
  // user-driven `add-architect` (no row yet → fresh) and launchInstance's
  // reconcile loop re-spawning a persisted sibling after reboot (row has id →
  // resume). The returned id is persisted on the architect row below.
  let storedSessionId: string | null = null;
  try {
    storedSessionId = getArchitectByName(resolvedPath, name)?.sessionId ?? null;
  } catch { /* state.db unreadable — spawn fresh */ }
  const { args: cmdArgs, env: harnessEnv, sessionId: conversationSessionId, resumed } = resolveArchitectLaunch({
    workspacePath,
    name,
    baseArgs: cmdParts.slice(1),
    storedSessionId,
  });
  if (resumed && conversationSessionId) {
    _deps.log('INFO', `Resuming architect '${name}' session ${conversationSessionId.slice(0, 8)}… in ${workspacePath}`);
  }

  // Spec 755: inject CODEV_ARCHITECT_NAME so the new architect terminal's
  // afx spawn invocations tag builders with this architect's name.
  const cleanEnv = {
    ...process.env,
    ...harnessEnv,
    CODEV_ARCHITECT_NAME: name,
  } as Record<string, string>;
  delete cleanEnv['CLAUDECODE'];

  // Try shellper first; fall back to a non-persistent PTY if shellper is
  // unavailable (matches launchInstance's degradation).
  let sessionId: string | null = null;

  if (_deps.shellperManager) {
    try {
      const shellperSessionId = crypto.randomUUID();
      const client = await _deps.shellperManager.createSession({
        sessionId: shellperSessionId,
        command: cmd,
        args: cmdArgs,
        cwd: workspacePath,
        env: cleanEnv,
        ...defaultSessionOptions({ restartOnExit: true, restartDelay: 2000, maxRestarts: 50 }),
      });

      const replayData = client.getReplayData() ?? Buffer.alloc(0);
      const shellperInfo = _deps.shellperManager.getSessionInfo(shellperSessionId)!;

      const session = manager.createSessionRaw({ label: `Architect (${name})`, cwd: workspacePath });
      const ptySession = manager.getSession(session.id);
      if (ptySession) {
        ptySession.attachShellper(client, replayData, shellperInfo.pid, shellperSessionId);
        ptySession.restartOnExit = true;
      }

      entry.architects.set(name, session.id);
      _deps.saveTerminalSession(
        session.id, resolvedPath, 'architect', name, shellperInfo.pid,
        shellperInfo.socketPath, shellperInfo.pid, shellperInfo.startTime, null, workspacePath,
      );

      // Spec 755: persist to local state.db so the architect appears in
      // getArchitects() and is included in legacy stop.ts cleanup.
      // Bugfix #826: scoped by workspace_path.
      try {
        setArchitectByName(resolvedPath, name, {
          name,
          cmd: architectCmd,
          startedAt: new Date().toISOString(),
          terminalId: session.id,
          sessionId: conversationSessionId ?? undefined,
        });
      } catch (stateErr) {
        _deps.log('WARN', `Failed to persist architect '${name}' to state.db: ${(stateErr as Error).message}`);
      }

      if (ptySession) {
        ptySession.on('exit', (exitCode?: number, signal?: number | string | null) => {
          const currentEntry = _deps!.getWorkspaceTerminalsEntry(resolvedPath);
          for (const [n, tid] of currentEntry.architects) {
            if (tid === session.id) {
              currentEntry.architects.delete(n);
              break;
            }
          }
          _deps!.deleteTerminalSession(session.id);
          // Spec 755: remove the architect row from local state.db too.
          // Spec 786 Phase 3: skip the row deletion when the workspace is
          // mid-intentional-stop so the sibling survives `afx workspace stop`.
          if (!isIntentionallyStopping(resolvedPath)) {
            try {
              setArchitectByName(resolvedPath, name, null);
            } catch { /* best-effort cleanup */ }
          }
          _deps!.log('INFO', `Architect shellper session '${name}' exited (code=${exitCode ?? null}, signal=${signal ?? null})`);
        });
      }

      sessionId = session.id;
      _deps.log('INFO', `Created shellper-backed architect '${name}' in workspace ${workspacePath}`);
    } catch (shellperErr) {
      _deps.log('WARN', `Shellper creation failed for architect '${name}', falling back: ${(shellperErr as Error).message}`);
    }
  }

  if (!sessionId) {
    try {
      const session = await manager.createSession({
        command: cmd,
        args: cmdArgs,
        cwd: workspacePath,
        label: `Architect (${name})`,
        env: cleanEnv,
      });

      entry.architects.set(name, session.id);
      _deps.saveTerminalSession(session.id, resolvedPath, 'architect', name, session.pid, null, null, null, null, workspacePath);

      try {
        // Bugfix #826: scoped by workspace_path.
        setArchitectByName(resolvedPath, name, {
          name,
          cmd: architectCmd,
          startedAt: new Date().toISOString(),
          terminalId: session.id,
          sessionId: conversationSessionId ?? undefined,
        });
      } catch (stateErr) {
        _deps.log('WARN', `Failed to persist architect '${name}' to state.db: ${(stateErr as Error).message}`);
      }

      const ptySession = manager.getSession(session.id);
      if (ptySession) {
        ptySession.on('exit', () => {
          const currentEntry = _deps!.getWorkspaceTerminalsEntry(resolvedPath);
          for (const [n, tid] of currentEntry.architects) {
            if (tid === session.id) {
              currentEntry.architects.delete(n);
              break;
            }
          }
          _deps!.deleteTerminalSession(session.id);
          // Spec 786 Phase 3: skip the row deletion when the workspace is
          // mid-intentional-stop so the sibling survives `afx workspace stop`.
          if (!isIntentionallyStopping(resolvedPath)) {
            try {
              setArchitectByName(resolvedPath, name, null);
            } catch { /* best-effort cleanup */ }
          }
          _deps!.log('INFO', `Architect pty '${name}' exited`);
        });
      }

      sessionId = session.id;
      _deps.log('WARN', `Architect '${name}' is non-persistent (shellper unavailable)`);
    } catch (err) {
      return { success: false, error: `Failed to create architect terminal: ${(err as Error).message}` };
    }
  }

  return { success: true, name, terminalId: sessionId! };
}

// ============================================================================
// removeArchitect (Spec 786 Phase 4) — remove a named sibling architect
// ============================================================================

/**
 * Spec 786 Phase 4: remove a sibling architect.
 *
 * Refuses `main` (workspace-defining, undeletable). Refuses unknown names with
 * a 404-mappable error string. For known siblings, raises the intentional-stop
 * flag so the cascaded exit handler does NOT delete the row twice, kills the
 * sibling's PTY (disabling shellper auto-restart), then explicitly removes the
 * in-memory entry and persisted rows. Returns `{ success: true }` on success.
 *
 * Removing a sibling with in-flight builders is permitted (per OQ-A) — the
 * builders' subsequent `afx send architect` calls fall back to `main` via
 * `tower-messages.ts:336`.
 */
export async function removeArchitect(
  workspacePath: string,
  name: string,
): Promise<{ success: boolean; error?: string }> {
  if (!_deps) return { success: false, error: 'Tower is still starting up. Try again shortly.' };

  // Resolve symlinks for consistent lookup (matches addArchitect / stopInstance).
  let resolvedPath = workspacePath;
  try {
    if (fs.existsSync(workspacePath)) {
      resolvedPath = fs.realpathSync(workspacePath);
    }
  } catch {
    // Use original path on resolution failure.
  }

  // Reserved-name check: `main` is workspace-defining and undeletable.
  if (name === DEFAULT_ARCHITECT_NAME) {
    return { success: false, error: "Cannot remove the default 'main' architect." };
  }

  const entry = _deps.workspaceTerminals.get(resolvedPath) || _deps.workspaceTerminals.get(workspacePath);
  if (!entry || entry.architects.size === 0) {
    return {
      success: false,
      error: `Workspace '${workspacePath}' is not running. Start it with 'afx workspace start' first.`,
    };
  }

  const terminalId = entry.architects.get(name);
  if (!terminalId) {
    return { success: false, error: `Architect '${name}' not found in workspace '${workspacePath}'.` };
  }

  const manager = _deps.getTerminalManager();

  // Raise the intentional-stop flag so the cascaded exit handler does NOT also
  // delete the state.db row (we delete it explicitly below). Without this, the
  // exit handler would call setArchitectByName(name, null) — harmless but the
  // double-delete is wasteful and the intent (this is an intentional removal)
  // is clearer with the flag set.
  intentionallyStopping.add(resolvedPath);
  if (resolvedPath !== workspacePath) intentionallyStopping.add(workspacePath);
  try {
    // Spec 786 Phase 4 / PR iter-2 race-fix: register the exit-promise
    // BEFORE the kill so the listener is attached before node-pty can emit
    // 'exit'. Without awaiting it, the `finally` clears the flag too early
    // and the exit handler racing to re-delete the row sees the flag as
    // false. (In remove-architect's case, the double-delete would be
    // harmless — `setArchitectByName` is idempotent — but the same pattern
    // bites `stopInstance` where the row should NOT be deleted at all. Keep
    // both paths symmetric so a future contributor doesn't accidentally
    // diverge them.)
    const exitPromise = waitForTerminalExit(manager, terminalId);
    await killTerminalWithShellper(manager, terminalId);
    entry.architects.delete(name);

    // Explicitly delete persisted rows (the intentional-stop flag suppressed
    // the exit-handler delete; we want the row gone for this remove path).
    // Bugfix #826: scoped by workspace_path.
    try {
      setArchitectByName(resolvedPath, name, null);
    } catch { /* best-effort cleanup */ }
    try {
      _deps.deleteTerminalSession(terminalId);
    } catch { /* best-effort cleanup */ }

    // Wait for the actual 'exit' event before clearing the flag.
    await exitPromise;
    // Issue #832: no session cleanup needed — the row delete above cleared the
    // persisted session_id, so a re-add with the same name starts fresh.
  } finally {
    intentionallyStopping.delete(resolvedPath);
    if (resolvedPath !== workspacePath) intentionallyStopping.delete(workspacePath);
  }

  _deps.log('INFO', `Removed architect '${name}' from workspace ${workspacePath}`);
  return { success: true };
}

