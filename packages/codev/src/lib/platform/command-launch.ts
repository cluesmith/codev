/**
 * Command launch capability (Spec 1658, Amendment 2, phase A2-1).
 *
 * How a command, a shell string or a script runs on the host. Shared code asks
 * `commandLaunch()` instead of choosing a platform: the POSIX implementation is
 * the macOS/Linux code that used to sit in each call site's `else` branch,
 * moved verbatim; the Windows implementation routes through the resolved Git
 * Bash and the `.cmd` shim resolver in `shell-launch.ts`.
 *
 * Site-specific POSIX forms that predate the refactor are kept, not unified:
 * those are passed in by the caller (`posixShell`, `posixProbe`, the porch
 * context flags) so each call site's macOS/Linux behaviour stays byte-for-byte.
 */

import type { ChildProcess, SpawnOptions, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'node:child_process';
import { isWindows } from '../platform.js';
import type { Launch } from '../shell-launch.js';
import { posixCommandLaunch } from './command-launch.posix.js';
import { windowsCommandLaunch } from './command-launch.windows.js';

/** The POSIX shell a shell string runs under. Windows always uses the resolved Git Bash. */
export interface PosixShell {
  command: '/bin/sh' | '/bin/bash';
  flag: '-c' | '-lc';
}

export interface ShellStringContext {
  /** Locates the workspace's `windows.gitBashPath` override. */
  workspaceRoot?: string;
  // Exists only to keep porch runCheck's Amendment 2 A2.9 behaviour verbatim; retired when that divergence is fixed.
  /** POSIX: run detached, so the check leads its own process group for the group kill. */
  posixDetached?: boolean;
  // Exists only to keep porch runCheck's Amendment 2 A2.9 behaviour verbatim; retired when that divergence is fixed.
  /** POSIX: split the string on whitespace and re-join it with single spaces, as `spawn(exe, args, { shell: true })` did. */
  posixCollapseWhitespace?: boolean;
}

export interface ShellExecOptions {
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  /** Locates the workspace's `windows.gitBashPath` override. */
  workspaceRoot?: string;
  /** Windows: env values that are host paths, rewritten to the POSIX form Git Bash tools read. */
  msysPathEnvKeys?: readonly string[];
}

/** The program and base environment of a human terminal PTY. */
export interface TerminalProfile {
  shell: string;
  baseEnv: Record<string, string>;
}

export interface CommandLaunch {
  /** A shell string as a child process (runStreaming, porch runCheck). */
  spawnShellString(script: string, options: SpawnOptions, context: ShellStringContext): ChildProcess;
  /** A shell string, buffered; resolves to stdout (forge concepts). */
  execShellString(script: string, options: ShellExecOptions): Promise<string>;
  /** Synchronous `execShellString` (forge concepts). */
  execShellStringSync(script: string, options: ShellExecOptions): string;
  /** A shell string as PTY argv (dev runner, shell sessions). */
  shellStringArgv(script: string, posixShell: PosixShell, workspaceRoot?: string): Launch;
  /** A script file as argv (builder launch scripts). */
  scriptFileArgv(scriptPath: string, args: string[], workspaceRoot?: string): Launch;
  /** A bare command (`afx`, `consult`, a reviewer CLI) with no shell. */
  spawn(command: string, args: string[], options: SpawnOptions): ChildProcess;
  /** `spawn`'s synchronous counterpart, for probes that read a CLI's output. */
  spawnSync(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<string>;
  /** Whether `name` is on PATH. POSIX runs the caller's own probe (the per-site forms are kept). */
  commandExists(name: string, posixProbe: () => boolean): boolean;
  /** Asynchronous `commandExists`. */
  commandExistsAsync(name: string, posixProbe: () => Promise<boolean>): Promise<boolean>;
  /** A path as a launch script's own commands read it (POSIX form under Git Bash). */
  launchScriptPath(path: string): string;
  /** Extra exports a launch script needs after its prelude (empty on POSIX). */
  launchScriptExports(workspaceRoot?: string): string;
  /** The session-id minting fallback for the session-aware launch loop (none on POSIX). */
  sessionIdMintFallback(): string | undefined;
  /** Program and base environment for a human terminal PTY. */
  terminalProfile(requestedCommand: string | undefined): TerminalProfile;
  /** The interactive shell a workspace shell terminal runs. `configuredShell` is read only where it is used. */
  workspaceShell(workspacePath: string, configuredShell: () => string): Launch;
}

/** The host's command launch implementation. */
export function commandLaunch(): CommandLaunch {
  if (isWindows()) {
    return windowsCommandLaunch;
  }
  return posixCommandLaunch;
}
