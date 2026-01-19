/**
 * Porch State Management
 *
 * Handles project state persistence with:
 * - Pure YAML format (no markdown frontmatter)
 * - Atomic writes (tmp file + fsync + rename)
 * - File locking (flock advisory locking)
 * - Crash recovery
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { openSync, closeSync, fsyncSync, writeFileSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import type { ProjectState, Protocol } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Directory for SPIDER project state (relative to project root) */
export const PROJECTS_DIR = 'codev/projects';

/** Directory for TICK/BUGFIX execution state (relative to project root) */
export const EXECUTIONS_DIR = 'codev/executions';

/** Lock timeout in milliseconds */
const LOCK_TIMEOUT_MS = 5000;

/** Lock retry interval in milliseconds */
const LOCK_RETRY_MS = 100;

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get the status file path for a SPIDER project
 */
export function getProjectStatusPath(projectRoot: string, projectId: string, name?: string): string {
  const projectDir = name
    ? path.join(projectRoot, PROJECTS_DIR, `${projectId}-${name}`)
    : path.join(projectRoot, PROJECTS_DIR, projectId);
  return path.join(projectDir, 'status.yaml');
}

/**
 * Get the status file path for a TICK/BUGFIX execution
 */
export function getExecutionStatusPath(
  projectRoot: string,
  protocol: string,
  id: string,
  name?: string
): string {
  const dirName = name ? `${protocol}_${id}_${name}` : `${protocol}_${id}`;
  return path.join(projectRoot, EXECUTIONS_DIR, dirName, 'status.yaml');
}

/**
 * Get the project directory for a SPIDER project
 */
export function getProjectDir(projectRoot: string, projectId: string, name?: string): string {
  return name
    ? path.join(projectRoot, PROJECTS_DIR, `${projectId}-${name}`)
    : path.join(projectRoot, PROJECTS_DIR, projectId);
}

/**
 * Get the worktree path for a protocol execution
 */
export function getWorktreePath(projectRoot: string, protocol: string, id: string, name?: string): string {
  const dirName = name ? `${protocol}_${id}_${name}` : `${protocol}_${id}`;
  return path.join(projectRoot, 'worktrees', dirName);
}

// ============================================================================
// File Locking (Advisory)
// ============================================================================

interface FileLock {
  fd: number;
  lockFile: string;
}

/**
 * Acquire an advisory lock on a file
 * Creates a .lock file to indicate lock ownership
 */
export async function acquireLock(filePath: string): Promise<FileLock> {
  const lockFile = `${filePath}.lock`;
  const startTime = Date.now();

  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    try {
      // Try to create lock file exclusively
      const fd = openSync(lockFile, 'wx');
      // Write our PID for debugging
      writeFileSync(lockFile, `${process.pid}\n`);
      return { fd, lockFile };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lock file exists, check if stale
        try {
          const stat = fs.statSync(lockFile);
          // If lock is older than 60 seconds, consider it stale
          if (Date.now() - stat.mtimeMs > 60000) {
            unlinkSync(lockFile);
            continue;
          }
        } catch {
          // Lock file disappeared, retry
          continue;
        }
        // Wait and retry
        await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
      } else {
        throw err;
      }
    }
  }

  throw new Error(`Failed to acquire lock on ${filePath} after ${LOCK_TIMEOUT_MS}ms`);
}

/**
 * Release an advisory lock
 */
export function releaseLock(lock: FileLock): void {
  try {
    closeSync(lock.fd);
    unlinkSync(lock.lockFile);
  } catch {
    // Ignore errors during cleanup
  }
}

// ============================================================================
// YAML Serialization
// ============================================================================

/**
 * Simple YAML serializer for project state
 * Handles our specific data structures without external dependencies
 */
