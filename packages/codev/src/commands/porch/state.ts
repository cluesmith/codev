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
 * Create initial state for a new project.
 *
 * Always starts at the first protocol phase. If artifacts (spec, plan)
 * already exist with approval metadata (YAML frontmatter), the run loop
 * will detect this and skip those phases automatically.
 */
export function createInitialState(
  protocol: Protocol,
  projectId: string,
  title: string,
  _projectRoot?: string
): ProjectState {
  const now = new Date().toISOString();

  // Initialize gates from protocol
  const gates: ProjectState['gates'] = {};
  for (const phase of protocol.phases) {
    if (phase.gate) {
      gates[phase.gate] = { status: 'pending' };
    }
  }

  const initialPhase = protocol.phases[0]?.id || 'specify';

  return {
    id: projectId,
    title,
    protocol: protocol.name,
    phase: initialPhase,
    plan_phases: [],
    current_plan_phase: null,
    gates,
    iteration: 1,
    build_complete: false,
    history: [],
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

/**
 * Detect project ID from the current working directory if inside a builder worktree.
 * Works from any subdirectory within the worktree.
 * Returns zero-padded project ID, or null if not in a recognized worktree.
 */
export function detectProjectIdFromCwd(cwd: string): string | null {
  const normalized = path.resolve(cwd).split(path.sep).join('/');
  const match = normalized.match(/\/\.builders\/(bugfix-(\d+)|(\d{4}))(\/|$)/);
  if (!match) return null;
  const rawId = match[2] || match[3];
  return rawId.padStart(4, '0');
}

/**
 * Resolve project ID using the priority chain:
 * 1. Explicit CLI argument (highest priority)
 * 2. CWD worktree detection
 * 3. Filesystem scan fallback
 * 4. Error if none succeed
 */
export function resolveProjectId(
  provided: string | undefined,
  cwd: string,
  projectRoot: string,
): string {
  // 1. Explicit CLI argument (highest priority)
  if (provided) return provided;

  // 2. CWD worktree detection
  const fromCwd = detectProjectIdFromCwd(cwd);
  if (fromCwd) return fromCwd;

  // 3. Filesystem scan fallback
  const detected = detectProjectId(projectRoot);
  if (detected) return detected;

  // 4. Error — none of the detection methods succeeded
  throw new Error('Cannot determine project ID. Provide it explicitly or run from a builder worktree.');
}

/**
 * Auto-detect project ID when only one project exists.
 * Returns null if zero or multiple projects found.
 */
export function detectProjectId(projectRoot: string): string | null {
  const projectsDir = path.join(projectRoot, PROJECTS_DIR);

  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const projects: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Extract project ID from directory name (e.g., "0076-skip-close" -> "0076")
      const match = entry.name.match(/^(\d{4})-/);
      if (match) {
        const statusPath = path.join(projectsDir, entry.name, 'status.yaml');
        if (fs.existsSync(statusPath)) {
          projects.push(match[1]);
        }
      }
    }
  }

  // Only return if exactly one project
  return projects.length === 1 ? projects[0] : null;
}
