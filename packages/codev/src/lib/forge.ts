/**
 * Forge concept command dispatcher.
 *
 * Routes forge operations (issue fetch, PR list, etc.) through configurable
 * external commands. Default commands wrap the `gh` CLI for GitHub repos.
 * Projects override commands via the `forge` section in .codev/config.json.
 *
 * Concept commands are executed via shell (`sh -c`) to support pipes,
 * redirects, and variable expansion in user-configured commands.
 * Environment variables (CODEV_*) are set before invocation.
 *
 * @see codev/specs/589-non-github-repository-support.md
 */

import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig as loadCodevConfig } from './config.js';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the path to a provider's on-disk concept script.
 * Scripts live at `scripts/forge/<provider>/<concept>.sh` relative to the package root.
 * At runtime, __dirname is `dist/lib/` — the package root is two levels up.
 */
function resolveScriptPath(provider: string, concept: string): string {
  return resolve(__dirname, '..', '..', 'scripts', 'forge', provider, `${concept}.sh`);
}

/** Default maxBuffer for forge commands (10MB). Prevents truncation for large diffs. */
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

// =============================================================================
// Types
// =============================================================================

/** Forge config from .codev/config.json `forge` section (concept overrides + optional provider). */
export type ForgeConfig = Record<string, string | null> & { provider?: string };

/** Options for forge command execution. */
export interface ForgeCommandOptions {
  /** Working directory for command execution. */
  cwd?: string;
  /** Workspace root for loading .codev/config.json (only used if forgeConfig not provided). */
  workspaceRoot?: string;
  /** Pre-loaded forge config. Avoids repeated .codev/config.json reads. */
  forgeConfig?: ForgeConfig | null;
  /** If true, return stdout as raw string instead of parsing as JSON. */
  raw?: boolean;
  /** Maximum stdout buffer size in bytes. Defaults to 10MB. */
  maxBuffer?: number;
}

// =============================================================================
// Known concept names
// =============================================================================

const KNOWN_CONCEPTS = [
  'issue-view', 'pr-list', 'issue-list', 'issue-comment', 'pr-exists',
  'recently-closed', 'recently-merged', 'user-identity', 'team-activity',
  'on-it-timestamps', 'pr-merge', 'pr-search', 'pr-view', 'pr-diff',
  'auth-status', 'repo-archive',
] as const;

// =============================================================================
// Default concept commands — resolved lazily from on-disk scripts
// =============================================================================

let _defaultCommands: Record<string, string> | null = null;

/**
 * Build default commands from on-disk scripts (github provider).
 * Each concept maps to `scripts/forge/github/<concept>.sh`.
 * Lazily computed and cached.
 */
function getDefaultCommands(): Record<string, string> {
  if (_defaultCommands) return _defaultCommands;
  _defaultCommands = {};
  for (const concept of KNOWN_CONCEPTS) {
    _defaultCommands[concept] = resolveScriptPath('github', concept);
  }
  return _defaultCommands;
}

// =============================================================================
// Provider presets
// =============================================================================

/**
 * Build a provider preset from on-disk scripts.
 * Concepts without a script file are null (disabled).
 */
function buildPresetFromScripts(provider: string, disabledConcepts: string[] = []): Record<string, string | null> {
  const preset: Record<string, string | null> = {};
  for (const concept of KNOWN_CONCEPTS) {
    if (disabledConcepts.includes(concept)) {
      preset[concept] = null;
      continue;
    }
    const scriptPath = resolveScriptPath(provider, concept);
    if (existsSync(scriptPath)) {
      preset[concept] = scriptPath;
    } else {
      preset[concept] = null;
    }
  }
  return preset;
}

let _providerPresets: Record<string, Record<string, string | null>> | null = null;

/**
 * Built-in presets for common forges. Resolved lazily from on-disk scripts.
 *
 * NOTE: Non-GitHub presets are best-effort. Their output schemas may not conform
 * to the contracts in forge-contracts.ts. Consumers must handle null returns
 * gracefully since JSON parse failures now return null instead of raw strings.
 */
function getProviderPresets(): Record<string, Record<string, string | null>> {
  if (_providerPresets) return _providerPresets;
  _providerPresets = {
    github: getDefaultCommands(),
    gitlab: buildPresetFromScripts('gitlab', ['team-activity', 'on-it-timestamps']),
    gitea: buildPresetFromScripts('gitea', ['team-activity', 'on-it-timestamps', 'pr-search', 'pr-diff']),
  };
  return _providerPresets;
}

/** Get known provider names. */
export function getKnownProviders(): string[] {
  return Object.keys(getProviderPresets());
}

/** Resolution source for a concept command. */
export type ConceptSource = 'override' | 'preset' | 'default' | 'disabled';

export interface ConceptResolution {
  concept: string;
  command: string | null;
  source: ConceptSource;
  executable: string | null;
}