export function serializeState(state: ProjectState): string {
  const lines: string[] = [];

  // Basic fields
  lines.push(`id: "${state.id}"`);
  lines.push(`title: "${state.title}"`);
  lines.push(`protocol: "${state.protocol}"`);
  lines.push(`state: "${state.current_state}"`);

  if (state.worktree) {
    lines.push(`worktree: "${state.worktree}"`);
  }

  lines.push('');

  // Gates
  lines.push('gates:');
  if (state.gates && Object.keys(state.gates).length > 0) {
    for (const [gateId, gateStatus] of Object.entries(state.gates)) {
      const status = gateStatus.status || 'pending';
      const requestedAt = gateStatus.requested_at ? `, requested_at: "${gateStatus.requested_at}"` : '';
      const approvedAt = gateStatus.approved_at ? `, approved_at: "${gateStatus.approved_at}"` : '';
      lines.push(`  ${gateId}: { status: ${status}${requestedAt}${approvedAt} }`);
    }
  } else {
    lines.push('  # No gates defined');
  }

  lines.push('');

  // Phases (for phased implementation)
  lines.push('phases:');
  if (state.phases && Object.keys(state.phases).length > 0) {
    for (const [phaseId, phaseStatus] of Object.entries(state.phases)) {
      if (typeof phaseStatus === 'object' && phaseStatus !== null) {
        const ps = phaseStatus as { status?: string; title?: string };
        const status = ps.status || 'pending';
        const title = ps.title ? `, title: "${ps.title}"` : '';
        lines.push(`  ${phaseId}: { status: ${status}${title} }`);
      }
    }
  } else {
    lines.push('  # No phases extracted yet');
  }

  lines.push('');

  // Plan phases (extracted from plan.md)
  if (state.plan_phases && state.plan_phases.length > 0) {
    lines.push('plan_phases:');
    for (const phase of state.plan_phases) {
      lines.push(`  - id: "${phase.id}"`);
      lines.push(`    title: "${phase.title}"`);
      if (phase.description) {
        lines.push(`    description: "${phase.description.replace(/"/g, '\\"')}"`);
      }
    }
    lines.push('');
  }

  // Consultation attempts (for tracking retries across iterations)
  if (state.consultation_attempts && Object.keys(state.consultation_attempts).length > 0) {
    lines.push('consultation_attempts:');
    for (const [stateKey, count] of Object.entries(state.consultation_attempts)) {
      lines.push(`  "${stateKey}": ${count}`);
    }
    lines.push('');
  }

  // Metadata
  lines.push(`iteration: ${state.iteration || 0}`);
  lines.push(`started_at: "${state.started_at || new Date().toISOString()}"`);
  lines.push(`last_updated: "${new Date().toISOString()}"`);

  lines.push('');

  // Log
  lines.push('log:');
  if (state.log && state.log.length > 0) {
    for (const entry of state.log) {
      if (typeof entry === 'string') {
        lines.push(`  - "${entry}"`);
      } else if (typeof entry === 'object' && entry !== null) {
        const logEntry = entry as { ts?: string; event?: string; from?: string; to?: string; signal?: string };
        const ts = logEntry.ts || new Date().toISOString();
        const event = logEntry.event || 'unknown';
        let entryLine = `  - ts: "${ts}"`;
        lines.push(entryLine);
        lines.push(`    event: "${event}"`);
        if (logEntry.from) lines.push(`    from: "${logEntry.from}"`);
        if (logEntry.to) lines.push(`    to: "${logEntry.to}"`);
        if (logEntry.signal) lines.push(`    signal: "${logEntry.signal}"`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Parse YAML status file into ProjectState
 */
export function parseState(content: string): ProjectState {
  const state: Partial<ProjectState> = {
    gates: {},
    phases: {},
    log: [],
    consultation_attempts: {},
  };

  const lines = content.split('\n');
  let currentSection = '';
  let currentArrayItem: Record<string, unknown> | null = null;

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.trim().startsWith('#') || line.trim() === '') {
      continue;
    }

    // Detect section headers
    if (line.match(/^gates:\s*$/)) {
      currentSection = 'gates';
      continue;
    }
    if (line.match(/^phases:\s*$/)) {
      currentSection = 'phases';
      continue;
    }
    if (line.match(/^plan_phases:\s*$/)) {
      currentSection = 'plan_phases';
      state.plan_phases = [];
      continue;
    }
    if (line.match(/^log:\s*$/)) {
      currentSection = 'log';
      continue;
    }
    if (line.match(/^consultation_attempts:\s*$/)) {
      currentSection = 'consultation_attempts';
      continue;
    }

    // Parse based on section
    if (currentSection === 'gates') {
      // Parse: gate_id: { status: pending, requested_at: "..." }
      const match = line.match(/^\s+(\w+):\s*\{\s*status:\s*(\w+)(?:,\s*requested_at:\s*"([^"]*)")?(?:,\s*approved_at:\s*"([^"]*)")?\s*\}/);
      if (match) {
        const [, gateId, status, requestedAt, approvedAt] = match;
        state.gates![gateId] = {
          status: status as 'pending' | 'passed' | 'failed',
          ...(requestedAt && { requested_at: requestedAt }),
          ...(approvedAt && { approved_at: approvedAt }),
        };
      }
      continue;
    }

    if (currentSection === 'phases') {
      // Parse: phase_id: { status: pending, title: "..." }
      const match = line.match(/^\s+(\w+):\s*\{\s*status:\s*(\w+)(?:,\s*title:\s*"([^"]*)")?\s*\}/);
      if (match) {
        const [, phaseId, status, title] = match;
        state.phases![phaseId] = {
          status: status as 'pending' | 'in_progress' | 'complete',
          ...(title && { title }),
        };
      }
      continue;
    }

    if (currentSection === 'plan_phases') {
      // Parse array items
      if (line.match(/^\s+-\s+id:/)) {
        if (currentArrayItem) {
          state.plan_phases!.push(currentArrayItem as { id: string; title: string; description?: string });
        }
        currentArrayItem = {};
        const idMatch = line.match(/id:\s*"([^"]*)"/);
        if (idMatch) currentArrayItem.id = idMatch[1];
      } else if (line.match(/^\s+title:/)) {
        const titleMatch = line.match(/title:\s*"([^"]*)"/);
        if (titleMatch && currentArrayItem) currentArrayItem.title = titleMatch[1];
      } else if (line.match(/^\s+description:/)) {
        const descMatch = line.match(/description:\s*"([^"]*)"/);
        if (descMatch && currentArrayItem) currentArrayItem.description = descMatch[1];
      }
      continue;
    }

    if (currentSection === 'consultation_attempts') {
      // Parse: "state:key": count
      const match = line.match(/^\s+"([^"]+)":\s*(\d+)/);
      if (match) {
        const [, stateKey, count] = match;
        state.consultation_attempts![stateKey] = parseInt(count, 10);
      }
      continue;
    }

    if (currentSection === 'log') {
      // Parse log entries - simplified
      if (line.match(/^\s+-\s+ts:/)) {
        if (currentArrayItem) {
          state.log!.push(currentArrayItem as unknown);
        }
        currentArrayItem = {};
        const tsMatch = line.match(/ts:\s*"([^"]*)"/);
        if (tsMatch) currentArrayItem.ts = tsMatch[1];
      } else if (line.match(/^\s+event:/)) {
        const eventMatch = line.match(/event:\s*"([^"]*)"/);
        if (eventMatch && currentArrayItem) currentArrayItem.event = eventMatch[1];
      } else if (line.match(/^\s+from:/)) {
        const fromMatch = line.match(/from:\s*"([^"]*)"/);
        if (fromMatch && currentArrayItem) currentArrayItem.from = fromMatch[1];
      } else if (line.match(/^\s+to:/)) {
        const toMatch = line.match(/to:\s*"([^"]*)"/);
        if (toMatch && currentArrayItem) currentArrayItem.to = toMatch[1];
      } else if (line.match(/^\s+signal:/)) {
        const signalMatch = line.match(/signal:\s*"([^"]*)"/);
        if (signalMatch && currentArrayItem) currentArrayItem.signal = signalMatch[1];
      } else if (line.match(/^\s+-\s*"[^"]*"/)) {
        // Simple string log entry
        const strMatch = line.match(/^\s+-\s*"([^"]*)"/);
        if (strMatch) state.log!.push(strMatch[1]);
      }
      continue;
    }

    // Top-level fields
    const kvMatch = line.match(/^(\w+):\s*"?([^"\n]*)"?$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      switch (key) {
        case 'id':
          state.id = value;
          break;
        case 'title':
          state.title = value;
          break;
        case 'protocol':
          state.protocol = value;
          break;
        case 'state':
          state.current_state = value;
          break;
        case 'worktree':
          state.worktree = value;
          break;
        case 'iteration':
          state.iteration = parseInt(value, 10);
          break;
        case 'started_at':
          state.started_at = value;
          break;
        case 'last_updated':
          state.last_updated = value;
          break;
      }
    }
  }

  // Push final array item if exists
  if (currentArrayItem) {
    if (currentSection === 'plan_phases') {
      state.plan_phases!.push(currentArrayItem as { id: string; title: string; description?: string });
    } else if (currentSection === 'log') {
      state.log!.push(currentArrayItem as unknown);
    }
  }

  return state as ProjectState;
}

