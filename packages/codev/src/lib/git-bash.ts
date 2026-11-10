/**
 * Git Bash resolution for native Windows (Spec 1658, ruling 5 as amended
 * 2026-10-21T06:15:45Z).
 *
 * Git Bash is Codev's only plumbing shell on Windows: forge concepts, the
 * builder launch script, `postSpawn`, `devCommand` and shell-string porch
 * checks all run through the one binary this module resolves. Bare `bash` is
 * never invoked, because `%SystemRoot%\System32\bash.exe` is the WSL launcher
 * and is often first on `PATH`.
 *
 * Order:
 * 1. An explicit override, `windows.gitBashPath` in `.codev/config.json`, else
 *    `CLAUDE_CODE_GIT_BASH_PATH`. It wins when it points at a real Git Bash and
 *    fails loudly when it does not (no silent fallback).
 * 2. The standard install locations.
 * 3. `PATH`: each `bash` that is Git's (never the WSL launcher), then the
 *    install that owns a `git.exe` on `PATH`.
 *
 * "A real Git Bash" is decided by layout, without running bash (running the
 * WSL launcher would start WSL): `<GitRoot>\bin\bash.exe` or
 * `<GitRoot>\usr\bin\bash.exe`, beside a `git.exe` whose `--version` names a
 * Git for Windows build. The resolver is pure over its injected host, so it is
 * testable on any platform.
 */

import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { findAllExecutables } from '@cluesmith/codev-sdk/node/executable';

/** Where the resolved Git Bash came from. */
export type GitBashSource = 'config' | 'env' | 'install' | 'path';

export interface GitBash {
  /** Full native path of `bash.exe`. */
  path: string;
  /** The Git for Windows install root (`<root>\bin\bash.exe`). */
  root: string;
  /** `git --version` output of the same install, e.g. `git version 2.47.1.windows.1`. */
  gitVersion: string;
  source: GitBashSource;
}

/** Why resolution failed; `not-found` means no override and no Git for Windows anywhere. */
export type GitBashFailure = 'override-missing' | 'override-wsl' | 'override-not-git' | 'not-found';

export class GitBashError extends Error {
  constructor(readonly failure: GitBashFailure, message: string) {
    super(message);
    this.name = 'GitBashError';
  }
}

/** Host seams. Every field defaults to the real process. */
export interface GitBashHost {
  env?: Record<string, string | undefined>;
  /** True when the path is an existing file. */
  isFile?: (file: string) => boolean;
  /** `<gitExe> --version` output, or null when it does not run. */
  gitVersion?: (gitExe: string) => string | null;
  /** Every `bash` on `PATH`, in order. */
  findBashOnPath?: () => string[];
  /** Every `git` on `PATH`, in order. Git's default `PATH` entry is `<root>\cmd`, which holds no bash. */
  findGitOnPath?: () => string[];
}

export interface ResolveGitBashOptions {
  /** `windows.gitBashPath` from `.codev/config.json`, when set. */
  configPath?: string;
}

export const GIT_BASH_ENV = 'CLAUDE_CODE_GIT_BASH_PATH';
export const GIT_BASH_CONFIG_KEY = 'windows.gitBashPath';

const INSTALL_HINT =
  'Install Git for Windows (https://git-scm.com/download/win, or `winget install --id Git.Git`), '
  + `or set ${GIT_BASH_CONFIG_KEY} in .codev/config.json (or ${GIT_BASH_ENV}) to its bin\\bash.exe`;

interface Host {
  env: Record<string, string | undefined>;
  isFile: (file: string) => boolean;
  gitVersion: (gitExe: string) => string | null;
  findBashOnPath: () => string[];
  findGitOnPath: () => string[];
}

function defaultIsFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function defaultGitVersion(gitExe: string): string | null {
  const result = spawnSync(gitExe, ['--version'], { encoding: 'utf-8', timeout: 5000, windowsHide: true });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return null;
  }
  return result.stdout.trim();
}

function resolveHost(host: GitBashHost): Host {
  const env = host.env ?? process.env;
  return {
    env,
    isFile: host.isFile ?? defaultIsFile,
    gitVersion: host.gitVersion ?? defaultGitVersion,
    findBashOnPath: host.findBashOnPath ?? (() => findAllExecutables('bash', { platform: 'win32', env })),
    findGitOnPath: host.findGitOnPath ?? (() => findAllExecutables('git', { platform: 'win32', env })),
  };
}

/** Read an environment variable case-insensitively, as Windows does. */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === upper && env[key] !== undefined && env[key] !== '') {
      return env[key];
    }
  }
  return undefined;
}

/**
 * True for `bash.exe` in the Windows system directories or the Store app alias
 * directory: the WSL launcher, never Git Bash.
 */
export function isWslLauncher(bashPath: string, env: Record<string, string | undefined> = process.env): boolean {
  const normalized = win32.normalize(bashPath).toLowerCase();
  if (win32.basename(normalized) !== 'bash.exe') {
    return false;
  }
  const dir = win32.dirname(normalized);
  const systemRoot = win32.normalize(envValue(env, 'SystemRoot') ?? 'C:\\Windows').toLowerCase();
  for (const sub of ['system32', 'sysnative', 'syswow64']) {
    if (dir === win32.join(systemRoot, sub)) {
      return true;
    }
  }
  if (/\\windows\\(system32|sysnative|syswow64)$/.test(dir)) {
    return true;
  }
  return /\\microsoft\\windowsapps$/.test(dir);
}

