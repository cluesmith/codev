/**
 * IDE server version handshake and subprocess environment (Spec 1789).
 *
 * Tower refuses to spawn a Codev IDE server older than the floor declared
 * here. The check runs `<server> --version` and reads line 1 only: the VS Code
 * base version (line 2 is the commit, line 3 the arch). The npm package
 * version, which may carry a suffix, is never read.
 *
 * This module is also the single source for the bounds of every server
 * subprocess wait (version check, extension install, readiness, stop), so the
 * CLI's request budget is derived from them and cannot silently desync.
 * `ide-server.ts` imports this module, never the reverse.
 */

import { spawn } from 'node:child_process';
import { delimiter, dirname } from 'node:path';
import { sanitizeAgentEnv } from '../../lib/agent-env.js';

/** Log sink shared by the IDE lifecycle modules; Tower passes its own logger. */
export type LogFn = (level: 'INFO' | 'ERROR' | 'WARN', message: string) => void;

/**
 * Oldest server base version Tower supports. A unit test ties it to the
 * embedded sidebar's `engines.vscode` minimum, so the sidebar is never paired
 * with a server too old to activate it.
 */
export const IDE_SERVER_MIN_VERSION = '1.128.0';

/** Upgrade command named in every refusal. */
export const IDE_SERVER_UPGRADE_COMMAND = 'npm i -g @cluesmith/codev-ide';

/** Bound on `<server> --version`. */
export const IDE_VERSION_TIMEOUT_MS = 10_000;
/** Bound on `<server> --install-extension` (a cold install takes ~2 s; this is for a wedged server). */
export const IDE_INSTALL_TIMEOUT_MS = 60_000;
/** Bound on waiting for a spawned server to listen on its port. */
export const IDE_READY_TIMEOUT_MS = 15_000;
/** Bound on waiting for a stopped server to exit before escalating to SIGKILL. */
export const IDE_STOP_EXIT_TIMEOUT_MS = 5_000;
/** Fixed slack on top of the start budget for request and lock overhead. */
const IDE_START_BUDGET_MARGIN_MS = 10_000;

/**
 * Longest a client should wait for an IDE start or stop: one full start
 * (version check, install, stopping a server on another port, readiness)
 * doubled for one queued operation's worth of lock wait, plus margin.
 */
export const IDE_START_BUDGET_MS =
  (IDE_VERSION_TIMEOUT_MS + IDE_INSTALL_TIMEOUT_MS + IDE_STOP_EXIT_TIMEOUT_MS + IDE_READY_TIMEOUT_MS) * 2 +
  IDE_START_BUDGET_MARGIN_MS;

const STRICT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * Parse the base version from `--version` output: line 1 only, trimmed, strict
 * `major.minor.patch` (no leading zeroes). Anything else on line 1, including a
 * prerelease suffix, is unparseable and yields null.
 */
export function parseIdeServerVersion(stdout: string): string | null {
  const firstLine = stdout.split(/\r?\n/, 1)[0].trim();
  if (!STRICT_VERSION.test(firstLine)) return null;
  return firstLine;
}

/**
 * Numeric compare of two strict `major.minor.patch` versions: negative, zero or
 * positive. Throws on any other input rather than returning NaN, which would
 * read as "not below the floor".
 */
export function compareVersions(a: string, b: string): number {
  for (const version of [a, b]) {
    if (!STRICT_VERSION.test(version)) {
      throw new Error(`compareVersions: ${JSON.stringify(version)} is not a strict major.minor.patch version`);
    }
  }
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = pa[i] - pb[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Environment for every IDE server subprocess: the sanitized agent env with
 * the directory of the Node running Tower first on `PATH` (moved there if it
 * already appears later). The npm
 * `codev-ide-server` launcher is a `#!/usr/bin/env node` script, and Tower
 * may run under a daemon whose `PATH` lacks a Node.
 */
export function buildIdeServerEnv(baseEnv: NodeJS.ProcessEnv | Record<string, string> = process.env): Record<string, string> {
  const env = sanitizeAgentEnv(baseEnv);
  const nodeDir = dirname(process.execPath);
  const rest = (env.PATH ?? '').split(delimiter).filter((entry) => entry !== '' && entry !== nodeDir);
  env.PATH = [nodeDir, ...rest].join(delimiter);
  return env;
}

/** Thrown when the server's version is below the floor or cannot be determined. */
export class IdeServerVersionError extends Error {
  constructor(detail: string) {
    super(
      `${detail}. Codev requires Codev IDE server ${IDE_SERVER_MIN_VERSION} or newer; ` +
        `upgrade with: ${IDE_SERVER_UPGRADE_COMMAND}`,
    );
    this.name = 'IdeServerVersionError';
  }
}

export interface CheckIdeServerVersionOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Captured output of a server CLI command that exited zero. */
export interface IdeServerCommandRun {
  stdout: string;
  stderr: string;
}

/** Thrown by `runIdeServerCommand` when the command times out or fails. */
export class IdeServerCommandError extends Error {
  constructor(
    readonly kind: 'timeout' | 'error',
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'IdeServerCommandError';
  }
}

export interface RunIdeServerCommandOptions {
  timeoutMs: number;
  env: Record<string, string>;
}

/** Longest stderr kept from a failed command; a wedged server can print without end. */
const MAX_CAPTURED_STDERR = 4_000;

/**
 * Longest stdout kept. Callers read only its head (`--version` line 1), and a
 * faulty server CLI flooding stdout for the whole timeout must not grow Tower's memory.
 */
const MAX_CAPTURED_STDOUT = 64_000;

/** SIGKILL the child's whole process group, falling back to the child alone. */
function killProcessGroup(pid: number | undefined, kill: () => void): void {
  if (pid !== undefined) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Group already gone or not a group leader: fall through.
    }
  }
  kill();
}

