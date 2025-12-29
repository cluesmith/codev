/**
 * Role prompt utilities
 * Extracted from start.ts, spawn.ts, architect.ts to eliminate duplication
 * (Maintenance Run 0004)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface RoleConfig {
  codevDir: string;
  bundledRolesDir: string;
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
 * Find role prompt file path (local first, then bundled)
 * @param config - Configuration with codevDir and bundledRolesDir
 * @param roleName - Name of the role (e.g., 'architect', 'builder')
 * @returns Path info or null if not found
 */
export function findRolePromptPath(config: RoleConfig, roleName: string): RolePromptPath | null {
  // Try local project first
  const localPath = resolve(config.codevDir, 'roles', `${roleName}.md`);
  if (existsSync(localPath)) {
    return { path: localPath, source: 'local' };
  }

  // Fall back to bundled
  const bundledPath = resolve(config.bundledRolesDir, `${roleName}.md`);
  if (existsSync(bundledPath)) {
    return { path: bundledPath, source: 'bundled' };
  }

  return null;
}

/**
 * Load role prompt content (local first, then bundled)
 * @param config - Configuration with codevDir and bundledRolesDir
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
