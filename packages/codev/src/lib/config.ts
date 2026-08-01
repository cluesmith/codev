/**
 * Unified configuration loader for Codev.
 *
 * Loads and merges config from five layers (lowest → highest priority):
 *   1. Hardcoded defaults
 *   2. <cache>/config.json        (remote framework base config)
 *   3. ~/.codev/config.json       (global, per-user, across all projects)
 *   4. .codev/config.json         (project, committed, shared with the team)
 *   5. .codev/config.local.json   (project, per-engineer, gitignored)
 *
 * af-config.json is no longer supported — its presence triggers a hard error
 * directing the user to run `codev update` to migrate.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { getFrameworkCacheDir as _getFrameworkCacheDir } from './skeleton.js';
import { validateCustomHarnessConfig } from '../agent-farm/utils/harness.js';
import {
  validateConsultModels,
  validateReasoningEffort,
  validatePricing,
  validateConsultationConfig,
  type CodexPricing,
} from './consult-lanes.js';
import type { ModelReasoningEffort } from '@openai/codex-sdk';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodevConfig {
  shell?: {
    architect?: string | string[];
    architectHarness?: string;
    builder?: string | string[];
    builderHarness?: string;
    shell?: string | string[];
  };
  /** Custom harness provider definitions. Keys are harness names, values define role injection. */
  harness?: Record<string, {
    roleArgs: string[];
    roleEnv?: Record<string, string>;
    roleScriptFragment: string;
    roleScriptEnv?: Record<string, string>;
  }>;
  porch?: {
    autoOpenArtifacts?: boolean;
    checks?: Record<string, CheckOverride>;
    /**
     * Which lanes run a consultation. Precedence, highest first:
     *   byProtocol[P].modelsByType[T] > byProtocol[P].models > modelsByType[T] > models
     *   > the protocol's own verify.models
     *
     * `byProtocol` exists so widening review coverage globally does not silently inflate lighter
     * protocols (e.g. PIR's 2-model CMAP footprint).
     */
    consultation?: {
      models?: string | string[];
      modelsByType?: Record<string, string | string[]>;
      byProtocol?: Record<string, {
        models?: string | string[];
        modelsByType?: Record<string, string | string[]>;
      }>;
    };
  };
  consult?: {
    /**
     * Long-lived integration branch to anchor `consult --type integration`
     * diffs on (e.g. `ci`). When set, integration reviews compute the diff
     * locally as `git diff origin/<integrationBranch>...origin/<head>` instead
     * of `gh pr diff` (the PR's host-recorded base). Overridden per-invocation
     * by the `--base <ref>` flag. Unset → default behavior (`gh pr diff`).
     */
    integrationBranch?: string;
    /**
     * Per-lane model ids. Unset lanes keep the backend's own default.
     *
     * Ids are validated for SYNTAX only — Codev never checks whether a model exists, because any
     * local catalog of ids goes stale the moment a provider ships a new model. The provider is the
     * authority: a rejected id fails the consultation loudly, with no fallback to the default.
     */
    models?: Partial<Record<'claude' | 'codex' | 'gemini', string>>;
    /** Codex-only; a closed enum bound to the SDK's ModelReasoningEffort union. */
    reasoningEffort?: { codex?: ModelReasoningEffort };
    /** Codex-only per-1M token rates; all three required together. */
    pricing?: { codex?: CodexPricing };
  };
  forge?: Record<string, string | null> & { provider?: string };
  templates?: {
    dir?: string;
  };
  roles?: {
    dir?: string;
  };
  artifacts?: {
    backend?: 'local' | 'cli';
    command?: string;
    scope?: string;
  };
  terminal?: {
    backend?: 'node-pty';
  };
  /**
   * Mailbox delivery settings (Spec 1313). Tower-global — the drainer prunes
   * terminal rows across all workspaces in the user-global `global.db`, so this is
   * read from the user-global `~/.codev/config.json` layer, not a per-workspace one.
   */
  mailbox?: {
    /**
     * Days a *terminal* mailbox row (delivered/superseded/dismissed) is retained
     * before the backstop prune drops it. Held rows are never TTL-dropped. Spec
     * default 30. (Phase 7 adds escalation-age to this same section.)
     */
    retentionDays?: number;
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
  mailbox: {
    retentionDays: 30,
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
 * Resolve the project-local override config path.
 *
 * Returns .codev/config.local.json if it exists, otherwise null. No
 * legacy alias to consider — this layer is new. The local file is
 * intended to be gitignored and per-engineer.
 */
export function resolveLocalConfigPath(workspaceRoot: string): string | null {
  const localPath = resolve(workspaceRoot, '.codev', 'config.local.json');
  if (existsSync(localPath)) return localPath;
  return null;
}

/**
 * Load the full merged config for a workspace.
 *
 * Layer order (lowest → highest priority):
 *   1. Hardcoded defaults
 *   2. <cache>/config.json (remote framework base config)
 *   3. ~/.codev/config.json (global, per-user, across all projects)
 *   4. .codev/config.json (project, committed, shared with the team)
 *   5. .codev/config.local.json (project, per-engineer, gitignored)
 *
 * Layer 5 is the place to put preferences that vary between engineers
 * working on the same repo (e.g. different `worktree.devCommand` for
 * web vs mobile roles) — Layer 3 spans every project so can't express
 * "in *this* repo I want X." Add the file to your project's
 * `.gitignore` so it's never accidentally committed.
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

  // Layer 5: project-local override (gitignored, per-engineer).
  const localPath = resolveLocalConfigPath(workspaceRoot);
  if (localPath) {
    const localConfig = readJsonFile(localPath);
    if (localConfig) {
      merged = deepMerge(merged as unknown as Record<string, unknown>, localConfig) as CodevConfig;
    }
  }

  // Validate custom harness definitions at load time
  if (merged.harness) {
    for (const [name, def] of Object.entries(merged.harness)) {
      validateCustomHarnessConfig(name, def);
    }
  }

  // Validate consult lane config at LOAD time, alongside harness validation above.
  //
  // Deliberately here rather than at the point of use: a typo must fail before anything runs, not
  // when a consultation is finally dispatched. Consequence, accepted: malformed consult config
  // fails unrelated commands (`afx status` etc.), exactly as a malformed `harness` block already
  // does. That is the fail-fast contract, not a regression.
  validateConsultModels(merged.consult?.models);
  validateReasoningEffort(merged.consult?.reasoningEffort);
  validatePricing(merged.consult?.pricing);
  validateConsultationConfig(merged.porch?.consultation, workspaceRoot);

  return merged;
}

/**
 * Report which config file supplied a given key path, for diagnostics.
 *
 * `loadConfig` deep-merges and discards origin, so provenance is recovered by re-reading the layers
 * rather than by threading it through `deepMerge` — that function underpins the whole config system
 * and should not grow this concern for the sake of an error message.
 *
 * Called only on error paths, so the extra reads are irrelevant. Returns null when no file defines
 * the key (i.e. it came from a hardcoded default), in which case there is nothing for a user to fix.
 */
export function findConfigSource(workspaceRoot: string, keyPath: string[]): string | null {
  const cacheDir = _getFrameworkCacheDir();
  const layers: string[] = [];
  if (cacheDir) layers.push(resolve(cacheDir, 'config.json'));
  layers.push(resolve(homedir(), '.codev', 'config.json'));
  const projectPath = resolveProjectConfigPath(workspaceRoot);
  if (projectPath) layers.push(projectPath);
  const localPath = resolveLocalConfigPath(workspaceRoot);
  if (localPath) layers.push(localPath);

  let found: string | null = null;
  for (const layer of layers) {
    let parsed: Record<string, unknown> | null;
    try {
      parsed = readJsonFile(layer);
    } catch {
      continue; // a layer we can't parse can't be the source we name
    }
    if (!parsed) continue;

    let cursor: unknown = parsed;
    let defined = true;
    for (const key of keyPath) {
      if (typeof cursor !== 'object' || cursor === null || !(key in (cursor as Record<string, unknown>))) {
        defined = false;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[key];
    }
    if (defined) found = layer; // later layers win, matching merge precedence
  }
  return found;
}

/**
 * Get the default config (useful for init/adopt to write a starter config).
 */
export function getDefaultConfig(): CodevConfig {
  return structuredClone(DEFAULT_CONFIG);
}
