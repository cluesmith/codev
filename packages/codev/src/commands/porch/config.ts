/**
 * Porch config reader — loads porch.checks from .codev/config.json.
 *
 * Delegates to the unified config loader in lib/config.ts.
 */

import { loadConfig } from '../../lib/config.js';
import { resolveLaneComposition, type ConsultMode } from '../../lib/consult-lanes.js';
import type { CheckOverrides } from './types.js';

/**
 * Resolve which consultation lanes run for a protocol + review type.
 *
 * THE single implementation. `porch next` (which emits the consult commands) and `porch done`
 * (which enforces that a review file exists per lane) previously each carried their own copy, and
 * the copies had drifted in three ways: `done` did no lane-name validation, did not normalize a
 * single-string value into a list, and wrapped config loading in a bare `catch` that turned any
 * config error into a silent fall-back to protocol defaults. Drift between them is not cosmetic —
 * `next` emitting one lane set while `done` demands another is a deadlock the user cannot debug,
 * because neither command prints the set it derived.
 *
 * Precedence is `resolveLaneComposition`'s (config > protocol, most specific first); this wrapper
 * only supplies the config. Validation happens in `loadConfig`, so a malformed lane list throws
 * here rather than resolving to something plausible.
 */
export function resolveConsultationModels(
  workspaceRoot: string,
  protocolModels: string[],
  protocol: string,
  reviewType: string | undefined,
): { models: string[]; mode: ConsultMode } {
  const config = loadConfig(workspaceRoot);
  return resolveLaneComposition(
    config.porch?.consultation,
    protocol,
    reviewType,
    protocolModels,
    workspaceRoot,
  );
}

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
