/**
 * Command launch on native Windows (Spec 1658, Amendment 2, phase A2-1).
 *
 * Adapters over the existing Windows launch helpers: shell strings and scripts
 * run in the resolved Git Bash (never `cmd.exe`, never System32's WSL
 * launcher), bare commands go through the `.cmd` shim resolver with no console
 * window. Each method is the Windows branch its call site used to carry. See
 * `command-launch.ts` for the contract.
 */

import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { GIT_BASH_ENV } from '../git-bash.js';
import { toMsysPath } from '../msys-path.js';
import { windowsPtyBaseEnv } from '../pty-command.js';
import {
  findOnHostPath,
  gitBashCommand,
  gitBashEnv,
  gitBashFor,
  gitBashScript,
  spawnableOnHost,
  windowsInteractiveShell,
  windowsPowerShellPath,
  type Launch,
} from '../shell-launch.js';
import { shellEscapeSingleQuote } from '../../agent-farm/utils/harness.js';
import type { CommandLaunch, ShellExecOptions } from './command-launch.js';

/**
 * A buffered shell string under Git Bash. A bare path to an existing `.sh`
 * file (a shipped forge concept script) runs as a script with its path in
 * POSIX form; anything else is a shell string for `bash -c`.
 */
function shellExecLaunch(script: string, workspaceRoot: string | undefined): Launch {
  if (script.endsWith('.sh') && existsSync(script)) {
    return gitBashScript(script, [], workspaceRoot);
  }
  return gitBashCommand(script, workspaceRoot);
}

/**
 * The environment for a Git Bash shell string: the named path values in POSIX
 * form (MSYS tools such as `tar -C` read them), MSYS argument conversion off so
 * slash-prefixed arguments (`gh api /repos/...`) reach native programs unmangled.
 */
function shellExecEnv(options: ShellExecOptions): NodeJS.ProcessEnv {
  const translated: NodeJS.ProcessEnv = { ...options.env };
  for (const key of options.msysPathEnvKeys ?? []) {
    const value = translated[key];
    if (value) {
      translated[key] = toMsysPath(value);
    }
  }
  return gitBashEnv(translated);
}

export const windowsCommandLaunch: CommandLaunch = Object.freeze<CommandLaunch>({
  spawnShellString(script, options, context) {
    const launch = gitBashCommand(script, context.workspaceRoot);
    return spawn(launch.command, launch.args, { ...options, windowsHide: true });
  },

  async execShellString(script, options) {
    const launch = shellExecLaunch(script, options.workspaceRoot);
    // promisified per call: modules that only spawn never touch `execFile`.
    const { stdout } = await promisify(execFile)(launch.command, launch.args, {
      cwd: options.cwd,
      env: shellExecEnv(options),
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      windowsHide: true,
    });
    return stdout;
  },

  execShellStringSync(script, options) {
    const launch = shellExecLaunch(script, options.workspaceRoot);
    return execFileSync(launch.command, launch.args, {
      cwd: options.cwd,
      env: shellExecEnv(options),
      encoding: 'utf-8',
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  },

  shellStringArgv(script, _posixShell, workspaceRoot) {
    // Not a login shell: Git Bash's login profile changes to `$HOME`, which
    // would lose the requested cwd.
    return gitBashCommand(script, workspaceRoot);
  },

  scriptFileArgv(scriptPath, args, workspaceRoot) {
    return gitBashScript(scriptPath, args, workspaceRoot);
  },

  spawn(command, args, options) {
    const spawnable = spawnableOnHost(command, args, options.env ?? process.env);
    return spawn(spawnable.command, spawnable.args, {
      ...options,
      windowsHide: true,
      windowsVerbatimArguments: spawnable.windowsVerbatimArguments,
    });
  },

  spawnSync(command, args, options) {
    const spawnable = spawnableOnHost(command, args, options.env ?? process.env);
    return spawnSync(spawnable.command, spawnable.args, {
      ...options,
      windowsHide: true,
      windowsVerbatimArguments: spawnable.windowsVerbatimArguments,
    });
  },

  commandExists(name) {
    return findOnHostPath(name) !== null;
  },

  async commandExistsAsync(name) {
    return findOnHostPath(name) !== null;
  },

  launchScriptPath(path) {
    return toMsysPath(path);
  },

  launchScriptExports(workspaceRoot) {
    // Claude Code reads CLAUDE_CODE_GIT_BASH_PATH to find its shell.
    return `export ${GIT_BASH_ENV}='${shellEscapeSingleQuote(gitBashFor(workspaceRoot).path)}'\n`;
  },

  sessionIdMintFallback() {
    return `'${shellEscapeSingleQuote(toMsysPath(process.execPath))}' -e 'process.stdout.write(require("crypto").randomUUID())'`;
  },

  terminalProfile(requestedCommand) {
    // Windows has no $SHELL default (one inherited from a Git Bash launcher is
    // an MSYS path) and needs its own base variables.
    return {
      shell: requestedCommand ?? windowsPowerShellPath(),
      baseEnv: {
        ...windowsPtyBaseEnv(process.env),
        TERM: 'xterm-256color',
        ...(process.env.CODEV_ARTIFACTS_DATA_REPO ? { CODEV_ARTIFACTS_DATA_REPO: process.env.CODEV_ARTIFACTS_DATA_REPO } : {}),
      },
    };
  },

  workspaceShell(workspacePath, configuredShell) {
    // The configured `shell.shell` (Windows PowerShell by default; `bash` means
    // Git Bash, never System32's WSL launcher).
    return windowsInteractiveShell(configuredShell(), workspacePath);
  },
});
