/**
 * The command a PTY actually spawns (Spec 1658, Area D).
 *
 * ConPTY starts its child through `CreateProcess`, which runs `.exe`/`.com`
 * files only. An agent terminal's command is usually a bare name (`claude`)
 * that resolves on Windows to a `.exe` or to an npm `.cmd` shim, so every PTY
 * spawn passes through here first. node-pty takes a pre-quoted `cmd.exe` line
 * as its string `args` form.
 *
 * POSIX commands come back unchanged. Kept free of config and workspace
 * imports because the shellper process loads it.
 */

import { resolveSpawnable } from '@cluesmith/codev-sdk/node/executable';
import { hostPlatform } from './platform.js';

export interface PtyCommand {
  file: string;
  args: string[] | string;
}

export function ptyCommand(command: string, args: string[], env: Record<string, string | undefined>): PtyCommand {
  if (hostPlatform() !== 'win32') {
    return { file: command, args };
  }
  const spawnable = resolveSpawnable(command, args, { platform: 'win32', env });
  if (spawnable.windowsVerbatimArguments) {
    return { file: spawnable.command, args: spawnable.args.join(' ') };
  }
  return { file: spawnable.command, args: spawnable.args };
}

/** Read an environment variable case-insensitively, as Windows does (`Path` vs `PATH`). */
function windowsEnvValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper && env[key] !== undefined) {
      return env[key];
    }
  }
  return undefined;
}

/**
 * Variables a Windows PTY child needs from its parent when it does not inherit
 * the whole environment: without `SystemRoot` many programs fail to start, and
 * without `PATH`/`PATHEXT` nothing resolves. `HOME` is set to the user profile
 * for POSIX-minded tools (Git Bash, the harness CLIs).
 */
const WINDOWS_BASE_ENV_KEYS = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'COMSPEC', 'WINDIR',
  'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
];

export function windowsPtyBaseEnv(env: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const key of WINDOWS_BASE_ENV_KEYS) {
    const value = windowsEnvValue(env, key);
    if (value !== undefined) {
      base[key] = value;
    }
  }
  const home = windowsEnvValue(env, 'HOME') ?? base.USERPROFILE;
  if (home !== undefined) {
    base.HOME = home;
  }
  return base;
}
