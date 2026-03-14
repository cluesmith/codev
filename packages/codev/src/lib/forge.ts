/**
 * Forge concept command dispatcher.
 *
 * Routes forge operations (issue fetch, PR list, etc.) through configurable
 * external commands. Default commands wrap the `gh` CLI for GitHub repos.
 * Projects override commands via the `forge` section in af-config.json.
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
import { resolve } from 'node:path';

const execAsync = promisify(exec);

// =============================================================================
// Types
// =============================================================================

/** Forge config from af-config.json `forge` section (concept overrides + optional provider). */
export type ForgeConfig = Record<string, string | null> & { provider?: string };

/** Options for forge command execution. */
export interface ForgeCommandOptions {
  /** Working directory for command execution. */
  cwd?: string;
  /** Workspace root for loading af-config.json (only used if forgeConfig not provided). */
  workspaceRoot?: string;
  /** Pre-loaded forge config. Avoids repeated af-config.json reads. */
  forgeConfig?: ForgeConfig | null;
  /** If true, return stdout as raw string instead of parsing as JSON. */
  raw?: boolean;
}

// =============================================================================
// Default concept commands (gh-based)
// =============================================================================

const DEFAULT_COMMANDS: Record<string, string> = {
  // Core issue/PR concepts
  'issue-view': 'gh issue view "$CODEV_ISSUE_ID" --json title,body,state,comments',
  'pr-list': 'gh pr list --json number,title,url,reviewDecision,body,createdAt',
  'issue-list': 'gh issue list --limit 200 --json number,title,url,labels,createdAt',
  'issue-comment': 'gh issue comment "$CODEV_ISSUE_ID" --body "$CODEV_COMMENT_BODY"',
  'pr-exists': 'gh pr list --state all --head "$CODEV_BRANCH_NAME" --json number --jq "length > 0"',
  'recently-closed': 'if [ -n "$CODEV_SINCE_DATE" ]; then gh issue list --state closed --search "closed:>$CODEV_SINCE_DATE" --json number,title,url,labels,createdAt,closedAt --limit 50; else gh issue list --state closed --json number,title,url,labels,createdAt,closedAt --limit 50; fi',
  'recently-merged': 'if [ -n "$CODEV_SINCE_DATE" ]; then gh pr list --state merged --search "merged:>$CODEV_SINCE_DATE" --json number,title,url,body,createdAt,mergedAt,headRefName --limit 50; else gh pr list --state merged --json number,title,url,body,createdAt,mergedAt,headRefName --limit 50; fi',
  'user-identity': 'gh api user --jq .login',
  'team-activity': 'gh api graphql -f query="$CODEV_GRAPHQL_QUERY"',
  'on-it-timestamps': 'gh api graphql -f query="$CODEV_GRAPHQL_QUERY" -f owner="$CODEV_REPO_OWNER" -f name="$CODEV_REPO_NAME"',
  'pr-merge': 'gh pr merge "$CODEV_PR_NUMBER" --merge',
  // Additional concepts (found during plan review)
  'pr-search': 'gh pr list --search "$CODEV_SEARCH_QUERY" --json number,headRefName',
  'pr-view': 'if [ "$CODEV_INCLUDE_COMMENTS" = "1" ]; then gh pr view "$CODEV_PR_NUMBER" --comments; else gh pr view "$CODEV_PR_NUMBER" --json title,body,state,author,baseRefName,headRefName,additions,deletions; fi',
  'pr-diff': 'if [ "$CODEV_DIFF_NAME_ONLY" = "1" ]; then gh pr diff "$CODEV_PR_NUMBER" --name-only; else gh pr diff "$CODEV_PR_NUMBER"; fi',
  'gh-auth-status': 'gh auth status',
};

// =============================================================================
// Provider presets
// =============================================================================

