/**
 * Tower-owned IDE extensions directory and the embedded sidebar install (Spec 1789).
 *
 * The codev package ships the sidebar vsix in `ide-extension/`. Before Tower
 * spawns a Codev IDE server it makes sure `~/.agent-farm/ide-extensions` holds
 * that sidebar at exactly the embedded version, using the server's own CLI
 * (`--install-extension <vsix> --force --extensions-dir <dir>`). Only the
 * sidebar is touched: other extensions in the directory are left alone.
 */

import { existsSync, lstatSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_FARM_DIR } from './tower-client.js';
import {
  IDE_INSTALL_TIMEOUT_MS,
  IdeServerCommandError,
  type LogFn,
  buildIdeServerEnv,
  runIdeServerCommand,
} from './ide-version.js';

/**
 * Embedded sidebar layout inside the installed package. Mirrors
 * `scripts/ide-extension-manifest.mjs`, which writes it at build time but is
 * not shipped; a parity test keeps the two in step.
 */
export const IDE_EXTENSION_DIR = 'ide-extension';
export const IDE_EXTENSION_VSIX = 'codev-vscode.vsix';
export const IDE_EXTENSION_MANIFEST = 'manifest.json';

/** Directory name of the Tower-owned extensions directory under AGENT_FARM_DIR. */
export const IDE_EXTENSIONS_DIRNAME = 'ide-extensions';

/** VS Code's index of the extensions installed in an extensions directory. */
const EXTENSIONS_INDEX = 'extensions.json';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The installed package's `ide-extension/` (the same layout `dashboard-dist` uses). */
const DEFAULT_EMBEDDED_DIR = resolve(__dirname, '../../..', IDE_EXTENSION_DIR);

export function getIdeExtensionsDir(): string {
  return resolve(AGENT_FARM_DIR, IDE_EXTENSIONS_DIRNAME);
}

/** Thrown when the extensions directory exists but is unsafe to use. */
export class IdeExtensionsDirError extends Error {
  constructor(dir: string, problem: string) {
    super(`IDE extensions directory ${dir} ${problem}; remove or fix it and retry`);
    this.name = 'IdeExtensionsDirError';
  }
}

export interface EnsureIdeExtensionsDirOptions {
  /** Expected owner; tests override it because they cannot chown. */
  uid?: number;
}

/**
 * Create the extensions directory owner-only (0700), or validate an existing
 * one: it must be a real directory, not a symlink, owned by the current user.
 */
export function ensureIdeExtensionsDir(dir: string, opts: EnsureIdeExtensionsDirOptions = {}): void {
  if (!existsSync(dir) && !isDanglingSymlink(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode is filtered by the umask; set it explicitly.
    chmodSync(dir, 0o700);
    return;
  }

  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) {
    throw new IdeExtensionsDirError(dir, 'is a symlink');
  }
  if (!stat.isDirectory()) {
    throw new IdeExtensionsDirError(dir, 'is not a directory');
  }
  const uid = opts.uid ?? process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new IdeExtensionsDirError(dir, `is owned by uid ${stat.uid}, not the current user (uid ${uid})`);
  }
}

function isDanglingSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export interface EmbeddedSidebar {
  vsixPath: string;
  id: string;
  version: string;
}

/**
 * The sidebar vsix embedded in the installed package, or null when the vsix or
 * its manifest is missing or unreadable (a source checkout without a package build).
 */
