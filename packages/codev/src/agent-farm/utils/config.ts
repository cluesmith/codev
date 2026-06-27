/**
 * Configuration management for Agent Farm
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import type { Config, UserConfig, ResolvedCommands } from '../types.js';
import { getSkeletonDir } from '../../lib/skeleton.js';
import { loadConfig } from '../../lib/config.js';
import type { CodevConfig } from '../../lib/config.js';
import { resolveHarness, type HarnessProvider, type CustomHarnessConfig } from './harness.js';
import type { ResolvedWorktreeConfig, WorktreeDevUrl, ResolvedActivityHooks, ActivityHook, ActivityEvent } from '@cluesmith/codev-types';

// Re-export so existing internal callers that import the resolved types
// from this module keep working. The canonical home is now
// @cluesmith/codev-types (these cross HTTP via /api/worktree-config).
export type { ResolvedWorktreeConfig, WorktreeDevUrl };

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default commands
const DEFAULT_COMMANDS = {
  architect: 'claude',
  builder: 'claude',
  shell: 'bash',
};

// CLI overrides (set via setCliOverrides)
let cliOverrides: Partial<ResolvedCommands> = {};

/**
 * Check if we're in a git worktree and return the main repo root if so
 */
export function getMainRepoFromWorktree(dir: string): string | null {
  try {
    // Get the common git directory (same for main repo and worktrees)
    const gitCommonDir = execSync('git rev-parse --git-common-dir', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // If it's just '.git', we're in the main repo
    if (gitCommonDir === '.git') {
      return null;
    }

    // We're in a worktree - gitCommonDir points to main repo's .git directory
    // e.g., /path/to/main/repo/.git or /path/to/main/repo/.git/worktrees/...
    // The main repo is the parent of .git
    const mainGitDir = resolve(dir, gitCommonDir);
    const mainRepo = dirname(mainGitDir.replace(/\/worktrees\/[^/]+$/, ''));
    return mainRepo;
  } catch {
    // Not in a git repo
    return null;
  }
}

/**
 * Find the workspace root by looking for codev/ directory.
 *
 * When in a git worktree, finds the worktree root (via .git marker) and
 * checks if it has its own codev/ directory. Builder worktrees are full
 * git checkouts with their own codev/, so we use the worktree root —
 * not the main repo. This prevents file writes from leaking to the main
 * tree when tools run inside builder worktrees.
 *
 * See: https://github.com/cluesmith/codev-public/issues/407
 */
function findWorkspaceRoot(startDir: string = process.cwd()): string {
  const mainRepo = getMainRepoFromWorktree(startDir);

  if (mainRepo) {
    // We're in a git worktree. Find the worktree root by walking up to
    // the .git file (worktrees have a .git file, not a directory).
    let dir = startDir;
    while (dir !== '/') {
      if (existsSync(resolve(dir, '.git'))) {
        // Found the worktree root. If it has its own codev/, use it
        // instead of resolving to the main repo.
        if (existsSync(resolve(dir, 'codev'))) {
          return dir;
        }
        break;
      }
      dir = dirname(dir);
    }

    // Worktree doesn't have codev/ — fall back to main repo
    if (existsSync(resolve(mainRepo, 'codev'))) {
      return mainRepo;
    }
  }

  // Not in a worktree: walk up looking for codev/ or .git
  let dir = startDir;
  while (dir !== '/') {
    if (existsSync(resolve(dir, 'codev'))) {
      return dir;
    }
    if (existsSync(resolve(dir, '.git'))) {
      return dir;
    }
    dir = dirname(dir);
  }

  // Default to current directory
  return startDir;
}

/**
 * Get the agent-farm templates directory
 * Templates are bundled with agent-farm, not in project codev/ directory
 */
function getTemplatesDir(): string {
  // 1. Try relative to compiled output (dist/utils/ -> templates/)
  const pkgPath = resolve(__dirname, '../templates');
  if (existsSync(pkgPath)) {
    return pkgPath;
  }

  // 2. Try relative to source (src/utils/ -> templates/)
  const devPath = resolve(__dirname, '../../templates');
  if (existsSync(devPath)) {
    return devPath;
  }

  // Return the expected path even if not found (servers handle their own template lookup)
  return devPath;
}

/**
 * Get the servers directory (compiled TypeScript servers)
 */
function getServersDir(): string {
  // Servers are compiled to dist/servers/
  const devPath = resolve(__dirname, '../servers');
  if (existsSync(devPath)) {
    return devPath;
  }

  // In npm package, they're alongside other compiled files
  return resolve(__dirname, './servers');
}

/**
 * Get the roles directory using the unified resolution chain.
 * Priority: config override → .codev/roles/ → codev/roles/ → skeleton/roles/
 */
function getRolesDir(workspaceRoot: string, userConfig: UserConfig | null): string {
  // Check config.json override
  if (userConfig?.roles?.dir) {
    const configPath = resolve(workspaceRoot, userConfig.roles.dir);
    if (existsSync(configPath)) {
      return configPath;
    }
  }

  // Check .codev/roles/ (user customization)
  const overridePath = resolve(workspaceRoot, '.codev/roles');
  if (existsSync(overridePath)) {
    return overridePath;
  }

  // Try local codev/roles/ (legacy local copies)
  const rolesPath = resolve(workspaceRoot, 'codev/roles');
  if (existsSync(rolesPath)) {
    return rolesPath;
  }

  // Fall back to embedded skeleton (package defaults)
  const skeletonRolesPath = resolve(getSkeletonDir(), 'roles');
  if (existsSync(skeletonRolesPath)) {
    return skeletonRolesPath;
  }

  // This should not happen if the package is installed correctly
  throw new Error(`Roles directory not found in .codev/roles/, codev/roles/, or embedded skeleton`);
}

/**
 * Load config from unified config loader (.codev/config.json).
 * Returns as UserConfig for backward compatibility with existing callers.
 */
function loadUserConfig(workspaceRoot: string): UserConfig | null {
  const config = loadConfig(workspaceRoot);
  // The unified loader always returns a config (with defaults merged in).
  // Convert to UserConfig shape for backward compat.
  return config as UserConfig;
}

/**
 * Expand environment variables in a string
 * Supports ${VAR} and $VAR syntax
 */
function expandEnvVars(str: string): string {
  return str.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, unbraced) => {
    const varName = braced || unbraced;
    return process.env[varName] || '';
  });
}

