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
 * This is a side-effect module: every Codev process entry point (each
 * `bin/*.js`, `tower-server.ts`, `shellper-main.ts`) imports it FIRST, so it runs
 * before any other module can spawn. It imports nothing for the same reason.
 * `exe-search-hardening.test.ts` enforces the import order.
 */

export const NO_CWD_EXE_SEARCH_ENV = 'NoDefaultCurrentDirectoryInExePath';

/** Set the variable on Windows; a no-op elsewhere (POSIX never searches the cwd). */
export function hardenExeSearch(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): void {
  if (platform !== 'win32') {
    return;
  }
  env[NO_CWD_EXE_SEARCH_ENV] = '1';
}

hardenExeSearch(process.platform, process.env);
