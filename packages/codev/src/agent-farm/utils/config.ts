/**
 * Configuration management for Agent Farm
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import type { Config, UserConfig, ResolvedCommands } from '../types.js';
import { getSkeletonDir } from '../../lib/skeleton.js';

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
function getMainRepoFromWorktree(dir: string): string | null {
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
 * Find the workspace root by looking for codev/ directory
 * Handles git worktrees by finding the main repository
 */
function findWorkspaceRoot(startDir: string = process.cwd()): string {
  // First check if we're in a git worktree
  const mainRepo = getMainRepoFromWorktree(startDir);
  if (mainRepo && existsSync(resolve(mainRepo, 'codev'))) {
    return mainRepo;
  }

  let dir = startDir;

  while (dir !== '/') {
    // Check for codev/ directory (indicates project using codev)
    if (existsSync(resolve(dir, 'codev'))) {
      return dir;
    }
    // Check for .git as fallback
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
 * Get the roles directory (from codev/roles/, config override, or embedded skeleton)
 */
function getRolesDir(workspaceRoot: string, userConfig: UserConfig | null): string {
  // Check config.json override
  if (userConfig?.roles?.dir) {
    const configPath = resolve(workspaceRoot, userConfig.roles.dir);
    if (existsSync(configPath)) {
      return configPath;
    }
  }

  // Try local codev/roles/ first
  const rolesPath = resolve(workspaceRoot, 'codev/roles');
  if (existsSync(rolesPath)) {
    return rolesPath;
  }

  // Fall back to embedded skeleton
  const skeletonRolesPath = resolve(getSkeletonDir(), 'roles');
  if (existsSync(skeletonRolesPath)) {
    return skeletonRolesPath;
  }

  // This should not happen if the package is installed correctly
  throw new Error(`Roles directory not found in local codev/roles/ or embedded skeleton`);
}

/**
 * Load af-config.json from project root
 */
function loadUserConfig(workspaceRoot: string): UserConfig | null {
  const configPath = resolve(workspaceRoot, 'af-config.json');
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      return JSON.parse(content) as UserConfig;
    } catch (error) {
      throw new Error(`Failed to parse af-config.json: ${error}`);
    }
  }

  return null;
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
