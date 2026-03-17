/**
 * Porch Check Runner
 *
 * Runs check commands (npm test, npm run build, etc.)
 * with timeout support.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import type { CheckResult, CheckDef } from './types.js';
import type { ArtifactResolver } from './artifacts.js';
import { executeForgeCommand, getForgeCommand, loadForgeConfig } from '../../lib/forge.js';

const execFileAsync = promisify(execFile);

/** Default timeout for checks: 5 minutes */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================================
// Check Execution
// ============================================================================

/** Environment variables passed to check commands */
export interface CheckEnv {
  PROJECT_ID: string;
  PROJECT_TITLE: string;
}

/**
 * Run a single check command
 */
export async function runCheck(
  name: string,
  command: string,
  cwd: string,
  env: CheckEnv,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<CheckResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    // Parse command into executable and args
    const parts = command.split(/\s+/);
    const executable = parts[0];
    const args = parts.slice(1);

    const proc = spawn(executable, args, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PROJECT_ID: env.PROJECT_ID,
        PROJECT_TITLE: env.PROJECT_TITLE,
      },
    });

    // Set up timeout
    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (killed) {
        resolve({
          name,
          command,
          passed: false,
          error: `Timed out after ${timeoutMs / 1000}s`,
          duration_ms: duration,
        });
      } else if (code === 0) {
        resolve({
          name,
          command,
          passed: true,
          output: stdout.trim(),
          duration_ms: duration,
        });
      } else {
        resolve({
          name,
          command,
          passed: false,
          output: stdout.trim(),
          error: stderr.trim() || `Exit code ${code}`,
          duration_ms: duration,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        name,
        command,
        passed: false,
        error: err.message,
        duration_ms: Date.now() - startTime,
      });
    });
  });
}

/**
 * Try to run an artifact-dependent check programmatically via the resolver.
 * Returns a CheckResult if the check name is recognized, null otherwise
 * (caller should fall back to shell execution).
 */
export function runArtifactCheck(
  name: string,
  command: string,
  resolver: ArtifactResolver,
  env: CheckEnv,
): CheckResult | null {
  const startTime = Date.now();
  const { PROJECT_ID: projectId, PROJECT_TITLE: title } = env;

  switch (name) {
    case 'plan_exists': {
      const content = resolver.getPlanContent(projectId, title);
      return {
        name,
        command,
        passed: content !== null,
        output: content !== null ? 'Plan found via resolver' : undefined,
        error: content === null ? 'Plan not found' : undefined,
        duration_ms: Date.now() - startTime,
      };
    }

    case 'has_phases_json': {
      const content = resolver.getPlanContent(projectId, title);
      if (content === null) {
        return { name, command, passed: false, error: 'Plan not found', duration_ms: Date.now() - startTime };
      }
      const has = /"phases"\s*:/.test(content);
      return {
        name,
        command,
        passed: has,
        output: has ? 'Found phases JSON block' : undefined,
        error: has ? undefined : 'No "phases": found in plan',
        duration_ms: Date.now() - startTime,
      };
    }

    case 'min_two_phases': {
      const content = resolver.getPlanContent(projectId, title);
      if (content === null) {
        return { name, command, passed: false, error: 'Plan not found', duration_ms: Date.now() - startTime };
      }
      const matches = content.match(/"id":\s*"[^"]*"/g);
      const count = matches ? matches.length : 0;
      return {
        name,
        command,
        passed: count >= 2,
        output: `Found ${count} phase(s)`,
        error: count < 2 ? `Only ${count} phase(s) found, need at least 2` : undefined,
        duration_ms: Date.now() - startTime,
      };
    }

    case 'review_has_arch_updates': {
      const content = resolver.getReviewContent(projectId, title);
      if (content === null) {
        return { name, command, passed: false, error: 'Review not found', duration_ms: Date.now() - startTime };
      }
      const has = content.includes('## Architecture Updates');
      return {
        name,
        command,
        passed: has,
        output: has ? 'Found Architecture Updates section' : undefined,
        error: has ? undefined : 'Missing "## Architecture Updates" section in review',
        duration_ms: Date.now() - startTime,
      };
    }

    case 'review_has_lessons_updates': {
      const content = resolver.getReviewContent(projectId, title);
      if (content === null) {
        return { name, command, passed: false, error: 'Review not found', duration_ms: Date.now() - startTime };
      }
      const has = content.includes('## Lessons Learned Updates');
      return {
        name,
        command,
        passed: has,
        output: has ? 'Found Lessons Learned Updates section' : undefined,
        error: has ? undefined : 'Missing "## Lessons Learned Updates" section in review',
        duration_ms: Date.now() - startTime,
      };
    }

    default:
      return null; // Not an artifact check — fall through to shell execution
  }
}

