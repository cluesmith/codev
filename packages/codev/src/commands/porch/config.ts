/**
 * Porch config reader — loads porch.checks from af-config.json.
 *
 * Intentionally self-contained: does NOT import from agent-farm's config
 * module, keeping porch independent of the af dependency tree.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckOverrides } from './types.js';

/**
 * Load check overrides from af-config.json in the workspace root.
 *
 * Reads only the `porch.checks` section; all other keys are ignored.
 * Returns null when:
 *   - af-config.json does not exist
 *   - af-config.json has no `porch` key
 *   - af-config.json has no `porch.checks` key
 *
 * Throws when af-config.json exists but cannot be parsed as JSON.
 */
export function loadCheckOverrides(workspaceRoot: string): CheckOverrides | null {
  const configPath = path.join(workspaceRoot, 'af-config.json');

  if (!fs.existsSync(configPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }

  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse af-config.json: ${(err as Error).message}`);
  }

  if (typeof config !== 'object' || config === null) {
    return null;
  }

  const obj = config as Record<string, unknown>;
  if (typeof obj.porch !== 'object' || obj.porch === null) {
    return null;
  }

  const porch = obj.porch as Record<string, unknown>;
  if (typeof porch.checks !== 'object' || porch.checks === null) {
    return null;
  }

  return porch.checks as CheckOverrides;
}