// ============================================================================
// State Operations
// ============================================================================

/**
 * Read project state from status file
 */
export function readState(statusFilePath: string): ProjectState | null {
  // Check for crash recovery - .tmp file exists
  const tmpPath = `${statusFilePath}.tmp`;
  if (fs.existsSync(tmpPath)) {
    try {
      const tmpContent = readFileSync(tmpPath, 'utf-8');
      const tmpState = parseState(tmpContent);
      // tmp file is valid, use it and clean up
      renameSync(tmpPath, statusFilePath);
      console.log('[porch] Recovered state from interrupted write');
      return tmpState;
    } catch {
      // tmp file is corrupt, delete it
      unlinkSync(tmpPath);
    }
  }

  if (!fs.existsSync(statusFilePath)) {
    return null;
  }

  const content = readFileSync(statusFilePath, 'utf-8');
  return parseState(content);
}

/**
 * Write project state atomically
 * Uses tmp file + fsync + rename for crash safety
 */
export async function writeState(statusFilePath: string, state: ProjectState): Promise<void> {
  const lock = await acquireLock(statusFilePath);

  try {
    const content = serializeState(state);
    const tmpPath = `${statusFilePath}.tmp`;
    const dir = path.dirname(statusFilePath);

    // Ensure directory exists
    fs.mkdirSync(dir, { recursive: true });

    // Write to temp file
    const fd = openSync(tmpPath, 'w');
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);

    // Atomic rename
    renameSync(tmpPath, statusFilePath);
  } finally {
    releaseLock(lock);
  }
}

