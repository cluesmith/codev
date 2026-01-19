/**
 * Defense Checks
 *
 * Runs build/test commands defined in protocol phases.
 * Supports retry logic and configurable failure behavior.
 */

import { spawn } from 'node:child_process';
import chalk from 'chalk';
import type { Check, Phase } from './types.js';

/**
 * Result of a single check
 */
export interface CheckResult {
  name: string;
  success: boolean;
  output: string;
  error?: string;
  attempts: number;
  duration: number;
}

/**
 * Result of running all checks for a phase
 */
export interface ChecksResult {
  success: boolean;
  checks: CheckResult[];
  returnTo?: string; // Phase to return to on failure
}

/**
 * Run a single command with timeout
 */
async function runCommand(
  command: string,
  options: {
    cwd?: string;
    timeout?: number;
  } = {}
): Promise<{ success: boolean; output: string; error?: string; duration: number }> {
  const startTime = Date.now();
  const timeout = options.timeout || 300000; // 5 minutes default

  return new Promise((resolve) => {
    const [cmd, ...args] = command.split(/\s+/);
    const proc = spawn(cmd, args, {
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let stderr = '';
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeout);

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;

      if (timedOut) {
        resolve({
          success: false,
          output,
          error: `Command timed out after ${timeout}ms`,
          duration,
        });
      } else {
        resolve({
          success: code === 0,
          output: output + stderr,
          error: code !== 0 ? `Exit code: ${code}` : undefined,
          duration,
        });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        output: '',
        error: err.message,
        duration: Date.now() - startTime,
      });
    });
  });
}

/**
 * Run a check with retry logic
 */
async function runCheckWithRetry(
  name: string,
  check: Check,
  options: {
    cwd?: string;
  } = {}
): Promise<CheckResult> {
  const maxRetries = check.max_retries || 3;
  const retryDelay = check.retry_delay || 5; // seconds

  let attempts = 0;
  let lastResult: { success: boolean; output: string; error?: string; duration: number } | null = null;

  while (attempts < maxRetries) {
    attempts++;
    console.log(chalk.blue(`[check] Running ${name} (attempt ${attempts}/${maxRetries}): ${check.command}`));

    lastResult = await runCommand(check.command, options);

    if (lastResult.success) {
      console.log(chalk.green(`[check] ${name} passed (${lastResult.duration}ms)`));
      return {
        name,
        success: true,
        output: lastResult.output,
        attempts,
        duration: lastResult.duration,
      };
    }

    console.log(chalk.yellow(`[check] ${name} failed: ${lastResult.error}`));

    // Only retry if on_fail is 'retry'
    if (check.on_fail !== 'retry' || attempts >= maxRetries) {
      break;
    }

    console.log(chalk.blue(`[check] Retrying in ${retryDelay}s...`));
    await new Promise(r => setTimeout(r, retryDelay * 1000));
  }

  return {
    name,
    success: false,
    output: lastResult?.output || '',
    error: lastResult?.error,
    attempts,
    duration: lastResult?.duration || 0,
  };
}

/**
 * Run all checks for a phase
 */
export async function runPhaseChecks(
  phase: Phase,
  options: {
    cwd?: string;
    dryRun?: boolean;
  } = {}
): Promise<ChecksResult> {
  if (!phase.checks || Object.keys(phase.checks).length === 0) {
    return { success: true, checks: [] };
  }

  if (options.dryRun) {
    console.log(chalk.yellow(`[check] [DRY RUN] Would run checks for phase ${phase.id}:`));
    for (const [name, check] of Object.entries(phase.checks)) {
      console.log(chalk.yellow(`  - ${name}: ${check.command}`));
    }
    return { success: true, checks: [] };
  }

  const results: CheckResult[] = [];
  let returnTo: string | undefined;

  for (const [name, check] of Object.entries(phase.checks)) {
    const result = await runCheckWithRetry(name, check, { cwd: options.cwd });
    results.push(result);

    if (!result.success) {
      console.log(chalk.red(`[check] ${name} failed after ${result.attempts} attempts`));

      // Determine failure action
      if (check.on_fail === 'retry') {
        // Already retried, now fail
        returnTo = undefined;
      } else {
        // on_fail specifies a phase to return to
        returnTo = check.on_fail;
      }

      return {
        success: false,
        checks: results,
        returnTo,
      };
    }
  }

  console.log(chalk.green(`[check] All checks passed for phase ${phase.id}`));
  return {
    success: true,
    checks: results,
  };
}

/**
 * Create default checks for common phases
 */
export function getDefaultChecks(phaseName: string): Record<string, Check> {
  switch (phaseName.toLowerCase()) {
    case 'implement':
      return {
        build: {
          command: 'npm run build',
          on_fail: 'retry',
          max_retries: 2,
        },
      };
    case 'defend':
      return {
        tests: {
          command: 'npm test',
          on_fail: 'implement', // Return to implement on test failure
          max_retries: 1,
        },
      };
    default:
      return {};
  }
}

/**
 * Format check results for display
 */
export function formatCheckResults(results: ChecksResult): string {
  if (results.checks.length === 0) {
    return 'No checks ran';
  }

  const lines: string[] = ['Check Results:'];

  for (const check of results.checks) {
    const status = check.success ? '✓' : '✗';
    const duration = `(${check.duration}ms)`;
    const attempts = check.attempts > 1 ? ` [${check.attempts} attempts]` : '';
    lines.push(`  ${status} ${check.name} ${duration}${attempts}`);

    if (!check.success && check.error) {
      lines.push(`    Error: ${check.error}`);
    }
  }

  if (results.returnTo) {
    lines.push(`  → Returning to phase: ${results.returnTo}`);
  }

  return lines.join('\n');
}
