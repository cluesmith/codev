/**
 * Unified configuration loader for Codev.
 *
 * Loads and merges config from three layers (lowest → highest priority):
 *   1. Hardcoded defaults
 *   2. ~/.codev/config.json  (global)
 *   3. .codev/config.json    (project)
 *
 * af-config.json is no longer supported — its presence triggers a hard error
 * directing the user to run `codev update` to migrate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getFrameworkCacheDir as _getFrameworkCacheDir } from './skeleton.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodevConfig {
  shell?: {
    architect?: string | string[];
    builder?: string | string[];
    shell?: string | string[];
  };
  porch?: {
    checks?: Record<string, CheckOverride>;
    consultation?: {
      models?: string | string[];
    };
  };
  forge?: Record<string, string | null> & { provider?: string };
  templates?: {
    dir?: string;
  };
  roles?: {
    dir?: string;
  };
  artifacts?: {
    backend?: 'local' | 'cli' | 'fava-trails';
    command?: string;
    scope?: string;
  };
  terminal?: {
    backend?: 'node-pty';
  };
  dashboard?: {
    frontend?: 'react' | 'legacy';
  };
  framework?: {
    source?: string;
    ref?: string;
    type?: 'forge' | 'command';
    command?: string;
  };
}

export interface CheckOverride {
  command?: string;
  cwd?: string;
  skip?: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CodevConfig = {
  shell: {
    architect: 'claude',
    builder: 'claude',
    shell: 'bash',
  },
  porch: {
    consultation: {
      models: ['gemini', 'codex', 'claude'],
    },
  },
  framework: {
    source: 'local',
  },
};

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

/**
 * Deep-merge `override` into `base`.
 *
 * Semantics (per spec):
 *  - Objects: recursively merged.
 *  - Arrays: replaced, not concatenated.
 *  - null value: deletes the key from the result.
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Record<string, unknown>): T {
  const result = { ...base };

  for (const key of Object.keys(override)) {
    const overrideVal = override[key];

    // null means "delete this key"
    if (overrideVal === null) {
      delete (result as Record<string, unknown>)[key];
      continue;
    }

    const baseVal = (result as Record<string, unknown>)[key];

    // Both objects (and not arrays) → recurse
    if (
      typeof baseVal === 'object' && baseVal !== null && !Array.isArray(baseVal) &&
      typeof overrideVal === 'object' && overrideVal !== null && !Array.isArray(overrideVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
      continue;
    }

    // Everything else (arrays, primitives): replace
    (result as Record<string, unknown>)[key] = overrideVal;
  }

  return result;
}

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

function readJsonFile(filePath: string): Record<string, unknown> | null {
  if (!existsSync(filePath)) return null;

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    // Permission errors: warn and fall back to defaults (per spec)
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      console.warn(`Warning: Cannot read ${filePath} (${code}). Using defaults.`);
      return null;
    }
    throw err;
  }

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the project-level config path.
 *
 * Returns .codev/config.json if it exists, otherwise null.
 * Hard error if legacy af-config.json is detected — user must run
 * `codev update` to migrate.
 */
export function resolveProjectConfigPath(workspaceRoot: string): string | null {
  const newPath = resolve(workspaceRoot, '.codev', 'config.json');
  const legacyPath = resolve(workspaceRoot, 'af-config.json');

  if (existsSync(legacyPath)) {
    throw new Error(
      `af-config.json is no longer supported. Run 'codev update' to migrate to .codev/config.json.`
    );
  }

  if (existsSync(newPath)) return newPath;
  return null;
}

/**
 * Load the full merged config for a workspace.
 *
 * Layer order (lowest → highest priority):
 *   1. Hardcoded defaults
 *   2. <cache>/config.json (remote framework base config)
 *   3. ~/.codev/config.json (global)
 *   4. .codev/config.json (project)
 */
export function loadConfig(workspaceRoot: string): CodevConfig {
  let merged: CodevConfig = structuredClone(DEFAULT_CONFIG);

  // Layer 2: remote framework base config (if cached)
  const cacheDir = _getFrameworkCacheDir();
  if (cacheDir) {
    const cacheConfigPath = resolve(cacheDir, 'config.json');
    const cacheConfig = readJsonFile(cacheConfigPath);
    if (cacheConfig) {
      merged = deepMerge(merged as unknown as Record<string, unknown>, cacheConfig) as CodevConfig;
    }
  }

  // Layer 3: global config
  const globalPath = resolve(homedir(), '.codev', 'config.json');
  const globalConfig = readJsonFile(globalPath);
  if (globalConfig) {
    merged = deepMerge(merged as unknown as Record<string, unknown>, globalConfig) as CodevConfig;
  }

  // Layer 4: project config (also checks for legacy af-config.json)
  const projectPath = resolveProjectConfigPath(workspaceRoot);
  if (projectPath) {
    const projectConfig = readJsonFile(projectPath);
    if (projectConfig) {
      merged = deepMerge(merged as unknown as Record<string, unknown>, projectConfig) as CodevConfig;
    }
  }

  return merged;
}

/**
 * Get the default config (useful for init/adopt to write a starter config).
 */
export function getDefaultConfig(): CodevConfig {
  return structuredClone(DEFAULT_CONFIG);
}