/**
 * Run one server CLI command under a hard bound. `execFile`'s own `timeout` is
 * not used: it sends SIGTERM, which a wedged server may ignore, and its
 * callback waits for stdio to close, which a surviving grandchild can hold
 * open. Instead the command runs as its own process group, and a timer
 * SIGKILLs the whole group, releases the pipes and rejects immediately.
 */
export function runIdeServerCommand(
  serverPath: string,
  args: string[],
  opts: RunIdeServerCommandOptions,
): Promise<IdeServerCommandRun> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(serverPath, args, { env: opts.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    function settle(outcome: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      outcome();
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_CAPTURED_STDOUT) {
        stdout = (stdout + chunk).slice(0, MAX_CAPTURED_STDOUT);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_CAPTURED_STDERR) {
        stderr = (stderr + chunk).slice(0, MAX_CAPTURED_STDERR);
      }
    });

    child.on('error', (error) => {
      settle(() => reject(new IdeServerCommandError('error', error.message.split('\n', 1)[0], stderr.trim())));
    });
    child.on('close', (code, signal) => {
      settle(() => {
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        let reason = `exit code ${code}`;
        if (code === null) {
          reason = `killed by ${signal}`;
        }
        reject(new IdeServerCommandError('error', reason, stderr.trim()));
      });
    });

    const timer = setTimeout(() => {
      settle(() => {
        killProcessGroup(child.pid, () => child.kill('SIGKILL'));
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new IdeServerCommandError('timeout', `timed out after ${opts.timeoutMs / 1000}s`, stderr.trim()));
      });
    }, opts.timeoutMs);
  });
}

/** Longest line 1 quoted back in an unparseable-version refusal. */
const MAX_QUOTED_VERSION_LINE = 200;

function describeVersionFailure(serverPath: string, failure: IdeServerCommandError, timeoutMs: number): string {
  if (failure.kind === 'timeout') {
    return `IDE server at ${serverPath} did not answer --version within ${timeoutMs / 1000}s`;
  }
  let detail = `IDE server at ${serverPath} failed to run --version (${failure.message})`;
  if (failure.stderr !== '') {
    detail = `${detail}: ${failure.stderr}`;
  }
  return detail;
}

/**
 * Run `<serverPath> --version` and check it against the floor. Resolves with
 * the parsed base version, or throws an `IdeServerVersionError` naming the
 * installed version (or the failure), the floor and the upgrade command.
 */
export async function checkIdeServerVersion(
  serverPath: string,
  opts: CheckIdeServerVersionOptions = {},
): Promise<{ version: string }> {
  const timeoutMs = opts.timeoutMs ?? IDE_VERSION_TIMEOUT_MS;
  const env = opts.env ?? buildIdeServerEnv();

  let run: IdeServerCommandRun;
  try {
    run = await runIdeServerCommand(serverPath, ['--version'], { timeoutMs, env });
  } catch (failure) {
    if (!(failure instanceof IdeServerCommandError)) throw failure;
    throw new IdeServerVersionError(describeVersionFailure(serverPath, failure, timeoutMs));
  }

  const version = parseIdeServerVersion(run.stdout);
  if (version === null) {
    const firstLine = run.stdout.split(/\r?\n/, 1)[0].trim().slice(0, MAX_QUOTED_VERSION_LINE);
    throw new IdeServerVersionError(
      `IDE server at ${serverPath} printed an unrecognized version (${JSON.stringify(firstLine)})`,
    );
  }
  if (compareVersions(version, IDE_SERVER_MIN_VERSION) < 0) {
    throw new IdeServerVersionError(`IDE server at ${serverPath} is version ${version}, below the supported floor`);
  }
  return { version };
}