/**
 * Create initial project state
 */
export function createInitialState(
  protocol: Protocol,
  projectId: string,
  title: string,
  worktreePath?: string
): ProjectState {
  const now = new Date().toISOString();

  // Extract gates from protocol
  const gates: ProjectState['gates'] = {};
  for (const phase of protocol.phases) {
    if (phase.gate) {
      const gateId = `${phase.id}_approval`;
      gates[gateId] = { status: 'pending' };
    }
  }

  return {
    id: projectId,
    title,
    protocol: protocol.name,
    current_state: protocol.initial || `${protocol.phases[0]?.id}:draft`,
    worktree: worktreePath,
    gates,
    phases: {},
    plan_phases: [],
    iteration: 0,
    started_at: now,
    last_updated: now,
    log: [{
      ts: now,
      event: 'state_change',
      from: null,
      to: protocol.initial || `${protocol.phases[0]?.id}:draft`,
    }],
  };
}

/**
 * Update state with a new current state
 */
export function updateState(
  state: ProjectState,
  newState: string,
  options: { signal?: string } = {}
): ProjectState {
  const now = new Date().toISOString();
  const logEntry: Record<string, unknown> = {
    ts: now,
    event: 'state_change',
    from: state.current_state,
    to: newState,
  };

  if (options.signal) {
    logEntry.signal = options.signal;
  }

  return {
    ...state,
    current_state: newState,
    iteration: state.iteration + 1,
    last_updated: now,
    log: [...state.log, logEntry],
  };
}

