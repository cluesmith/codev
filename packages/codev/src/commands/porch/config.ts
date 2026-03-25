/**
 * Porch config reader — loads porch.checks from .codev/config.json.
 *
 * Delegates to the unified config loader in lib/config.ts.
 */

import { loadConfig } from '../../lib/config.js';
import type { CheckOverrides } from './types.js';

/**
 * Load check overrides from the unified config (.codev/config.json).
 *
 * Reads only the `porch.checks` section; all other keys are ignored.
 * Returns null when no `porch.checks` key is configured.
 *
 * Throws when config exists but cannot be parsed as JSON,
 * or when the legacy af-config.json is found.
 */
export function loadCheckOverrides(workspaceRoot: string): CheckOverrides | null {
  const config = loadConfig(workspaceRoot);

  if (typeof config.porch !== 'object' || config.porch === null) {
    return null;
  }

  const checks = config.porch.checks;
  if (typeof checks !== 'object' || checks === null || Array.isArray(checks)) {
    return null;
  }

  return checks as CheckOverrides;
}
