/**
 * Path translation across the Git Bash (MSYS2) boundary on native Windows
 * (Spec 1658, Area D).
 *
 * - Windows paths handed to bash as script paths or embedded in arguments go
 *   in POSIX form: `C:\x\y` → `/c/x/y`, `\\server\share\x` → `//server/share/x`.
 * - Paths bash or MSYS tools print come back in POSIX form and are converted to
 *   native form before Node consumes them; otherwise Node reads `/c/x` as the
 *   drive-relative `C:\c\x`.
 * - MSYS rewrites any argument that looks like a POSIX path when it starts a
 *   native program (`gh api /repos/...` would reach `gh` as `C:/Program
 *   Files/Git/repos/...`). Calls whose arguments must pass through unmangled
 *   add `MSYS_PATHCONV_OPT_OUT` to their environment.
 *
 * Pure string functions: no platform check, no file system access.
 */

/** Environment that disables MSYS automatic argument conversion for one call (Git for Windows and MSYS2 spellings). */
export const MSYS_PATHCONV_OPT_OUT: Readonly<Record<string, string>> = Object.freeze({
  MSYS_NO_PATHCONV: '1',
  MSYS2_ARG_CONV_EXCL: '*',
});

/** `env` plus the MSYS conversion opt-out. */
export function withoutMsysPathConversion(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, ...MSYS_PATHCONV_OPT_OUT };
}

const DRIVE_PATH = /^([A-Za-z]):(?:[\\/](.*))?$/;
const UNC_PATH = /^[\\/]{2}([^\\/]+)[\\/]+(.*)$/;
const MSYS_DRIVE_PATH = /^\/([A-Za-z])(?:\/(.*))?$/;

/**
 * A native Windows path in the form Git Bash accepts. Drive paths become
 * `/<drive>/...` (drive lowercased), UNC paths `//server/share/...`, and
 * relative paths keep their place with forward slashes. Spaces are preserved;
 * quoting is the caller's job.
 */
export function toMsysPath(nativePath: string): string {
  const drive = nativePath.match(DRIVE_PATH);
  if (drive !== null) {
    const rest = (drive[2] ?? '').replace(/\\/g, '/');
    return `/${drive[1].toLowerCase()}/${rest}`;
  }
  const unc = nativePath.match(UNC_PATH);
  if (unc !== null) {
    return `//${unc[1]}/${unc[2].replace(/\\/g, '/')}`;
  }
  return nativePath.replace(/\\/g, '/');
}

/**
 * A path printed by Git Bash in native Windows form. `/c/x` → `C:\x`,
 * `//server/share/x` → `\\server\share\x`, and a relative path gets
 * backslashes. A path already in native drive form (`C:/x`, as `git.exe`
 * prints) is normalized to backslashes.
 *
 * Throws for any other root-absolute path (`/usr/bin`, `/tmp`): those live
 * under the MSYS mount table, and guessing their native location would hand
 * Node a wrong path silently.
 */
export function fromMsysPath(msysPath: string): string {
  const drive = msysPath.match(MSYS_DRIVE_PATH);
  if (drive !== null) {
    const rest = (drive[2] ?? '').replace(/\//g, '\\');
    return `${drive[1].toUpperCase()}:\\${rest}`;
  }
  const native = msysPath.match(DRIVE_PATH);
  if (native !== null) {
    return `${native[1].toUpperCase()}:\\${(native[2] ?? '').replace(/\//g, '\\')}`;
  }
  const unc = msysPath.match(UNC_PATH);
  if (unc !== null) {
    return `\\\\${unc[1]}\\${unc[2].replace(/\//g, '\\')}`;
  }
  if (msysPath.startsWith('/')) {
    throw new Error(`Cannot map MSYS path ${msysPath} to a Windows path: only drive (/c/...) and UNC (//server/...) paths translate`);
  }
  return msysPath.replace(/\//g, '\\');
}