/**
 * Approve a gate in state
 */
export function approveGate(state: ProjectState, gateId: string): ProjectState {
  const now = new Date().toISOString();

  return {
    ...state,
    gates: {
      ...state.gates,
      [gateId]: {
        ...state.gates[gateId],
        status: 'passed',
        approved_at: now,
      },
    },
    last_updated: now,
    log: [...state.log, {
      ts: now,
      event: 'gate_approved',
      gate: gateId,
    }],
  };
}

/**
 * Request a gate approval (mark as pending with timestamp)
 */
export function requestGateApproval(state: ProjectState, gateId: string): ProjectState {
  const now = new Date().toISOString();

  return {
    ...state,
    gates: {
      ...state.gates,
      [gateId]: {
        status: 'pending',
        requested_at: now,
      },
    },
    last_updated: now,
    log: [...state.log, {
      ts: now,
      event: 'gate_requested',
      gate: gateId,
    }],
  };
}

/**
 * Update phase status
 */
export function updatePhaseStatus(
  state: ProjectState,
  phaseId: string,
  status: 'pending' | 'in_progress' | 'complete'
): ProjectState {
  const now = new Date().toISOString();

  return {
    ...state,
    phases: {
      ...state.phases,
      [phaseId]: {
        ...state.phases[phaseId],
        status,
      },
    },
    last_updated: now,
    log: [...state.log, {
      ts: now,
      event: 'phase_status_change',
      phase: phaseId,
      status,
    }],
  };
}

/**
 * Set plan phases extracted from plan.md
 */
export function setPlanPhases(
  state: ProjectState,
  phases: Array<{ id: string; title: string; description?: string }>
): ProjectState {
  const now = new Date().toISOString();

  // Initialize phase status for each extracted phase
  const phaseStatus: ProjectState['phases'] = {};
  for (const phase of phases) {
    phaseStatus[phase.id] = { status: 'pending', title: phase.title };
  }

  return {
    ...state,
    plan_phases: phases,
    phases: phaseStatus,
    last_updated: now,
    log: [...state.log, {
      ts: now,
      event: 'plan_phases_extracted',
      count: phases.length,
    }],
  };
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Find all SPIDER projects
 */
export function findProjects(projectRoot: string): Array<{ id: string; path: string }> {
  const projectsDir = path.join(projectRoot, PROJECTS_DIR);

  if (!fs.existsSync(projectsDir)) {
    return [];
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const projects: Array<{ id: string; path: string }> = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const statusPath = path.join(projectsDir, entry.name, 'status.yaml');
      if (fs.existsSync(statusPath)) {
        // Extract project ID from directory name (format: NNNN-name or just NNNN)
        const idMatch = entry.name.match(/^(\d+)/);
        if (idMatch) {
          projects.push({
            id: idMatch[1],
            path: statusPath,
          });
        }
      }
    }
  }

  return projects;
}

/**
 * Find all executions (TICK, BUGFIX, etc.)
 */
export function findExecutions(projectRoot: string): Array<{ protocol: string; id: string; path: string }> {
  const executionsDir = path.join(projectRoot, EXECUTIONS_DIR);

  if (!fs.existsSync(executionsDir)) {
    return [];
  }

  const entries = fs.readdirSync(executionsDir, { withFileTypes: true });
  const executions: Array<{ protocol: string; id: string; path: string }> = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const statusPath = path.join(executionsDir, entry.name, 'status.yaml');
      if (fs.existsSync(statusPath)) {
        // Parse directory name (format: protocol_id_name)
        const match = entry.name.match(/^(\w+)_(\w+)/);
        if (match) {
          executions.push({
            protocol: match[1],
            id: match[2],
            path: statusPath,
          });
        }
      }
    }
  }

  return executions;
}

