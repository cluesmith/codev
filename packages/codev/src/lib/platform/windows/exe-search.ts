/**
 * Windows: never run a program from the current folder (#1911).
 *
 * On Windows a program started by bare name (`git`, `gh`, `npm`, `codev`) is
 * looked up in the current directory before `PATH`, by libuv for
 * `child_process` spawns and by `cmd.exe` for `exec` strings. Codev runs those
 * commands with a builder worktree or a cloned repository as the cwd, so a
 * `git.exe` committed to a repository would run instead of Git.
 *
 * `NoDefaultCurrentDirectoryInExePath` turns that lookup off: libuv reads it
 * from the calling process's environment, `cmd.exe` from its inherited one,
 * and every child inherits it. A tool missing from `PATH` then fails with
 * ENOENT instead of running the planted file. (node-pty does its own PATH-only
 * lookup and never searches the terminal's cwd.)
 *
 * Applied once per process by `lib/process-bootstrap.ts`, which every Codev
 * entry point imports first. Imports nothing, so loading it spawns nothing.
 */

export const NO_CWD_EXE_SEARCH_ENV = 'NoDefaultCurrentDirectoryInExePath';

/** Turn off the current-folder program lookup for this process and its children. */
export function hardenExeSearch(env: NodeJS.ProcessEnv): void {
  env[NO_CWD_EXE_SEARCH_ENV] = '1';
}