/** Built-in presets for common forges. Concepts without an equivalent are null (disabled). */
const PROVIDER_PRESETS: Record<string, Record<string, string | null>> = {
  github: DEFAULT_COMMANDS,
  gitlab: {
    'issue-view': 'glab issue view "$CODEV_ISSUE_ID" --output json',
    'pr-list': 'glab mr list --output json',
    'issue-list': 'glab issue list --per-page 200 --output json',
    'issue-comment': 'glab issue note "$CODEV_ISSUE_ID" --message "$CODEV_COMMENT_BODY"',
    'pr-exists': 'glab mr list --source-branch "$CODEV_BRANCH_NAME" --output json | jq "length > 0"',
    'recently-closed': 'glab issue list --state closed --per-page 50 --output json',
    'recently-merged': 'glab mr list --state merged --per-page 50 --output json',
    'user-identity': 'glab auth status --show-token 2>&1 | grep "Logged in" | sed "s/.*as //" | sed "s/ .*//"',
    'team-activity': null,
    'on-it-timestamps': null,
    'pr-merge': 'glab mr merge "$CODEV_PR_NUMBER" --yes',
    'pr-search': 'glab mr list --search "$CODEV_SEARCH_QUERY" --output json',
    'pr-view': 'glab mr view "$CODEV_PR_NUMBER" --output json',
    'pr-diff': 'glab mr diff "$CODEV_PR_NUMBER"',
    'gh-auth-status': 'glab auth status',
  },
  gitea: {
    'issue-view': 'tea issues view "$CODEV_ISSUE_ID" --output json',
    'pr-list': 'tea pulls list --output json',
    'issue-list': 'tea issues list --limit 200 --output json',
    'issue-comment': 'tea issues comment "$CODEV_ISSUE_ID" "$CODEV_COMMENT_BODY"',
    'pr-exists': 'tea pulls list --fields index --output json | jq "[.[] | select(.head.ref == \\"$CODEV_BRANCH_NAME\\")] | length > 0"',
    'recently-closed': 'tea issues list --state closed --limit 50 --output json',
    'recently-merged': 'tea pulls list --state closed --limit 50 --output json',
    'user-identity': 'tea whoami --output json | jq -r ".login"',
    'team-activity': null,
    'on-it-timestamps': null,
    'pr-merge': 'tea pulls merge "$CODEV_PR_NUMBER"',
    'pr-search': null,
    'pr-view': 'tea pulls view "$CODEV_PR_NUMBER" --output json',
    'pr-diff': null,
    'gh-auth-status': 'tea whoami',
  },
};

/** Get known provider names. */
export function getKnownProviders(): string[] {
  return Object.keys(PROVIDER_PRESETS);
}

// =============================================================================
// Configuration loading
// =============================================================================

/**
 * Load forge configuration from af-config.json.
 * Returns the forge section or null if not configured.
 *
 * Prefer passing forge config directly via ForgeCommandOptions.forgeConfig
 * when config is already loaded (e.g., from loadUserConfig in config.ts).
 */
export function loadForgeConfig(workspaceRoot: string): ForgeConfig | null {
  const configPath = resolve(workspaceRoot, 'af-config.json');
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    return config.forge ?? null;
  } catch {
    return null;
  }
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
    const preset = PROVIDER_PRESETS[forgeConfig.provider];
    if (preset && concept in preset) {
      return preset[concept]; // null means not supported by this provider
    }
  }

  // Fall back to default (github)
  return DEFAULT_COMMANDS[concept] ?? null;
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

/** Parse command stdout: try JSON, fall back to raw string, null if empty. */
function parseOutput(stdout: string, raw?: boolean): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  if (raw) return trimmed;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Not valid JSON — return as raw string.
    // Handles concepts like user-identity that return plain text.
    return trimmed;
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
  return Object.keys(DEFAULT_COMMANDS);
}

/**
 * Get the default command for a concept (ignoring user config).
 * Useful for documentation and doctor checks.
 */
export function getDefaultCommand(concept: string): string | null {
  return DEFAULT_COMMANDS[concept] ?? null;
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
    if (PROVIDER_PRESETS[providerName]) {
      results.push({ concept: 'provider', status: 'provider', message: `Provider: ${providerName}` });
    } else {
      results.push({ concept: 'provider', status: 'unknown_concept', message: `Unknown provider '${providerName}' (known: ${Object.keys(PROVIDER_PRESETS).join(', ')})` });
    }
  }

  for (const [concept, command] of Object.entries(forgeConfig)) {
    if (concept === 'provider') continue; // Already handled above
    if (command === null) {
      results.push({ concept, status: 'disabled', message: `Concept '${concept}' is explicitly disabled` });
    } else if (command === '') {
      results.push({ concept, status: 'empty_command', message: `Concept '${concept}' has an empty command string` });
    } else if (!(concept in DEFAULT_COMMANDS)) {
      results.push({ concept, status: 'unknown_concept', message: `Concept '${concept}' is not a known forge concept` });
    } else {
      results.push({ concept, status: 'ok', message: `Concept '${concept}' overridden: ${command}` });
    }
  }

  return results;
}
