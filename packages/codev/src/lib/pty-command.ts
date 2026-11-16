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
import { isWindows } from './platform.js';

export interface PtyCommand {
  file: string;
  args: string[] | string;
}

export function ptyCommand(command: string, args: string[], env: Record<string, string | undefined>): PtyCommand {
  if (!isWindows()) {
    return { file: command, args };
  }
  const spawnable = resolveSpawnable(command, args, { platform: 'win32', env });
  if (spawnable.windowsVerbatimArguments) {
    return { file: spawnable.command, args: spawnable.args.join(' ') };
  }
  return { file: spawnable.command, args: spawnable.args };
}
