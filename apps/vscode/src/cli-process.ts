import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { resolveSpawnable } from '@cluesmith/codev-sdk/node/executable';

/**
 * Spawn a Codev CLI (`afx`, `codev`). On Windows each is an npm `.cmd` shim,
 * which `spawn` cannot run without a shell, so it goes through the shim
 * resolver (the `node <entry>` it wraps, or a quoted `cmd.exe` line), with no
 * console window. On macOS and Linux the command is spawned as given.
 */
export function spawnCodevCli(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const spawnable = resolveSpawnable(command, args);
  return spawn(spawnable.command, spawnable.args, {
    ...options,
    windowsHide: true,
    windowsVerbatimArguments: spawnable.windowsVerbatimArguments,
  });
}
