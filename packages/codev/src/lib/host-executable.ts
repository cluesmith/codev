/**
 * Executables on the host platform (Spec 1658): `which`-style lookup and the
 * shell-free spawn form of a command. On POSIX both are what they always were;
 * on Windows they honor `PATHEXT` and turn an npm `.cmd` shim into something
 * `CreateProcess` can start.
 */

import { resolveSpawnable, findExecutable, type SpawnableCommand } from '@cluesmith/codev-sdk/node/executable';
import { hostPlatform } from './platform.js';

/** A program and its arguments, ready for `child_process.spawn` without `shell`. */
export interface Launch {
  command: string;
  args: string[];
}

/**
 * `command` in a form the host can spawn without a shell. On Windows a `.cmd`
 * shim becomes the `node <entry>` it wraps, or a `cmd.exe /d /s /c` line; on
 * POSIX the input comes back unchanged.
 */
export function spawnableOnHost(command: string, args: string[] = [], env: NodeJS.ProcessEnv = process.env): SpawnableCommand {
  return resolveSpawnable(command, args, { platform: hostPlatform(), env });
}

/** `which`-style lookup for the host platform, honoring `PATHEXT` on Windows. */
export function findOnHostPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return findExecutable(name, { platform: hostPlatform(), env });
}
