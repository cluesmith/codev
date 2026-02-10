/**
 * Shared helpers for CLI integration tests.
 *
 * Replicates the BATS e2e helpers (XDG sandboxing, temp dirs, CLI execution)
 * using Node.js APIs.
 */

import { execFileSync, ExecFileSyncOptions } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Path to the built bin directory */
const BIN_DIR = resolve(import.meta.dirname, '../../../bin');

/** Path to the codev CLI entry point */
export const CODEV_BIN = join(BIN_DIR, 'codev.js');

/** Path to the af CLI entry point */
export const AF_BIN = join(BIN_DIR, 'af.js');

/** Path to the consult CLI entry point */
export const CONSULT_BIN = join(BIN_DIR, 'consult.js');

export interface CliEnv {
  dir: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Create an isolated test environment with XDG sandboxing.
 * Prevents tests from polluting the user's home directory.
 */
export function setupCliEnv(): CliEnv {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'codev-cli-test-')));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(dir, 'home'),
    XDG_CONFIG_HOME: join(dir, '.xdg/config'),
    XDG_DATA_HOME: join(dir, '.xdg/data'),
    XDG_CACHE_HOME: join(dir, '.xdg/cache'),
    npm_config_prefix: join(dir, '.npm-global'),
    npm_config_cache: join(dir, '.npm-cache'),
  };

  return { dir, env };
}

/**
 * Clean up the test environment.
 */
export function teardownCliEnv(env: CliEnv): void {
  if (env.dir && existsSync(env.dir)) {
    rmSync(env.dir, { recursive: true, force: true });
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  status: number;
}

/**
 * Run a CLI command and return stdout, stderr, and exit code.
 * Never throws — returns exit code for assertion.
 */
export function runCli(
  bin: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): ExecResult {
  const execOpts: ExecFileSyncOptions = {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 30_000,
  };

  try {
    const stdout = execFileSync('node', [bin, ...args], execOpts);
    return {
      stdout: stdout?.toString() ?? '',
      stderr: '',
      status: 0,
    };
  } catch (err: any) {
    return {
      stdout: err.stdout?.toString() ?? '',
      stderr: err.stderr?.toString() ?? '',
      status: err.status ?? 1,
    };
  }
}

/**
 * Run codev CLI command.
 */
export function runCodev(args: string[], cwd: string, env: NodeJS.ProcessEnv): ExecResult {
  return runCli(CODEV_BIN, args, { cwd, env });
}

/**
 * Run af CLI command.
 */
export function runAf(args: string[], cwd: string, env: NodeJS.ProcessEnv): ExecResult {
  return runCli(AF_BIN, args, { cwd, env });
}

/**
 * Run consult CLI command.
 */
export function runConsult(args: string[], cwd: string, env: NodeJS.ProcessEnv): ExecResult {
  return runCli(CONSULT_BIN, args, { cwd, env });
}

/**
 * Read a file from the test environment, returning its content or null.
 */
export function readTestFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
