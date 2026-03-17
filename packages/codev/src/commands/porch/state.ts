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
import type { ArtifactResolver } from './artifacts.js';

/** Directory for project state (relative to project root) */
export const PROJECTS_DIR = 'codev/projects';

// ============================================================================
// ID / Name Utilities
// ============================================================================

/**
 * Strip the project ID prefix from a title string.
 * Handles zero-padded IDs: stripIdPrefix('0364-terminal-refresh', '364') → 'terminal-refresh'
 */
export function stripIdPrefix(title: string, projectId: string): string {
  const normalizedId = projectId.replace(/^0+/, '') || '0';
  return title.replace(new RegExp(`^0*${normalizedId}-`), '');
}

/**
 * Resolve the canonical artifact base name (e.g. "0364-terminal-refresh-button")
 * by looking up the actual spec file on disk. Falls back to `${projectId}-${cleanTitle}`.
 *
 * This prevents doubled IDs like "364-0364-name" when state.id is unpadded
 * but spec files use zero-padded IDs.
 */
export function resolveArtifactBaseName(workspaceRoot: string, projectId: string, title: string, resolver?: ArtifactResolver): string {
  const isNumericId = /^\d+$/.test(projectId);
  if (isNumericId) {
    // Try resolver first (supports both local and FAVA Trails backends)
    if (resolver) {
      const baseName = resolver.findSpecBaseName(projectId, title);
      if (baseName) return baseName;
    } else {
      // Legacy direct-fs path (backward compatible when no resolver is passed)
      const specsDir = path.join(workspaceRoot, 'codev', 'specs');
      if (fs.existsSync(specsDir)) {
        const normalizedId = projectId.replace(/^0+/, '') || '0';
        try {
          const files = fs.readdirSync(specsDir);
          const specFile = files.find(f => {
            if (!f.endsWith('.md')) return false;
            const numMatch = f.match(/^(\d+)/);
            if (!numMatch) return false;
            return (numMatch[1].replace(/^0+/, '') || '0') === normalizedId;
          });
          if (specFile) {
            return specFile.replace(/\.md$/, '');
          }
        } catch { /* ignore */ }
      }
    }
  }
  // Fallback: strip any existing ID prefix from title, then prepend projectId
  const cleanTitle = stripIdPrefix(title, projectId);
  return `${projectId}-${cleanTitle}`;
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Get the project directory path
 */
export function getProjectDir(workspaceRoot: string, projectId: string, name: string): string {
  return path.join(workspaceRoot, PROJECTS_DIR, `${projectId}-${stripIdPrefix(name, projectId)}`);
}

/**
 * Get the status.yaml path for a project
 */
export function getStatusPath(workspaceRoot: string, projectId: string, name: string): string {
  return path.join(getProjectDir(workspaceRoot, projectId, name), 'status.yaml');
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
  _workspaceRoot?: string
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
export function findStatusPath(workspaceRoot: string, projectId: string): string | null {
  const projectsDir = path.join(workspaceRoot, PROJECTS_DIR);

  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && (entry.name === projectId || entry.name.startsWith(`${projectId}-`))) {
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
 * Returns the porch project ID (e.g. "bugfix-237" or "0073"), or null if not in a recognized worktree.
 */
export function detectProjectIdFromCwd(cwd: string): string | null {
  const normalized = path.resolve(cwd).split(path.sep).join('/');
  // Bugfix worktrees: .builders/bugfix-{N}-{slug} (slug is optional for legacy paths)
  // Protocol worktrees: .builders/{protocol}-{N}-{slug} (aspir, spir, air, tick)
  // Spec worktrees (legacy): .builders/{NNNN} (bare 4-digit ID, no slug)
  const match = normalized.match(
    /\/\.builders\/(bugfix-(\d+)(?:-[^/]*)?|(?:aspir|spir|air|tick)-(\d+)(?:-[^/]*)?|(\d{4}))(\/|$)/,
  );
  if (!match) return null;
  // Bugfix worktrees use "bugfix-N" as the porch project ID
  if (match[2]) return `bugfix-${match[2]}`;
  // Protocol worktrees (aspir, spir, air, tick) use the bare numeric ID
  if (match[3]) return match[3];
  // Spec worktrees use zero-padded numeric IDs
  return match[4];
}

export type ResolvedProjectId = { id: string; source: 'explicit' | 'cwd' | 'filesystem' };

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
  workspaceRoot: string,
): ResolvedProjectId {
  // 1. Explicit CLI argument (highest priority)
  if (provided) return { id: provided, source: 'explicit' };

  // 2. CWD worktree detection
  const fromCwd = detectProjectIdFromCwd(cwd);
  if (fromCwd) return { id: fromCwd, source: 'cwd' };

  // 3. Filesystem scan fallback
  const detected = detectProjectId(workspaceRoot);
  if (detected) return { id: detected, source: 'filesystem' };

  // 4. Error — none of the detection methods succeeded
  throw new Error('Cannot determine project ID. Provide it explicitly or run from a builder worktree.');
}

/**
 * Auto-detect project ID when only one project exists.
 * Returns null if zero or multiple projects found.
 */
export function detectProjectId(workspaceRoot: string): string | null {
  const projectsDir = path.join(workspaceRoot, PROJECTS_DIR);

  if (!fs.existsSync(projectsDir)) {
    return null;
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const projects: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // Extract project ID from directory name
      // Matches: "0076-skip-close" -> "0076", "bugfix-237-fix-name" -> "bugfix-237"
      const match = entry.name.match(/^(bugfix-\d+|\d{4})-/);
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