/**
 * Run multiple checks for a phase.
 * Accepts either Record<string, string> (legacy) or Record<string, CheckDef>.
 *
 * Special handling: `pr_exists` checks are routed through the forge concept
 * command dispatcher instead of running the protocol.json command directly.
 * This allows per-project forge configuration while keeping protocol JSON unchanged.
 */
export async function runPhaseChecks(
  checks: Record<string, string | CheckDef>,
  cwd: string,
  env: CheckEnv,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  resolver?: ArtifactResolver,
  overriddenChecks?: Set<string>,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const [name, checkVal] of Object.entries(checks)) {
    const command = typeof checkVal === 'string' ? checkVal : checkVal.command;

    // Try resolver-based check first (handles artifact-dependent checks programmatically).
    // Skip resolver fast-path if the user overrode this check via af-config.json —
    // their custom command should run instead.
    if (resolver && !overriddenChecks?.has(name)) {
      const artifactResult = runArtifactCheck(name, command, resolver, env);
      if (artifactResult) {
        results.push(artifactResult);
        if (!artifactResult.passed) break;
        continue;
      }
    }

    const checkCwd = typeof checkVal === 'object' && checkVal.cwd
      ? path.resolve(cwd, checkVal.cwd)
      : cwd;

    // Intercept pr_exists: route through forge concept command
    if (name === 'pr_exists') {
      const result = await runPrExistsViaConcept(name, checkCwd);
      results.push(result);
      if (!result.passed) break;
      continue;
    }

    const result = await runCheck(name, command, checkCwd, env, timeoutMs);
    results.push(result);

    // Stop on first failure
    if (!result.passed) {
      break;
    }
  }

  return results;
}

/**
 * Run pr_exists check via the forge concept command dispatcher.
 * Gets the current branch name from git, then uses the pr-exists concept.
 */
async function runPrExistsViaConcept(
  name: string,
  cwd: string,
): Promise<CheckResult> {
  const startTime = Date.now();
  const forgeConfig = loadForgeConfig(cwd);
  const forgeCmd = getForgeCommand('pr-exists', forgeConfig) ?? 'pr-exists (concept)';

  try {
    // Get current branch name
    const { stdout: branchName } = await execFileAsync('git', ['branch', '--show-current'], { cwd });

    const result = await executeForgeCommand('pr-exists', {
      CODEV_BRANCH_NAME: branchName.trim(),
    }, { cwd, workspaceRoot: cwd });

    // The concept returns a truthy value (string "true", boolean true, or number > 0)
    const passed = result === true || result === 'true' || (typeof result === 'number' && result > 0);

    return {
      name,
      command: forgeCmd,
      passed,
      output: String(result),
      duration_ms: Date.now() - startTime,
    };
  } catch (err: unknown) {
    return {
      name,
      command: forgeCmd,
      passed: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - startTime,
    };
  }
}

// ============================================================================
// Result Formatting
// ============================================================================

/**
 * Format check results for terminal output
 */
export function formatCheckResults(results: CheckResult[]): string {
  const lines: string[] = [];

  for (const result of results) {
    const status = result.passed ? '✓' : '✗';
    const duration = result.duration_ms
      ? ` (${(result.duration_ms / 1000).toFixed(1)}s)`
      : '';

    lines.push(`  ${status} ${result.name}${duration}`);

    if (!result.passed && result.error) {
      // Indent error message
      const errorLines = result.error.split('\n').slice(0, 5);
      for (const line of errorLines) {
        lines.push(`    ${line}`);
      }
      if (result.error.split('\n').length > 5) {
        lines.push('    ...');
      }
    }
  }

  return lines.join('\n');
}

/**
 * Check if all results passed
 */
export function allChecksPassed(results: CheckResult[]): boolean {
  return results.every(r => r.passed);
}