/**
 * Convert command (string or array) to string with env var expansion
 */
function resolveCommand(cmd: string | string[] | undefined, defaultCmd: string): string {
  if (!cmd) {
    return defaultCmd;
  }

  if (Array.isArray(cmd)) {
    // Join array elements, handling escaping
    return cmd.map(expandEnvVars).join(' ');
  }

  return expandEnvVars(cmd);
}

/**
 * Set CLI overrides for commands
 * These take highest priority in the hierarchy
 */
export function setCliOverrides(overrides: Partial<ResolvedCommands>): void {
  cliOverrides = { ...overrides };
}

/**
 * Get resolved commands following hierarchy: CLI > config.json > defaults
 */
export function getResolvedCommands(workspaceRoot?: string): ResolvedCommands {
  const root = workspaceRoot || findWorkspaceRoot();
  const userConfig = loadUserConfig(root);

  return {
    architect: cliOverrides.architect ||
               resolveCommand(userConfig?.shell?.architect, DEFAULT_COMMANDS.architect),
    builder: cliOverrides.builder ||
             resolveCommand(userConfig?.shell?.builder, DEFAULT_COMMANDS.builder),
    shell: cliOverrides.shell ||
           resolveCommand(userConfig?.shell?.shell, DEFAULT_COMMANDS.shell),
  };
}

/**
 * Get the resolved harness provider for the architect shell.
 * Resolution: explicit architectHarness → auto-detect from architect command → default claude.
 */
export function getArchitectHarness(workspaceRoot?: string): HarnessProvider {
  const root = workspaceRoot || findWorkspaceRoot();
  const userConfig = loadUserConfig(root);
  const architectCmd = resolveCommand(userConfig?.shell?.architect, DEFAULT_COMMANDS.architect);
  return resolveHarness(
    userConfig?.shell?.architectHarness,
    userConfig?.harness as Record<string, CustomHarnessConfig> | undefined,
    architectCmd,
  );
}

/**
 * Get the resolved harness provider for the builder shell.
 * Resolution: explicit builderHarness → auto-detect from builder command → default claude.
 */
export function getBuilderHarness(workspaceRoot?: string): HarnessProvider {
  const root = workspaceRoot || findWorkspaceRoot();
  const userConfig = loadUserConfig(root);
  const builderCmd = resolveCommand(userConfig?.shell?.builder, DEFAULT_COMMANDS.builder);
  return resolveHarness(
    userConfig?.shell?.builderHarness,
    userConfig?.harness as Record<string, CustomHarnessConfig> | undefined,
    builderCmd,
  );
}

// ResolvedWorktreeConfig + WorktreeDevUrl now live in
// @cluesmith/codev-types (they cross HTTP via /api/worktree-config).
// Re-exported from this module at the top of the file so existing
// internal callers keep working.