/**
 * Find status file for a project by ID
 */
export function findStatusFile(projectRoot: string, projectId: string): string | null {
  // Check projects directory first
  const projectsDir = path.join(projectRoot, PROJECTS_DIR);
  if (fs.existsSync(projectsDir)) {
    const entries = fs.readdirSync(projectsDir);
    for (const entry of entries) {
      if (entry.startsWith(projectId)) {
        const statusPath = path.join(projectsDir, entry, 'status.yaml');
        if (fs.existsSync(statusPath)) {
          return statusPath;
        }
      }
    }
  }

  // Check executions directory
  const executionsDir = path.join(projectRoot, EXECUTIONS_DIR);
  if (fs.existsSync(executionsDir)) {
    const entries = fs.readdirSync(executionsDir);
    for (const entry of entries) {
      if (entry.includes(`_${projectId}`)) {
        const statusPath = path.join(executionsDir, entry, 'status.yaml');
        if (fs.existsSync(statusPath)) {
          return statusPath;
        }
      }
    }
  }

  return null;
}

// ============================================================================
// Consultation Attempt Tracking
// ============================================================================

/**
 * Get the number of consultation attempts for a given state
 */
export function getConsultationAttempts(state: ProjectState, stateKey: string): number {
  return state.consultation_attempts?.[stateKey] ?? 0;
}

/**
 * Increment consultation attempts for a given state
 */
export function incrementConsultationAttempts(state: ProjectState, stateKey: string): ProjectState {
  const now = new Date().toISOString();
  const currentAttempts = getConsultationAttempts(state, stateKey);

  return {
    ...state,
    consultation_attempts: {
      ...state.consultation_attempts,
      [stateKey]: currentAttempts + 1,
    },
    last_updated: now,
    log: [...state.log, {
      ts: now,
      event: 'consultation_attempt',
      phase: stateKey,
      count: currentAttempts + 1,
    }],
  };
}

/**
 * Reset consultation attempts for a given state (e.g., after gate approval)
 */
export function resetConsultationAttempts(state: ProjectState, stateKey: string): ProjectState {
  const newAttempts = { ...state.consultation_attempts };
  delete newAttempts[stateKey];

  return {
    ...state,
    consultation_attempts: newAttempts,
    last_updated: new Date().toISOString(),
  };
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Find all status files with pending gates
 */
export function findPendingGates(projectRoot: string): Array<{
  projectId: string;
  gateId: string;
  requestedAt?: string;
  statusPath: string;
}> {
  const pending: Array<{
    projectId: string;
    gateId: string;
    requestedAt?: string;
    statusPath: string;
  }> = [];

  // Check projects
  for (const { id, path: statusPath } of findProjects(projectRoot)) {
    const state = readState(statusPath);
    if (state && state.gates) {
      for (const [gateId, gateStatus] of Object.entries(state.gates)) {
        if (gateStatus.status === 'pending' && gateStatus.requested_at) {
          pending.push({
            projectId: id,
            gateId,
            requestedAt: gateStatus.requested_at,
            statusPath,
          });
        }
      }
    }
  }

  // Check executions
  for (const { id, path: statusPath } of findExecutions(projectRoot)) {
    const state = readState(statusPath);
    if (state && state.gates) {
      for (const [gateId, gateStatus] of Object.entries(state.gates)) {
        if (gateStatus.status === 'pending' && gateStatus.requested_at) {
          pending.push({
            projectId: id,
            gateId,
            requestedAt: gateStatus.requested_at,
            statusPath,
          });
        }
      }
    }
  }

  return pending;
}
