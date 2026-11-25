/**
 * The ONLY path to a subprocess in `codev check` (Spec 1951 § Read-only enforcement 1).
 *
 * `git(argv)` checks the argv against the closed allow-list and refuses — before spawning —
 * anything not on it. Git runs from argv, never through a shell. `forge(concept, env)` runs
 * only the four read concepts through the existing dispatcher.
 *
 * Networked git calls (`ls-remote`, `fetch`) and every forge call are bounded by
 * `timeoutMs`. The runner also races each bounded call against its own deadline, because a
 * killed shell's grandchild can keep a stdio pipe open and delay the child's `close` well
 * past the kill; a late result is discarded. `imports.test.ts` keeps every other module in
 * this directory away from `child_process` and the forge dispatcher.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { executeForgeCommandDetailed, getForgeCommand, loadForgeConfig, type ForgeConfig } from '../../lib/forge.js';
import { assertConceptAllowed, assertGitArgvAllowed, NETWORK_SUBCOMMANDS } from './allow-list.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Extra time the runner's own deadline allows the dispatcher to report its kill itself. */
const DEADLINE_GRACE_MS = 1_000;

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface GitResult {
  stdout: string;
  stderr: string;
  /** The process exit code; null when it timed out or was killed by a signal. */
  exitCode: number | null;
  timedOut: boolean;
}

export type ForgeOutcome =
  | { ok: true; data: unknown }
  | { ok: false; kind: 'disabled' | 'failed' | 'timeout' | 'invalid'; reason: string };

export interface RunnerOptions {
  /** Directory git and the forge concepts run in. */
  cwd: string;
  /** Workspace root whose `.codev/config.json` holds the forge configuration. */
  workspaceRoot: string;
  timeoutMs?: number;
  /** Extra environment for every subprocess (tests put stubs first on PATH). */
  env?: Record<string, string>;
  /** Injected for unit tests; defaults to `child_process.spawn`. */
  spawn?: SpawnFn;
}

export interface Runner {
  readonly cwd: string;
  readonly timeoutMs: number;
  /** Human form of the time limit, e.g. `30s`. */
  readonly timeoutLabel: string;
  /** Run git. `ls-remote` and `fetch` are bounded by `timeoutMs`. */
  git(args: readonly string[]): Promise<GitResult>;
  forge(concept: string, env?: Record<string, string>): Promise<ForgeOutcome>;
  /** The forge provider name for messages (`github` when none is configured). */
  provider(): string;
}

export function formatDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

export function createRunner(options: RunnerOptions): Runner {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutLabel = formatDuration(timeoutMs);
  const spawnImpl: SpawnFn = options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
  let forgeConfig: ForgeConfig | null | undefined;

  const loadForge = (): ForgeConfig | null => {
    if (forgeConfig === undefined) forgeConfig = loadForgeConfig(options.workspaceRoot);
    return forgeConfig;
  };

  const git = async (args: readonly string[]): Promise<GitResult> => {
    const bounded = NETWORK_SUBCOMMANDS.has(assertGitArgvAllowed(args));
    return await new Promise<GitResult>((resolve, reject) => {
      const child = spawnImpl('git', args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const settle = (result: GitResult | Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (err) => settle(new Error(`could not run git: ${err.message}`)));
      child.on('close', (code) => {
        settle({
          stdout: Buffer.concat(stdout).toString('utf-8'),
          stderr: Buffer.concat(stderr).toString('utf-8'),
          exitCode: code,
          timedOut: false,
        });
      });
      if (bounded) {
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          settle({ stdout: '', stderr: '', exitCode: null, timedOut: true });
        }, timeoutMs);
      }
    });
  };

  const forge = async (concept: string, env: Record<string, string> = {}): Promise<ForgeOutcome> => {
    assertConceptAllowed(concept);
    const config = loadForge();
    if (getForgeCommand(concept, config) === null) {
      return { ok: false, kind: 'disabled', reason: `${concept} unavailable on ${providerOf(config)}` };
    }
    const timedOut: ForgeOutcome = { ok: false, kind: 'timeout', reason: `${concept} timed out after ${timeoutLabel}` };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ForgeOutcome>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs + DEADLINE_GRACE_MS);
    });
    const call = executeForgeCommandDetailed(concept, { ...options.env, ...env }, {
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot,
      forgeConfig: config,
      timeoutMs,
    }).then((result): ForgeOutcome => {
      if (result.error) {
        if (result.error.timedOut) return timedOut;
        const detail = firstLine(result.error.stderr) || firstLine(result.error.message);
        return { ok: false, kind: 'failed', reason: `${concept} failed: ${detail}` };
      }
      if (result.data === null) return { ok: false, kind: 'invalid', reason: `${concept} returned invalid output` };
      return { ok: true, data: result.data };
    });
    try {
      return await Promise.race([call, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  return {
    cwd: options.cwd,
    timeoutMs,
    timeoutLabel,
    git,
    forge,
    provider: () => providerOf(loadForge()),
  };
}

function providerOf(config: ForgeConfig | null): string {
  return config?.provider ?? 'github';
}