/**
 * Load the `worktree` block from .codev/config.json, applying defaults.
 * Unconfigured repos get `{ symlinks: [], postSpawn: [], devCommand: null }`
 * — equivalent to the pre-#689 behavior (no glob symlinks, no post-spawn
 * commands, `afx dev` errors with a clear message pointing at the config).
 */
export function getWorktreeConfig(workspaceRoot?: string): ResolvedWorktreeConfig {
  const root = workspaceRoot || findWorkspaceRoot();
  const userConfig = loadUserConfig(root);
  const w = userConfig?.worktree;
  return {
    symlinks: w?.symlinks ?? [],
    postSpawn: w?.postSpawn ?? [],
    devCommand: w?.devCommand ?? null,
    devUrls: resolveDevUrls(w),
  };
}

const ACTIVITY_EVENTS: ReadonlySet<string> = new Set<ActivityEvent>(['window-focus', 'builder-active']);

interface RawActivityHook { on?: string[]; url?: string; background?: boolean }

/**
 * Read the `activityHooks` array from one config file. Returns `undefined` when the
 * file is missing/invalid or doesn't define the key — so a present-but-empty list in
 * a higher layer can still REPLACE a lower one (array-replace, matching deepMerge).
 */
function readActivityHooksLayer(configPath: string): RawActivityHook[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { activityHooks?: RawActivityHook[] };
    if (!('activityHooks' in parsed)) { return undefined; }
    return Array.isArray(parsed.activityHooks) ? parsed.activityHooks : [];
  } catch {
    return undefined; // absent / unreadable / invalid JSON → layer not present
  }
}

/**
 * Resolved `activityHooks` for a workspace.
 *
 * SECURITY: hooks EXECUTE (the VSCode extension opens their url), so they are
 * resolved ONLY from the user's trusted personal config layers — `~/.codev/config.json`
 * (global, across all repos) and `<root>/.codev/config.local.json` (per-engineer,
 * gitignored) — and NEVER from the committed `.codev/config.json`, which a cloned repo
 * controls (a committed hook would be a zero-click RCE). The project-local layer
 * replaces the global one when present. Malformed entries (no url, or no valid `on`
 * event) are dropped.
 */
export function getActivityHooks(workspaceRoot?: string): ResolvedActivityHooks {
  const root = workspaceRoot || findWorkspaceRoot();
  const local = readActivityHooksLayer(resolve(root, '.codev', 'config.local.json'));
  const global = readActivityHooksLayer(resolve(homedir(), '.codev', 'config.json'));
  const raw = local ?? global ?? [];
  const hooks: ActivityHook[] = raw.flatMap((h) => {
    const on = (h?.on ?? []).filter((e): e is ActivityEvent => ACTIVITY_EVENTS.has(e));
    if (!h?.url || on.length === 0) { return []; }
    return [{ on, url: h.url, background: h.background ?? false }];
  });
  return { hooks };
}

/**
 * Filter malformed entries (missing/empty `label` or `url`). Both
 * fields are mandatory by schema — no default-label fallback.
 */
function resolveDevUrls(w: { devUrls?: Array<{ label?: string; url?: string }> } | undefined): WorktreeDevUrl[] {
  if (!Array.isArray(w?.devUrls)) { return []; }
  return w.devUrls
    .map(e => ({
      label: typeof e?.label === 'string' ? e.label.trim() : '',
      url: typeof e?.url === 'string' ? e.url.trim() : '',
    }))
    .filter(e => e.label && e.url);
}

/**
 * Build configuration for the current project
 */
export function getConfig(): Config {
  const workspaceRoot = findWorkspaceRoot();
  const codevDir = resolve(workspaceRoot, 'codev');
  const userConfig = loadUserConfig(workspaceRoot);

  return {
    workspaceRoot,
    codevDir,
    buildersDir: resolve(workspaceRoot, '.builders'),
    stateDir: resolve(workspaceRoot, '.agent-farm'),
    templatesDir: getTemplatesDir(),
    serversDir: getServersDir(),
    bundledRolesDir: getRolesDir(workspaceRoot, userConfig),
    terminalBackend: userConfig?.terminal?.backend || 'node-pty',
  };
}

/**
 * Ensure required directories exist
 */
export async function ensureDirectories(config: Config): Promise<void> {
  const { mkdir } = await import('node:fs/promises');

  const dirs = [
    config.buildersDir,
    config.stateDir,
  ];

  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

// Exported for testing and for commands that need to resolve workspace from a path
export { findWorkspaceRoot, findWorkspaceRoot as _findWorkspaceRoot };
