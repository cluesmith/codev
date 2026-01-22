/**
 * Porch2 Check Runner
 *
 * Runs check commands (npm test, npm run build, etc.)
 * with timeout support.
 */

import { spawn } from 'node:child_process';
import type { CheckResult } from './types.js';

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
 * Run multiple checks for a phase
 */
export async function runPhaseChecks(
  checks: Record<string, string>,
  cwd: string,
  env: CheckEnv,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  for (const [name, command] of Object.entries(checks)) {
    const result = await runCheck(name, command, cwd, env, timeoutMs);
    results.push(result);

    // Stop on first failure
    if (!result.passed) {
      break;
    }
  }

  return results;
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
