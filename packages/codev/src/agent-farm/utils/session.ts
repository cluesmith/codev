/**
 * Shared session-naming utilities for Agent Farm.
 * Centralizes tmux session name generation to prevent drift between commands.
 */

import { basename } from 'node:path';
import type { Config } from '../types.js';

/**
 * Get a namespaced tmux session name for a builder: builder-{project}-{id}
 */
export function getBuilderSessionName(config: Config, builderId: string): string {
  return `builder-${basename(config.projectRoot)}-${builderId}`;
}
