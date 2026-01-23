/**
 * Porch State Management
 *
 * Handles project state persistence with atomic writes.
 * Fails loudly on any error - no guessing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import type { ProjectState, Protocol, PlanPhase } from './types.js';

/** Directory for project state (relative to project root) */
export const PROJECTS_DIR = 'codev/projects';

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get the project directory path
 */
export function getProjectDir(projectRoot: string, projectId: string, name: string): string {
  return path.join(projectRoot, PROJECTS_DIR, `${projectId}-${name}`);
}

/**
 * Get the status.yaml path for a project
 */
export function getStatusPath(projectRoot: string, projectId: string, name: string): string {
  return path.join(getProjectDir(projectRoot, projectId, name), 'status.yaml');
}

// ============================================================================
// State Operations
// ============================================================================

/**
 * Read project state from status.yaml
 * Fails loudly if file is missing or corrupted.
 */
export function readState(statusPath: string): ProjectState {
  if (!fs.existsSync(statusPath)) {
    throw new Error(`Project not found: ${statusPath}\nRun 'porch init' to create a new project.`);
  }

  try {
    const content = fs.readFileSync(statusPath, 'utf-8');
    const state = yaml.load(content) as ProjectState;

    // Basic validation
    if (!state || typeof state !== 'object') {
      throw new Error('Invalid state file: not an object');
    }
    if (!state.id || !state.protocol || !state.phase) {
      throw new Error('Invalid state file: missing required fields (id, protocol, phase)');
    }

    return state;
  } catch (err) {
    if (err instanceof yaml.YAMLException) {
      throw new Error(`Invalid state file: YAML parse error\n${err.message}`);
    }
    throw err;
  }
}

/**
 * Write project state atomically (tmp file + rename)
 */
export function writeState(statusPath: string, state: ProjectState): void {
  const dir = path.dirname(statusPath);
  const tmpPath = `${statusPath}.tmp`;

  // Ensure directory exists
  fs.mkdirSync(dir, { recursive: true });

  // Update timestamp
  state.updated_at = new Date().toISOString();

  // Write to temp file then rename (atomic)
  const content = yaml.dump(state, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, statusPath);
}

/**
 * Create initial state for a new project
 */
export function createInitialState(
  protocol: Protocol,
  projectId: string,
  title: string
): ProjectState {
  const now = new Date().toISOString();

  // Initialize gates from protocol
  const gates: ProjectState['gates'] = {};
  for (const phase of protocol.phases) {
    if (phase.gate) {
      gates[phase.gate] = { status: 'pending' };
    }
  }

  // First phase is initial
  const initialPhase = protocol.phases[0]?.id || 'specify';

  return {
    id: projectId,
    title,
    protocol: protocol.name,
    phase: initialPhase,
    plan_phases: [],
    current_plan_phase: null,
    gates,
    started_at: now,
    updated_at: now,
  };
}

// ============================================================================
// Discovery
// ============================================================================

/**
 * Find status.yaml by project ID (searches for NNNN-* directories)
 */
export function findStatusPath(projectRoot: string, projectId: string): string | null {
  const projectsDir = path.join(projectRoot, PROJECTS_DIR);

  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(`${projectId}-`)) {
      const statusPath = path.join(projectsDir, entry.name, 'status.yaml');
      if (fs.existsSync(statusPath)) {
        return statusPath;
      }
    }
  }

  return null;
}
