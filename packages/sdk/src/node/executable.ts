/**
 * Node-only executable lookup (`@cluesmith/codev-sdk/node/executable`), Spec 1658.
 *
 * Two jobs, shared by `@cluesmith/codev` and the VS Code extension (which cannot
 * import `@cluesmith/codev`):
 *
 * - `findExecutable`: a `which`-style `PATH` lookup that honors `PATHEXT` on
 *   Windows, so `claude` resolves to `claude.cmd` or `claude.exe`.
 * - `resolveSpawnable`: turn a command into a form `CreateProcess` can run
 *   without a shell. `CreateProcess` executes `.exe`/`.com` files only, so a
 *   `.cmd`/`.bat` shim (what every npm-installed bin is on Windows) becomes
 *   either the `node <entry>` it wraps or `%COMSPEC% /d /s /c "<shim> <args>"`.
 *
 * On POSIX both are plain `PATH` lookups and `resolveSpawnable` returns its
 * input unchanged. Platform, environment and file probes are injectable so the
 * Windows branches are testable on any host.
 */

import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/** Host seams for the lookups. Every field defaults to the real process. */
export interface ExecutableLookupOptions {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** True when `candidate` is a file the platform would execute. */
  isExecutableFile?: (candidate: string) => boolean;
  /** Text of a file, or null when unreadable. Used to read `.cmd` shims. */
  readText?: (file: string) => string | null;
}