/**
 * Resolve all 15 concepts with their source and executable.
 * Used by `codev doctor` for full concept reporting.
 */
export function resolveAllConcepts(forgeConfig?: ForgeConfig | null): ConceptResolution[] {
  const concepts = Object.keys(getDefaultCommands());
  return concepts.map((concept) => {
    // Check manual override first
    if (forgeConfig && concept !== 'provider' && concept in forgeConfig) {
      const cmd = forgeConfig[concept];
      if (cmd === null) {
        return { concept, command: null, source: 'disabled' as ConceptSource, executable: null };
      }
      return { concept, command: cmd, source: 'override' as ConceptSource, executable: extractExecutable(cmd) };
    }

    // Check provider preset
    if (forgeConfig?.provider) {
      const preset = getProviderPresets()[forgeConfig.provider];
      if (preset && concept in preset) {
        const cmd = preset[concept];
        if (cmd === null) {
          return { concept, command: null, source: 'disabled' as ConceptSource, executable: null };
        }
        return { concept, command: cmd, source: 'preset' as ConceptSource, executable: extractExecutable(cmd) };
      }
    }

    // Default
    const cmd = getDefaultCommands()[concept] ?? null;
    return { concept, command: cmd, source: 'default' as ConceptSource, executable: cmd ? extractExecutable(cmd) : null };
  });
}

/**
 * Extract the executable name from a command string or script path.
 *
 * For script paths (ending in .sh): reads the script and finds the first
 * substantive command (after `exec`, or in `if/then` blocks).
 *
 * For inline commands: handles `if [ ... ]; then cmd ...` patterns and pipes.
 */
