import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process';
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

/**
 * Run a Codev CLI (`afx`, `porch`) to completion and resolve its output;
 * rejects on a non-zero exit like `promisify(execFile)`. Same shim resolution
 * as {@link spawnCodevCli}, and no console window: the extension host has no
 * console, so an unhidden console child opens a visible one (Issue #1919).
 */
export function execCodevCli(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  const spawnable = resolveSpawnable(command, args);
  return new Promise((resolve, reject) => {
    execFile(spawnable.command, spawnable.args, {
      ...options,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: spawnable.windowsVerbatimArguments,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}
