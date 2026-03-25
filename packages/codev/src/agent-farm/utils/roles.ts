/**
 * Role prompt utilities
 * Extracted from start.ts, spawn.ts, architect.ts to eliminate duplication
 * (Maintenance Run 0004)
 *
 * Uses the unified file resolver for per-file resolution:
 *   .codev/roles/<name>.md → codev/roles/<name>.md → skeleton/roles/<name>.md
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCodevFile } from '../../lib/skeleton.js';

export interface RoleConfig {
  codevDir: string;
  bundledRolesDir: string;
  /** Workspace root for unified file resolution. Falls back to bundledRolesDir if not set. */
  workspaceRoot?: string;
}

export interface RolePromptPath {
  path: string;
  source: 'local' | 'bundled';
}

export interface RolePromptContent {
  content: string;
  source: 'local' | 'bundled';
}

/**
 * Find role prompt file path using unified per-file resolution.
 * Each role file is resolved independently so partial overrides work correctly.
 *
 * @param config - Configuration with codevDir, bundledRolesDir, and optionally workspaceRoot
 * @param roleName - Name of the role (e.g., 'architect', 'builder')
 * @returns Path info or null if not found
 */
export function findRolePromptPath(config: RoleConfig, roleName: string): RolePromptPath | null {
  // Use unified resolver when workspaceRoot is available
  if (config.workspaceRoot) {
    const resolved = resolveCodevFile(`roles/${roleName}.md`, config.workspaceRoot);
    if (resolved) {
      // Determine source based on path
      const isLocal = resolved.includes('.codev/') || resolved.includes('codev/roles/');
      return { path: resolved, source: isLocal ? 'local' : 'bundled' };
    }
    return null;
  }

  // Legacy fallback for callers that don't provide workspaceRoot
  const localPath = resolve(config.codevDir, 'roles', `${roleName}.md`);
  if (existsSync(localPath)) {
    return { path: localPath, source: 'local' };
  }

  const bundledPath = resolve(config.bundledRolesDir, `${roleName}.md`);
  if (existsSync(bundledPath)) {
    return { path: bundledPath, source: 'bundled' };
  }

  return null;
}

/**
 * Load role prompt content using unified per-file resolution.
 * @param config - Configuration with codevDir, bundledRolesDir, and optionally workspaceRoot
 * @param roleName - Name of the role (e.g., 'architect', 'builder')
 * @returns Content and source or null if not found
 */
export function loadRolePrompt(config: RoleConfig, roleName: string): RolePromptContent | null {
  const result = findRolePromptPath(config, roleName);
  if (!result) {
    return null;
  }
  return {
    content: readFileSync(result.path, 'utf-8'),
    source: result.source,
  };
}