function extractExecutable(command: string): string | null {
  const trimmed = command.trim();

  // Script path: read and extract the underlying tool
  if (trimmed.endsWith('.sh') && existsSync(trimmed)) {
    try {
      const content = readFileSync(trimmed, 'utf-8');
      // Look for `exec <tool>` or first non-comment, non-shebang, non-blank line
      for (const line of content.split('\n')) {
        const l = line.trim();
        if (!l || l.startsWith('#') || l.startsWith('if') || l.startsWith('else') || l.startsWith('fi')) continue;
        const execMatch = l.match(/^exec\s+(\S+)/);
        if (execMatch) return execMatch[1];
        // First substantive command
        const token = l.split(/\s+/)[0];
        if (token && !['if', 'then', 'else', 'fi', 'test', '[', '[['].includes(token)) {
          return token;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  // Inline command: extract first real executable
  // Shell conditional: extract first command after "then"
  const thenMatch = trimmed.match(/then\s+(\S+)/);
  if (thenMatch) return thenMatch[1];
  // Pipe: first command
  const first = trimmed.split(/[|;]/).map(s => s.trim())[0];
  // Skip shell builtins
  const token = first.split(/\s+/)[0];
  if (['if', 'test', '[', '[['].includes(token)) return null;
  return token || null;
}

// =============================================================================
// Configuration loading
// =============================================================================

/**
 * Load forge configuration from .codev/config.json (via unified config loader).
 * Returns the forge section or null if not configured.
 *
 * Prefer passing forge config directly via ForgeCommandOptions.forgeConfig
 * when config is already loaded (e.g., from loadConfig in lib/config.ts).
 */
export function loadForgeConfig(workspaceRoot: string): ForgeConfig | null {
  const config = loadCodevConfig(workspaceRoot);
  return (config.forge as ForgeConfig) ?? null;
}

/** Resolve forge config from options: explicit > loaded from workspace > loaded from cwd > null. */
function resolveForgeConfig(options?: ForgeCommandOptions): ForgeConfig | null {
  if (options?.forgeConfig !== undefined) return options.forgeConfig;
  if (options?.workspaceRoot) return loadForgeConfig(options.workspaceRoot);
  if (options?.cwd) return loadForgeConfig(options.cwd);
  return null;
}

/**
 * Get the command string for a concept.
 * Resolution order: manual concept override > provider preset > default (github).
 * Returns null if concept is explicitly disabled (set to null in config).
 */
export function getForgeCommand(
  concept: string,
  forgeConfig?: ForgeConfig | null,
): string | null {
  // Check manual concept overrides first (excluding 'provider' key)
  if (forgeConfig && concept !== 'provider' && concept in forgeConfig) {
    return forgeConfig[concept]; // null means explicitly disabled
  }

  // Check provider preset
  if (forgeConfig?.provider) {
    const preset = getProviderPresets()[forgeConfig.provider];
    if (preset && concept in preset) {
      return preset[concept]; // null means not supported by this provider
    }
  }

  // Fall back to default (github)
  return getDefaultCommands()[concept] ?? null;
}

/**
 * Check if a concept is explicitly disabled (set to null in config).
 */
export function isConceptDisabled(
  concept: string,
  forgeConfig?: ForgeConfig | null,
): boolean {
  if (!forgeConfig) return false;
  return concept in forgeConfig && forgeConfig[concept] === null;
}

// =============================================================================
// Execution
// =============================================================================

/**
 * Execute a forge concept command asynchronously.
 *
 * Sets CODEV_* environment variables, executes the configured command
 * via shell, and parses stdout as JSON. Returns null on failure.
 *
 * @param concept - The concept name (e.g., 'issue-view', 'pr-list')
 * @param env - Additional environment variables to set (CODEV_* prefix recommended)
 * @param options - Execution options
 * @returns Parsed JSON from stdout, raw string for non-JSON concepts, or null on failure
 */
export async function executeForgeCommand(
  concept: string,
  env?: Record<string, string>,
  options?: ForgeCommandOptions,
): Promise<unknown | null> {
  const forgeConfig = resolveForgeConfig(options);
  const command = getForgeCommand(concept, forgeConfig);

  if (command === null) {
    return null;
  }

  try {
    const { stdout } = await execAsync(command, {
      cwd: options?.cwd,
      env: { ...process.env, ...env },
      timeout: 30_000,
      maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
    });

    return parseOutput(stdout, options?.raw);
  } catch (err: unknown) {
    logDebug(concept, err);
    return null;
  }
}

/**
 * Execute a forge concept command synchronously.
 *
 * Same as executeForgeCommand but blocks until completion.
 * Use sparingly — prefer the async variant.
 */
export function executeForgeCommandSync(
  concept: string,
  env?: Record<string, string>,
  options?: ForgeCommandOptions,
): unknown | null {
  const forgeConfig = resolveForgeConfig(options);
  const command = getForgeCommand(concept, forgeConfig);

  if (command === null) {
    return null;
  }

  try {
    const stdout = execSync(command, {
      cwd: options?.cwd,
      env: { ...process.env, ...env },
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return parseOutput(stdout, options?.raw);
  } catch (err: unknown) {
    logDebug(concept, err, true);
    return null;
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

/** Parse command stdout: try JSON when raw=false (null on parse failure), raw string otherwise. */
function parseOutput(stdout: string, raw?: boolean): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  if (raw) return trimmed;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Not valid JSON — return null so downstream code doesn't cast a raw
    // string to typed objects (e.g. IssueViewResult, PrListItem[]).
    return null;
  }
}

/** Log concept failure at debug level. */
function logDebug(concept: string, err: unknown, sync = false): void {
  if (process.env.CODEV_DEBUG) {
    const msg = err instanceof Error ? err.message : String(err);
    const suffix = sync ? ' (sync)' : '';
    console.warn(`[forge] concept '${concept}'${suffix} failed: ${msg}`);
  }
}

// =============================================================================
// Convenience helpers
// =============================================================================

/**
 * Get the list of all known concept names.
 */
export function getKnownConcepts(): string[] {
  return Object.keys(getDefaultCommands());
}

/**
 * Get the default command for a concept (ignoring user config).
 * Useful for documentation and doctor checks.
 */
export function getDefaultCommand(concept: string): string | null {
  return getDefaultCommands()[concept] ?? null;
}

/**
 * Validate forge configuration.
 * Returns an array of diagnostic messages.
 * Used by `codev doctor`.
 */
export function validateForgeConfig(
  forgeConfig: ForgeConfig,
): { concept: string; status: 'ok' | 'disabled' | 'unknown_concept' | 'empty_command' | 'provider'; message: string }[] {
  const results: { concept: string; status: 'ok' | 'disabled' | 'unknown_concept' | 'empty_command' | 'provider'; message: string }[] = [];

  // Report provider if set
  if (forgeConfig.provider) {
    const providerName = forgeConfig.provider;
    if (getProviderPresets()[providerName]) {
      results.push({ concept: 'provider', status: 'provider', message: `Provider: ${providerName}` });
    } else {
      results.push({ concept: 'provider', status: 'unknown_concept', message: `Unknown provider '${providerName}' (known: ${Object.keys(getProviderPresets()).join(', ')})` });
    }
  }

  for (const [concept, command] of Object.entries(forgeConfig)) {
    if (concept === 'provider') continue; // Already handled above
    if (command === null) {
      results.push({ concept, status: 'disabled', message: `Concept '${concept}' is explicitly disabled` });
    } else if (command === '') {
      results.push({ concept, status: 'empty_command', message: `Concept '${concept}' has an empty command string` });
    } else if (!(concept in getDefaultCommands())) {
      results.push({ concept, status: 'unknown_concept', message: `Concept '${concept}' is not a known forge concept` });
    } else {
      results.push({ concept, status: 'ok', message: `Concept '${concept}' overridden: ${command}` });
    }
  }

  return results;
}
