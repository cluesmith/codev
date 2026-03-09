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
// Default concept commands (gh-based)
// =============================================================================

const DEFAULT_COMMANDS: Record<string, string> = {
  // Core issue/PR concepts
  'issue-view': 'gh issue view "$CODEV_ISSUE_ID" --json title,body,state,comments',
  'pr-list': 'gh pr list --json number,title,url,reviewDecision,body,createdAt',
  'issue-list': 'gh issue list --limit 200 --json number,title,url,labels,createdAt',
  'issue-comment': 'gh issue comment "$CODEV_ISSUE_ID" --body "$CODEV_COMMENT_BODY"',
  'pr-exists': 'gh pr list --state all --head "$CODEV_BRANCH_NAME" --json number --jq "length > 0"',
  'recently-closed': 'gh issue list --state closed --json number,title,url,labels,createdAt,closedAt --limit 50',
  'recently-merged': 'gh pr list --state merged --json number,title,url,body,createdAt,mergedAt,headRefName --limit 50',
  'user-identity': 'gh api user --jq .login',
  'team-activity': 'gh api graphql -f query="$CODEV_GRAPHQL_QUERY"',
  'on-it-timestamps': 'gh api graphql -f query="$CODEV_GRAPHQL_QUERY"',
  'pr-merge': 'gh pr merge "$CODEV_PR_NUMBER" --merge',
  // Additional concepts (found during plan review)
  'pr-search': 'gh pr list --search "$CODEV_SEARCH_QUERY" --json number,headRefName',
  'pr-view': 'gh pr view "$CODEV_PR_NUMBER" --json title,body,state,author,baseRefName,headRefName,additions,deletions',
  'pr-diff': 'gh pr diff "$CODEV_PR_NUMBER"',
  'gh-auth-status': 'gh auth status',
};

// =============================================================================
// Configuration loading
// =============================================================================

/**
 * Load forge configuration from af-config.json.
 * Returns the forge section or null if not configured.
 */
export function loadForgeConfig(workspaceRoot: string): Record<string, string | null> | null {
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

/**
 * Get the command string for a concept.
 * Resolution order: user override > default gh command.
 * Returns null if concept is explicitly disabled (set to null in config).
 */
export function getForgeCommand(
  concept: string,
  forgeConfig?: Record<string, string | null> | null,
): string | null {
  // Check user overrides first
  if (forgeConfig && concept in forgeConfig) {
    return forgeConfig[concept]; // null means explicitly disabled
  }

  // Fall back to default
  return DEFAULT_COMMANDS[concept] ?? null;
}

/**
 * Check if a concept is explicitly disabled (set to null in config).
 */
export function isConceptDisabled(
  concept: string,
  forgeConfig?: Record<string, string | null> | null,
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
  options?: { cwd?: string; workspaceRoot?: string; raw?: boolean },
): Promise<unknown | null> {
  const forgeConfig = options?.workspaceRoot ? loadForgeConfig(options.workspaceRoot) : null;
  const command = getForgeCommand(concept, forgeConfig);

  if (command === null) {
    // Concept is disabled or unknown
    return null;
  }

  const shellEnv = {
    ...process.env,
    ...env,
  };

  try {
    const { stdout } = await execAsync(command, {
      cwd: options?.cwd,
      env: shellEnv,
      timeout: 30_000, // 30 second default timeout
    });

    const trimmed = stdout.trim();
    if (!trimmed) return null;

    // Some concepts return non-JSON (pr-diff returns diff text, user-identity returns a string)
    if (options?.raw) {
      return trimmed;
    }

    // Try to parse as JSON
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON — return as raw string
      // This handles concepts like user-identity that return plain text
      return trimmed;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Log at debug level — concept unavailability is expected for non-GitHub repos
    if (process.env.CODEV_DEBUG) {
      console.warn(`[forge] concept '${concept}' failed: ${msg}`);
    }
    return null;
  }
}

/**
 * Execute a forge concept command synchronously.
 *
 * Same as executeForgeCommand but blocks until completion.
 * Use sparingly — prefer the async variant.
 *
 * @param concept - The concept name
 * @param env - Additional environment variables
 * @param options - Execution options
 * @returns Parsed JSON, raw string, or null on failure
 */
export function executeForgeCommandSync(
  concept: string,
  env?: Record<string, string>,
  options?: { cwd?: string; workspaceRoot?: string; raw?: boolean },
): unknown | null {
  const forgeConfig = options?.workspaceRoot ? loadForgeConfig(options.workspaceRoot) : null;
  const command = getForgeCommand(concept, forgeConfig);

  if (command === null) {
    return null;
  }

  const shellEnv = {
    ...process.env,
    ...env,
  };

  try {
    const stdout = execSync(command, {
      cwd: options?.cwd,
      env: shellEnv,
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!stdout) return null;

    if (options?.raw) {
      return stdout;
    }

    try {
      return JSON.parse(stdout);
    } catch {
      return stdout;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env.CODEV_DEBUG) {
      console.warn(`[forge] concept '${concept}' (sync) failed: ${msg}`);
    }
    return null;
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
 * Validate forge configuration from af-config.json.
 * Returns an array of diagnostic messages.
 * Used by `codev doctor`.
 */
export function validateForgeConfig(
  forgeConfig: Record<string, string | null>,
): { concept: string; status: 'ok' | 'disabled' | 'unknown_concept' | 'empty_command'; message: string }[] {
  const results: { concept: string; status: 'ok' | 'disabled' | 'unknown_concept' | 'empty_command'; message: string }[] = [];

  for (const [concept, command] of Object.entries(forgeConfig)) {
    if (command === null) {
      results.push({
        concept,
        status: 'disabled',
        message: `Concept '${concept}' is explicitly disabled`,
      });
    } else if (command === '') {
      results.push({
        concept,
        status: 'empty_command',
        message: `Concept '${concept}' has an empty command string`,
      });
    } else if (!(concept in DEFAULT_COMMANDS)) {
      results.push({
        concept,
        status: 'unknown_concept',
        message: `Concept '${concept}' is not a known forge concept`,
      });
    } else {
      results.push({
        concept,
        status: 'ok',
        message: `Concept '${concept}' overridden: ${command}`,
      });
    }
  }

  return results;
}
