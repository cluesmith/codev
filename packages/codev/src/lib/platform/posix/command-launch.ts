/**
 * Command launch on macOS and Linux (Spec 1658, Amendment 2, phase A2-1).
 *
 * Each method is the POSIX branch its call site used to carry, moved verbatim.
 * See `command-launch.ts` for the contract.
 */

import { exec, execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { shellEscapeSingleQuote } from '../../shell-quote.js';
import type { CommandLaunch } from '../command-launch.js';

/**
 * A buffered shell string for `/bin/sh -c`. A bare absolute path to an existing
 * `.sh` file (a shipped forge concept script) runs as `exec '<path>'`, so the
 * script replaces the shell and is the process a timeout signals (Spec 1647).
 * Debian and Ubuntu build dash without the "exec the last command of `sh -c`"
 * optimization (Debian patch 0004), so a plain `sh -c <path>` forks there: the
 * timeout's SIGTERM kills only the shell, and the script, its traps unrun, keeps
 * running with its child. Anything else is passed through unchanged.
 */
function shellExecString(script: string): string {
  if (isAbsolute(script) && script.endsWith('.sh') && existsSync(script)) {
    return `exec '${shellEscapeSingleQuote(script)}'`;
  }
  return script;
}

export const posixCommandLaunch: CommandLaunch = Object.freeze<CommandLaunch>({
  spawnShellString(script, options, context) {
    // porch runCheck split the string and let `shell: true` re-join it with
    // single spaces; that form is kept where the caller asks for it.
    let command = script;
    if (context.posixCollapseWhitespace === true) {
      command = script.split(/\s+/).join(' ');
    }
    const spawnOptions = { ...options, shell: true };
    if (context.posixDetached === true) {
      // windows-console: posix-only (commandLaunch() selects this implementation off Windows)
      return spawn(command, { ...spawnOptions, detached: true });
    }
    // windows-console: posix-only (commandLaunch() selects this implementation off Windows)
    return spawn(command, spawnOptions);
  },

  async execShellString(script, options) {
    // promisified per call: modules that only spawn never touch `exec`.
    // windows-console: posix-only (commandLaunch() selects this implementation off Windows)
    const { stdout } = await promisify(exec)(shellExecString(script), {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
    });
    return stdout;
  },

  execShellStringSync(script, options) {
    // windows-console: posix-only (commandLaunch() selects this implementation off Windows)
    return execSync(shellExecString(script), {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf-8',
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  },

  shellStringArgv(script, posixShell) {
    return { command: posixShell.command, args: [posixShell.flag, script] };
  },

  scriptFileArgv(scriptPath, args) {
    return { command: '/bin/bash', args: [scriptPath, ...args] };
  },

  spawn(command, args, options) {
    // windows-console: posix-only (commandLaunch() selects this implementation off Windows)
    return spawn(command, args, options);
  },

  spawnSync(command, args, options) {
    // windows-console: posix-only (commandLaunch() selects this implementation off Windows)
    return spawnSync(command, args, options);
  },

  commandExists(_name, posixProbe) {
    return posixProbe();
  },

  commandExistsAsync(_name, posixProbe) {
    return posixProbe();
  },

  launchScriptPath(path) {
    return path;
  },

  launchScriptExports() {
    return '';
  },

  sessionIdMintFallback() {
    return undefined;
  },

  terminalProfile(requestedCommand) {
    const shell = requestedCommand ?? process.env.SHELL ?? '/bin/bash';
    return {
      shell,
      // POSIX base env (`/tmp` HOME fallback included).
      baseEnv: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        SHELL: shell,
        TERM: 'xterm-256color',
        // UTF-8 locale for proper Unicode character rendering
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        LC_ALL: process.env.LC_ALL ?? '',
        // Propagate artifact data repo for CliResolver in builder worktrees
        ...(process.env.CODEV_ARTIFACTS_DATA_REPO ? { CODEV_ARTIFACTS_DATA_REPO: process.env.CODEV_ARTIFACTS_DATA_REPO } : {}),
      },
    };
  },

  workspaceShell() {
    return { command: process.env.SHELL || '/bin/bash', args: [] };
  },
});
