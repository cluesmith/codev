/**
 * Launcher routing for native Windows (Spec 1658, Areas D and F).
 *
 * Every plumbing launch site (forge concepts, the builder launch script,
 * `postSpawn`, `devCommand`, shell-string porch checks) asks this module how to
 * run bash on Windows, so each site gets the one resolved Git Bash and never a
 * bare `bash` (which can be the System32 WSL launcher). Bare-command spawns ask
 * it for a `CreateProcess`-ready form of `.cmd` shims.
 *
 * POSIX callers keep their existing argv: every site branches on `isWindows()`
 * and only the Windows branch calls in here.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { win32 } from 'node:path';
import { resolveSpawnable, findExecutable, type SpawnableCommand } from '@cluesmith/codev-sdk/node/executable';
import { hostPlatform, isWindows } from './platform.js';
import { loadConfig } from './config.js';
import { resolveGitBash, GIT_BASH_ENV, type GitBash } from './git-bash.js';
import { toMsysPath, MSYS_PATHCONV_OPT_OUT } from './msys-path.js';
import { isUnderTestRunner } from './test-env.js';

/** A program and its arguments, ready for `child_process.spawn` without `shell`. */
export interface Launch {
  command: string;
  args: string[];
}

const gitBashCache = new Map<string, GitBash>();
let gitBashOverride: GitBash | null = null;

/** The `windows.gitBashPath` override of the workspace's `.codev/config.json`, if any. */
function configuredGitBashPath(workspaceRoot: string | undefined): string | undefined {
  if (workspaceRoot === undefined) {
    return undefined;
  }
  return loadConfig(workspaceRoot).windows?.gitBashPath;
}

/**
 * The resolved Git Bash for a workspace. Memoized per override value, because
 * resolution runs `git --version` for each candidate. Throws `GitBashError`
 * with an actionable message when there is none.
 */
export function gitBashFor(workspaceRoot?: string): GitBash {
  if (gitBashOverride !== null) {
    return gitBashOverride;
  }
  const configPath = configuredGitBashPath(workspaceRoot);
  const key = `${configPath ?? ''}\0${process.env[GIT_BASH_ENV] ?? ''}`;
  const cached = gitBashCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const resolved = resolveGitBash({ configPath });
  gitBashCache.set(key, resolved);
  return resolved;
}

/** Pin the Git Bash every launcher sees, or `null` to resolve for real again. Test-only. */
export function setGitBashForTests(gitBash: GitBash | null): void {
  if (!isUnderTestRunner()) {
    throw new Error('setGitBashForTests is test-only (VITEST or CODEV_TEST_ISOLATION must be set)');
  }
  gitBashOverride = gitBash;
  gitBashCache.clear();
}

/** Git Bash running a shell string: `<bash.exe> -c <script>`. */
export function gitBashCommand(script: string, workspaceRoot?: string): Launch {
  return { command: gitBashFor(workspaceRoot).path, args: ['-c', script] };
}

/** Git Bash running a script file, its path in the POSIX form bash reads: `<bash.exe> /c/x/y.sh <args>`. */
export function gitBashScript(scriptPath: string, args: string[] = [], workspaceRoot?: string): Launch {
  return { command: gitBashFor(workspaceRoot).path, args: [toMsysPath(scriptPath), ...args] };
}

/**
 * `env` with MSYS argument conversion turned off, for Git Bash calls whose
 * arguments must reach native programs unmangled (`gh api /repos/...`).
 */
export function gitBashEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...MSYS_PATHCONV_OPT_OUT };
}

/**
 * `command` in a form the host can spawn without a shell. On Windows a `.cmd`
 * shim becomes the `node <entry>` it wraps, or a `cmd.exe /d /s /c` line; on
 * POSIX the input comes back unchanged.
 */
export function spawnableOnHost(command: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): SpawnableCommand {
  return resolveSpawnable(command, args, { platform: hostPlatform(), env });
}

/**
 * `spawn` for a bare command (`afx`, `consult`, a reviewer CLI). POSIX spawns
 * exactly as given; on Windows a `.cmd` shim goes through the shim resolver
 * and no console window opens.
 */
export function spawnOnHost(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (!isWindows()) {
    return spawn(command, args, options);
  }
  const spawnable = spawnableOnHost(command, args, options.env ?? process.env);
  return spawn(spawnable.command, spawnable.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: spawnable.windowsVerbatimArguments,
  });
}

/** `which`-style lookup for the host platform, honoring `PATHEXT` on Windows. */
export function findOnHostPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return findExecutable(name, { platform: hostPlatform(), env });
}

// =============================================================================
// Interactive shells (Area F)
// =============================================================================

/** Full path of the built-in Windows PowerShell 5.1. */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const BASH_NAMES = new Set(['bash', 'bash.exe', '/bin/bash', '/usr/bin/bash']);
const POWERSHELL_NAMES = new Set(['powershell', 'powershell.exe']);

/**
 * The program a human shell terminal runs on Windows, from the configured
 * `shell.shell`:
 * - `powershell` / `powershell.exe` → the built-in Windows PowerShell, by full path;
 * - `bash` → the resolved Git Bash, interactive, never System32's WSL launcher (not a
 *   login shell: Git Bash's login profile changes to `$HOME`, losing the terminal's cwd);
 * - anything else (`pwsh`, a full path) → resolved through `PATHEXT`.
 */
export function windowsInteractiveShell(configured: string, workspaceRoot?: string, env: NodeJS.ProcessEnv = process.env): Launch {
  const name = configured.trim();
  const lower = name.toLowerCase();
  if (POWERSHELL_NAMES.has(lower)) {
    return { command: windowsPowerShellPath(env), args: ['-NoLogo'] };
  }
  if (BASH_NAMES.has(lower)) {
    return { command: gitBashFor(workspaceRoot).path, args: ['-i'] };
  }
  const spawnable = resolveSpawnable(name, [], { platform: 'win32', env });
  return { command: spawnable.command, args: spawnable.args };
}

const POSIX_SHELL_COMMANDS = new Set(['/bin/sh', '/bin/bash', '/usr/bin/sh', '/usr/bin/bash', 'sh', 'bash']);

/**
 * A terminal request from a client that names a POSIX shell (the VS Code
 * extension's dev runner sends `/bin/sh -lc <devCommand>`), mapped onto the
 * resolved Git Bash for a Windows Tower. A login `-lc` becomes `-c`, because
 * Git Bash's login profile changes to `$HOME` and would lose the requested
 * cwd. Any other command is returned unchanged.
 */
export function windowsShellRequest(command: string, args: string[], workspaceRoot?: string): Launch {
  if (!POSIX_SHELL_COMMANDS.has(command)) {
    return { command, args };
  }
  let shellArgs = args;
  if (args[0] === '-lc') {
    shellArgs = ['-c', ...args.slice(1)];
  }
  return { command: gitBashFor(workspaceRoot).path, args: shellArgs };
}