/** The Git for Windows root that owns `bashPath`, by layout, or null. */
function gitRootOf(bashPath: string): string | null {
  const normalized = win32.normalize(bashPath);
  if (win32.basename(normalized).toLowerCase() !== 'bash.exe') {
    return null;
  }
  const binDir = win32.dirname(normalized);
  if (win32.basename(binDir).toLowerCase() !== 'bin') {
    return null;
  }
  const parent = win32.dirname(binDir);
  if (win32.basename(parent).toLowerCase() === 'usr') {
    return win32.dirname(parent);
  }
  return parent;
}

/** The Git for Windows root that owns `gitExe` (`<root>\cmd`, `<root>\bin` or `<root>\mingw64\bin`), or null. */
function gitRootOfGitExe(gitExe: string): string | null {
  const normalized = win32.normalize(gitExe);
  if (win32.basename(normalized).toLowerCase() !== 'git.exe') {
    return null;
  }
  const dir = win32.dirname(normalized);
  const dirName = win32.basename(dir).toLowerCase();
  if (dirName === 'cmd') {
    return win32.dirname(dir);
  }
  if (dirName !== 'bin') {
    return null;
  }
  const parent = win32.dirname(dir);
  if (win32.basename(parent).toLowerCase() === 'mingw64') {
    return win32.dirname(parent);
  }
  return parent;
}

/** The validated Git Bash at `bashPath`, or null when it is not one. */
function asGitBash(bashPath: string, source: GitBashSource, host: Host): GitBash | null {
  if (isWslLauncher(bashPath, host.env) || !host.isFile(bashPath)) {
    return null;
  }
  const root = gitRootOf(bashPath);
  if (root === null) {
    return null;
  }
  for (const rel of ['cmd\\git.exe', 'bin\\git.exe', 'mingw64\\bin\\git.exe']) {
    const gitExe = win32.join(root, rel);
    if (!host.isFile(gitExe)) {
      continue;
    }
    const version = host.gitVersion(gitExe);
    if (version !== null && /\.windows\./i.test(version)) {
      return { path: win32.normalize(bashPath), root, gitVersion: version, source };
    }
  }
  return null;
}

function checkOverride(value: string, source: 'config' | 'env', host: Host): GitBash {
  let label: string = GIT_BASH_ENV;
  if (source === 'config') {
    label = `${GIT_BASH_CONFIG_KEY} in .codev/config.json`;
  }
  if (isWslLauncher(value, host.env)) {
    throw new GitBashError(
      'override-wsl',
      `${label} is ${value}, the WSL launcher, not Git Bash. Point it at Git for Windows' bin\\bash.exe (for example C:\\Program Files\\Git\\bin\\bash.exe)`,
    );
  }
  if (!host.isFile(value)) {
    throw new GitBashError('override-missing', `${label} is ${value}, which does not exist. Point it at Git for Windows' bin\\bash.exe`);
  }
  const resolved = asGitBash(value, source, host);
  if (resolved === null) {
    throw new GitBashError(
      'override-not-git',
      `${label} is ${value}, which is not a Git for Windows bash (expected <Git>\\bin\\bash.exe beside a Git for Windows git.exe)`,
    );
  }
  return resolved;
}

/**
 * Resolve Git Bash. Throws `GitBashError` with an actionable message naming
 * Git for Windows when no valid Git Bash exists or an override is invalid.
 */
export function resolveGitBash(options: ResolveGitBashOptions = {}, hostSeams: GitBashHost = {}): GitBash {
  const host = resolveHost(hostSeams);

  const configPath = options.configPath?.trim();
  if (configPath) {
    return checkOverride(configPath, 'config', host);
  }
  const envPath = envValue(host.env, GIT_BASH_ENV)?.trim();
  if (envPath) {
    return checkOverride(envPath, 'env', host);
  }

  // ProgramW6432 is the 64-bit Program Files even for a 32-bit Node, whose
  // ProgramFiles is the x86 one.
  const installs: string[] = [];
  for (const programFiles of [envValue(host.env, 'ProgramW6432'), envValue(host.env, 'ProgramFiles') ?? 'C:\\Program Files']) {
    if (programFiles === undefined) {
      continue;
    }
    const candidate = win32.join(programFiles, 'Git', 'bin', 'bash.exe');
    if (!installs.some((seen) => seen.toLowerCase() === candidate.toLowerCase())) {
      installs.push(candidate);
    }
  }
  const localAppData = envValue(host.env, 'LocalAppData');
  if (localAppData !== undefined) {
    installs.push(win32.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'));
  }
  for (const candidate of installs) {
    const resolved = asGitBash(candidate, 'install', host);
    if (resolved !== null) {
      return resolved;
    }
  }

  for (const candidate of host.findBashOnPath()) {
    const resolved = asGitBash(candidate, 'path', host);
    if (resolved !== null) {
      return resolved;
    }
  }

  for (const gitExe of host.findGitOnPath()) {
    const root = gitRootOfGitExe(gitExe);
    if (root === null) {
      continue;
    }
    const resolved = asGitBash(win32.join(root, 'bin', 'bash.exe'), 'path', host);
    if (resolved !== null) {
      return resolved;
    }
  }

  throw new GitBashError('not-found', `Git for Windows (Git Bash) not found. Codev on native Windows runs its scripts through Git Bash. ${INSTALL_HINT}`);
}