/** A command and arguments ready for `child_process.spawn` without `shell`. */
export interface SpawnableCommand {
  command: string;
  args: string[];
  /**
   * True when `args` is a pre-quoted command line for `cmd.exe`: pass
   * `windowsVerbatimArguments: true` to `spawn` (or the joined args as
   * node-pty's string form) so Node does not quote it again.
   */
  windowsVerbatimArguments: boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

// cmd.exe metacharacters, escaped with `^` inside a `/s /c` command line.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function defaultIsExecutableFile(platform: NodeJS.Platform): (candidate: string) => boolean {
  return (candidate: string): boolean => {
    try {
      if (platform !== 'win32') {
        accessSync(candidate, constants.X_OK);
      }
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
}

function defaultReadText(file: string): string | null {
  try {
    return readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

interface ResolvedOptions {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  isExecutableFile: (candidate: string) => boolean;
  readText: (file: string) => string | null;
}

function resolveOptions(options: ExecutableLookupOptions): ResolvedOptions {
  const platform = options.platform ?? process.platform;
  return {
    platform,
    env: options.env ?? process.env,
    isExecutableFile: options.isExecutableFile ?? defaultIsExecutableFile(platform),
    readText: options.readText ?? defaultReadText,
  };
}

/** Read an environment variable; Windows variable names are case-insensitive. */
function envValue(opts: ResolvedOptions, name: string): string | undefined {
  if (opts.env[name] !== undefined) {
    return opts.env[name];
  }
  if (opts.platform !== 'win32') {
    return undefined;
  }
  const upper = name.toUpperCase();
  for (const key of Object.keys(opts.env)) {
    if (key.toUpperCase() === upper) {
      return opts.env[key];
    }
  }
  return undefined;
}

function pathExtensions(opts: ResolvedOptions): string[] {
  const raw = envValue(opts, 'PATHEXT') ?? DEFAULT_PATHEXT;
  return raw.split(';').filter((ext) => ext !== '');
}

function hasPathSeparator(name: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    return name.includes('/') || name.includes('\\');
  }
  return name.includes('/');
}

/**
 * Candidate file names for `name` in one directory. On Windows a name that
 * already carries a `PATHEXT` extension is tried as-is first, then with each
 * extension appended, as `cmd.exe` does.
 */
function candidatesIn(dir: string, name: string, opts: ResolvedOptions): string[] {
  if (opts.platform !== 'win32') {
    return [posix.join(dir, name)];
  }
  const extensions = pathExtensions(opts);
  const out: string[] = [];
  const ext = win32.extname(name).toUpperCase();
  if (ext !== '' && extensions.some((e) => e.toUpperCase() === ext)) {
    out.push(win32.join(dir, name));
  }
  for (const e of extensions) {
    out.push(win32.join(dir, name + e));
  }
  return out;
}

/**
 * Every match for `name` on `PATH`, in `PATH` order. A name containing a path
 * separator is checked directly (with `PATHEXT` on Windows) instead.
 */
export function findAllExecutables(name: string, options: ExecutableLookupOptions = {}): string[] {
  const opts = resolveOptions(options);
  const pathModule = opts.platform === 'win32' ? win32 : posix;
  if (hasPathSeparator(name, opts.platform)) {
    const dir = pathModule.dirname(name);
    const base = pathModule.basename(name);
    return candidatesIn(dir, base, opts).filter((c) => opts.isExecutableFile(c)).slice(0, 1);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of (envValue(opts, 'PATH') ?? '').split(pathModule.delimiter)) {
    if (dir === '') {
      continue;
    }
    for (const candidate of candidatesIn(dir, name, opts)) {
      let key = candidate;
      if (opts.platform === 'win32') {
        key = candidate.toLowerCase();
      }
      if (seen.has(key)) {
        continue;
      }
      if (opts.isExecutableFile(candidate)) {
        seen.add(key);
        out.push(candidate);
      }
    }
  }
  return out;
}

/** The first match for `name` on `PATH` (`which`), or null. */
export function findExecutable(name: string, options: ExecutableLookupOptions = {}): string | null {
  const all = findAllExecutables(name, options);
  if (all.length === 0) {
    return null;
  }
  return all[0];
}

/** True when `name` resolves on `PATH`. */
export function isExecutableOnPath(name: string, options: ExecutableLookupOptions = {}): boolean {
  return findExecutable(name, options) !== null;
}

// npm (cmd-shim) writes `"%_prog%" "%dp0%\<relative entry>" %*`, with `%dp0%`
// (or `%~dp0`) as the shim's directory.
const NPM_SHIM_ENTRY = /"%~?dp0%?\\?([^"]+\.(?:c|m)?js)"/i;

/** The entry script named inside an npm-generated `.cmd` shim, or null for any other file. */
function npmShimRelativeEntry(shimPath: string, opts: ResolvedOptions): string | null {
  const text = opts.readText(shimPath);
  if (text === null) {
    return null;
  }
  const match = text.match(NPM_SHIM_ENTRY);
  if (match === null) {
    return null;
  }
  return match[1];
}

/** The `node.exe` an npm shim would use: one beside the shim, else `node` on `PATH`. */
function shimNode(shimPath: string, opts: ResolvedOptions): string | null {
  const beside = win32.join(win32.dirname(shimPath), 'node.exe');
  if (opts.isExecutableFile(beside)) {
    return beside;
  }
  const onPath = findExecutable('node', opts);
  if (onPath === null || win32.extname(onPath).toLowerCase() !== '.exe') {
    return null;
  }
  return onPath;
}

/** Quote one argument for a `cmd.exe /s /c` line (MSVCRT rules, then `^` escapes). */
function quoteCmdArgument(arg: string, doubleEscape: boolean): string {
  let quoted = arg.replace(/(\\*)"/g, '$1$1\\"');
  quoted = quoted.replace(/(\\*)$/, '$1$1');
  quoted = `"${quoted}"`;
  quoted = quoted.replace(CMD_META_CHARS, '^$1');
  if (doubleEscape) {
    quoted = quoted.replace(CMD_META_CHARS, '^$1');
  }
  return quoted;
}

/** `%COMSPEC% /d /s /c "<shim> <args>"`, quoted so `cmd.exe` passes each arg through intact. */
function cmdShellForm(shimPath: string, args: string[], npmShim: boolean, opts: ResolvedOptions): SpawnableCommand {
  // A shim generated by npm re-parses %* through cmd.exe once more, so its
  // arguments need a second round of `^` escapes.
  const doubleEscape = npmShim || /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i.test(shimPath);
  const line = [shimPath.replace(CMD_META_CHARS, '^$1'), ...args.map((a) => quoteCmdArgument(a, doubleEscape))].join(' ');
  return {
    command: envValue(opts, 'COMSPEC') ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * A command `CreateProcess` can run directly (no shell). On POSIX, and for a
 * Windows command that does not resolve, the input comes back unchanged so the
 * spawn fails with its usual ENOENT. On Windows:
 *
 * - `.exe`/`.com` → the resolved full path.
 * - an npm `.cmd` shim → `node.exe <entry> <args>`, the process the shim would start.
 * - any other `.cmd`/`.bat` → `%COMSPEC% /d /s /c "<shim> <args>"` with
 *   `windowsVerbatimArguments`.
 */
export function resolveSpawnable(
  command: string,
  args: string[] = [],
  options: ExecutableLookupOptions = {},
): SpawnableCommand {
  const opts = resolveOptions(options);
  const unchanged: SpawnableCommand = { command, args, windowsVerbatimArguments: false };
  if (opts.platform !== 'win32') {
    return unchanged;
  }
  const resolved = findExecutable(command, opts);
  if (resolved === null) {
    return unchanged;
  }
  const ext = win32.extname(resolved).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') {
    return { command: resolved, args, windowsVerbatimArguments: false };
  }
  const relativeEntry = npmShimRelativeEntry(resolved, opts);
  if (relativeEntry === null) {
    return cmdShellForm(resolved, args, false, opts);
  }
  const entry = win32.join(win32.dirname(resolved), relativeEntry);
  const node = shimNode(resolved, opts);
  if (node === null || !opts.isExecutableFile(entry)) {
    return cmdShellForm(resolved, args, true, opts);
  }
  return { command: node, args: [entry, ...args], windowsVerbatimArguments: false };
}
