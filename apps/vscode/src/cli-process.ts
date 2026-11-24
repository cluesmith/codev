import { ChildProcess, execFile, spawn, type ExecFileOptions, type SpawnOptions } from 'node:child_process';
import { resolveSpawnable, type SpawnableCommand } from '@cluesmith/codev-sdk/node/executable';

/**
 * Windows looks a bare name up in the current folder before `PATH` (#1911), so
 * a `codev.exe` in the open workspace would run in place of Codev. The
 * resolver searches `PATH` only and hands the name back unchanged when it is
 * not there; that case must fail here rather than reach `spawn`. The extension
 * host is shared with other extensions, so it does not set
 * `NoDefaultCurrentDirectoryInExePath` process-wide as the Codev CLIs do.
 */
function unresolvedOnWindows(command: string, spawnable: SpawnableCommand): boolean {
  return process.platform === 'win32' && spawnable.command === command && !/[\\/]/.test(command);
}

/** The ENOENT error `spawn` raises for a missing program. */
function notFoundError(command: string, args: string[]): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${command} ENOENT (not found on PATH)`), {
    code: 'ENOENT',
    errno: -4058, // UV_ENOENT on Windows, the errno a real failed spawn carries
    syscall: `spawn ${command}`,
    path: command,
    spawnargs: args,
  });
}

/**
 * Spawn a Codev CLI (`afx`, `codev`). On Windows each is an npm `.cmd` shim,
 * which `spawn` cannot run without a shell, so it goes through the shim
 * resolver (the `node <entry>` it wraps, or a quoted `cmd.exe` line), with no
 * console window. On macOS and Linux the command is spawned as given.
 */
export function spawnCodevCli(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const spawnable = resolveSpawnable(command, args);
  if (unresolvedOnWindows(command, spawnable)) {
    // The async contract callers already handle: an 'error' event, never a throw.
    const child = new ChildProcess();
    process.nextTick(() => child.emit('error', notFoundError(command, args)));
    return child;
  }
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
  if (unresolvedOnWindows(command, spawnable)) {
    return Promise.reject(notFoundError(command, args));
  }
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
