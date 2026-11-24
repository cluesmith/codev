/**
 * The base environment of a Windows PTY child (Spec 1658, Area D). A leaf
 * module (no imports), because the shellper process loads it.
 */

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
  // #1911: never run a program from the current folder, also in a terminal built
  // from this allowlist (the non-persistent fallback when shellper is unavailable).
  // The name is NO_CWD_EXE_SEARCH_ENV in `exe-search.ts`; spelled out to stay a leaf.
  base.NoDefaultCurrentDirectoryInExePath = '1';
  return base;
}
