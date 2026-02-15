/**
 * Shared session-naming utilities for Agent Farm.
 * Centralizes session name generation to prevent drift between commands.
 */

import { basename } from 'node:path';
import type { Config } from '../types.js';

/**
 * Get a namespaced session name for a builder: builder-{project}-{id}
 */
export function getBuilderSessionName(config: Config, builderId: string): string {
  return `builder-${basename(config.workspaceRoot)}-${builderId}`;
}

/**
 * Parsed metadata from a session name.
 * Our naming convention: architect-{basename}, builder-{basename}-{specId}, shell-{basename}-{shellId}
 */
export interface ParsedSession {
  type: 'architect' | 'builder' | 'shell';
  projectBasename: string;
  roleId: string | null;  // specId for builders, shellId for shells, null for architect
}

/**
 * Parse a codev session name to extract type, project, and role.
 * Returns null if the name doesn't match any known codev pattern.
 *
 * Examples:
 *   "architect-codev-public"                → { type: 'architect', projectBasename: 'codev-public', roleId: null }
 *   "builder-codevos_ai-0001"               → { type: 'builder', projectBasename: 'codevos_ai', roleId: '0001' }
 *   "builder-codev-public-bugfix-242"       → { type: 'builder', projectBasename: 'codev-public', roleId: 'bugfix-242' }
 *   "builder-codev-public-task-AbCd"        → { type: 'builder', projectBasename: 'codev-public', roleId: 'task-AbCd' }
 *   "builder-codev-public-worktree-QwEr"    → { type: 'builder', projectBasename: 'codev-public', roleId: 'worktree-QwEr' }
 *   "shell-codev-public-shell-1"            → { type: 'shell', projectBasename: 'codev-public', roleId: 'shell-1' }
 */
export function parseSessionName(name: string): ParsedSession | null {
  // architect-{basename}
  const architectMatch = name.match(/^architect-(.+)$/);
  if (architectMatch) {
    return { type: 'architect', projectBasename: architectMatch[1], roleId: null };
  }

  // builder-{basename}-bugfix-{N} — bugfix builder (issue number)
  const bugfixMatch = name.match(/^builder-(.+)-(bugfix-\d+)$/);
  if (bugfixMatch) {
    return { type: 'builder', projectBasename: bugfixMatch[1], roleId: bugfixMatch[2] };
  }

  // builder-{basename}-task-{shortId} — ad-hoc task builder (shortId is URL-safe base64: a-zA-Z0-9_-)
  const taskMatch = name.match(/^builder-(.+)-(task-[a-zA-Z0-9_-]+)$/);
  if (taskMatch) {
    return { type: 'builder', projectBasename: taskMatch[1], roleId: taskMatch[2] };
  }

  // builder-{basename}-worktree-{shortId} — generic worktree builder (shortId is URL-safe base64)
  const worktreeMatch = name.match(/^builder-(.+)-(worktree-[a-zA-Z0-9_-]+)$/);
  if (worktreeMatch) {
    return { type: 'builder', projectBasename: worktreeMatch[1], roleId: worktreeMatch[2] };
  }

  // builder-{basename}-{specId} — SPIR builder (spec ID is digits, any length)
  const builderMatch = name.match(/^builder-(.+)-(\d+)$/);
  if (builderMatch) {
    return { type: 'builder', projectBasename: builderMatch[1], roleId: builderMatch[2] };
  }

  // shell-{basename}-{shellId} — shellId is "shell-N" (last two segments)
  const shellMatch = name.match(/^shell-(.+)-(shell-\d+)$/);
  if (shellMatch) {
    return { type: 'shell', projectBasename: shellMatch[1], roleId: shellMatch[2] };
  }

  return null;
}