export function locateEmbeddedSidebar(embeddedDir: string = DEFAULT_EMBEDDED_DIR): EmbeddedSidebar | null {
  const vsixPath = resolve(embeddedDir, IDE_EXTENSION_VSIX);
  if (!existsSync(vsixPath)) return null;

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(resolve(embeddedDir, IDE_EXTENSION_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
  if (typeof manifest !== 'object' || manifest === null) return null;
  const { id, version } = manifest as Record<string, unknown>;
  if (typeof id !== 'string' || id === '' || typeof version !== 'string' || version === '') return null;
  return { vsixPath, id, version };
}

/**
 * The version of extension `id` listed in the directory's `extensions.json`,
 * matching the identifier case-insensitively as VS Code does. Null when the
 * index is absent, unreadable or does not list the extension.
 */
export function readInstalledExtensionVersion(dir: string, id: string): string | null {
  let index: unknown;
  try {
    index = JSON.parse(readFileSync(resolve(dir, EXTENSIONS_INDEX), 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(index)) return null;

  const wanted = id.toLowerCase();
  for (const entry of index) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { identifier, version } = entry as { identifier?: { id?: unknown }; version?: unknown };
    if (typeof identifier?.id !== 'string' || identifier.id.toLowerCase() !== wanted) continue;
    if (typeof version === 'string') return version;
  }
  return null;
}

/** Thrown when the server CLI fails to install the embedded sidebar. */
export class IdeSidebarInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdeSidebarInstallError';
  }
}

/** Likely cause of a refused install, appended only when the CLI itself failed. */
const BUILT_IN_SIDEBAR_HINT =
  'The usual cause is a Codev IDE server that bundles codev-vscode as a built-in extension, ' +
  'which refuses the install; use a server package that does not ship the sidebar';

export interface EnsureSidebarInstalledOptions {
  /** Defaults to `getIdeExtensionsDir()`. */
  extensionsDir?: string;
  /** Directory holding the embedded vsix and manifest; defaults to the installed package's. */
  embeddedDir?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  log?: LogFn;
  /** Passed through to `ensureIdeExtensionsDir`. */
  uid?: number;
}

export interface SidebarInstallResult {
  outcome: 'skipped' | 'installed' | 'missing-vsix';
  /** The embedded sidebar version; null when the vsix is missing. */
  version: string | null;
  /** The version indexed before this call; null when none was. */
  previousVersion: string | null;
}

function defaultLog(level: 'INFO' | 'ERROR' | 'WARN', message: string): void {
  console.warn(`[${level}] ${message}`);
}

/**
 * Make the extensions directory hold the embedded sidebar at exactly the
 * embedded version. Skips without a subprocess when that version is already
 * indexed; otherwise installs with `--force` so an older or newer copy is
 * replaced. Throws an `IdeSidebarInstallError` when the install fails, times
 * out, or leaves the index without the embedded version. A missing embedded
 * vsix is only a warning: the IDE works without the sidebar.
 */
export async function ensureSidebarInstalled(
  serverPath: string,
  opts: EnsureSidebarInstalledOptions = {},
): Promise<SidebarInstallResult> {
  const dir = opts.extensionsDir ?? getIdeExtensionsDir();
  const log = opts.log ?? defaultLog;
  ensureIdeExtensionsDir(dir, { uid: opts.uid });

  const sidebar = locateEmbeddedSidebar(opts.embeddedDir);
  if (sidebar === null) {
    log('WARN', 'Embedded Codev sidebar not found (run the package build); the IDE will start without it');
    return { outcome: 'missing-vsix', version: null, previousVersion: null };
  }

  const previousVersion = readInstalledExtensionVersion(dir, sidebar.id);
  if (previousVersion === sidebar.version) {
    return { outcome: 'skipped', version: sidebar.version, previousVersion };
  }

  const timeoutMs = opts.timeoutMs ?? IDE_INSTALL_TIMEOUT_MS;
  const args = ['--install-extension', sidebar.vsixPath, '--force', '--extensions-dir', dir];
  log('INFO', `Installing Codev sidebar ${sidebar.version} into ${dir} (indexed: ${previousVersion ?? 'none'})`);
  try {
    await runIdeServerCommand(serverPath, args, { timeoutMs, env: opts.env ?? buildIdeServerEnv() });
  } catch (failure) {
    if (!(failure instanceof IdeServerCommandError)) throw failure;
    throw new IdeSidebarInstallError(describeInstallFailure(serverPath, sidebar, failure));
  }

  const installedVersion = readInstalledExtensionVersion(dir, sidebar.id);
  if (installedVersion !== sidebar.version) {
    throw new IdeSidebarInstallError(
      `IDE server at ${serverPath} reported success installing the Codev sidebar ${sidebar.version}, ` +
        `but ${dir} lists ${installedVersion ?? 'no version'}`,
    );
  }
  return { outcome: 'installed', version: sidebar.version, previousVersion };
}

function describeInstallFailure(serverPath: string, sidebar: EmbeddedSidebar, failure: IdeServerCommandError): string {
  let detail = `IDE server at ${serverPath} failed to install the Codev sidebar ${sidebar.version} (${failure.message})`;
  if (failure.stderr !== '') {
    detail = `${detail}: ${failure.stderr}`;
  }
  return `${detail}. ${BUILT_IN_SIDEBAR_HINT}`;
}
