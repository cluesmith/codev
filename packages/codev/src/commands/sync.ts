/**
 * codev sync - Fetch and cache remote framework sources.
 *
 * When a remote framework source is configured in .codev/config.json,
 * this command fetches it and caches it locally for runtime resolution.
 *
 * Cache location: ~/.codev/cache/framework/<source-hash>/<ref>/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import chalk from 'chalk';
import { loadConfig } from '../lib/config.js';
import { executeForgeCommand } from '../lib/forge.js';

export interface SyncOptions {
  force?: boolean;
  status?: boolean;
}

/**
 * Get the cache directory for a given source and ref.
 */
export function getCacheDir(source: string, ref?: string): string {
  const sourceHash = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const refPart = ref || 'default';
  return path.join(homedir(), '.codev', 'cache', 'framework', sourceHash, refPart);
}

/**
 * Check if a ref is immutable (tag-like or SHA-like).
 * Tags: v1.2.3, v1.0, release-2026
 * SHAs: 40-char hex strings
 */
function isImmutableRef(ref: string): boolean {
  // SHA-like (40 hex chars)
  if (/^[0-9a-f]{40}$/i.test(ref)) return true;
  // Semver-like tags (v1.0, v1.2.3, 1.0.0, etc.)
  if (/^v?\d+(\.\d+)+/.test(ref)) return true;
  return false;
}

/**
 * Parse source string to extract owner/repo and optional subpath.
 * Handles both shorthand and full URL formats.
 *
 * Examples:
 *   "myorg/repo" → { repo: "myorg/repo", subpath: null }
 *   "myorg/repo/team-a" → { repo: "myorg/repo", subpath: "team-a" }
 *   "https://gitlab.example.com/team/protocols" → { repo: "https://gitlab.example.com/team/protocols", subpath: null }
 */
function parseSource(source: string): { repo: string; subpath: string | null } {
  // Full URLs: treat the entire string as the repo identifier
  if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('git@')) {
    return { repo: source, subpath: null };
  }

  // Shorthand: owner/repo or owner/repo/subpath
  const parts = source.split('/');
  if (parts.length <= 2) {
    return { repo: source, subpath: null };
  }
  return {
    repo: `${parts[0]}/${parts[1]}`,
    subpath: parts.slice(2).join('/'),
  };
}

/**
 * Fetch framework from a forge source.
 */
async function fetchFromForge(
  source: string,
  ref: string | undefined,
  outputDir: string,
  workspaceRoot: string,
): Promise<void> {
  const { repo, subpath } = parseSource(source);

  // Use a temp directory for extraction, then move to final location
  const tmpDir = `${outputDir}.tmp-${Date.now()}`;

  try {
    await executeForgeCommand('repo-archive', {
      CODEV_REPO: repo,
      CODEV_REF: ref || '',
      CODEV_OUTPUT_DIR: tmpDir,
    }, { cwd: workspaceRoot });

    // If subpath specified, extract only that subdirectory
    if (subpath) {
      const subDir = path.join(tmpDir, subpath);
      if (!fs.existsSync(subDir)) {
        throw new Error(`Subpath "${subpath}" not found in repository "${repo}"`);
      }
      fs.mkdirSync(path.dirname(outputDir), { recursive: true });
      fs.renameSync(subDir, outputDir);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } else {
      // Atomic move
      fs.mkdirSync(path.dirname(outputDir), { recursive: true });
      fs.renameSync(tmpDir, outputDir);
    }
  } catch (err) {
    // Clean up temp dir on failure
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    throw err;
  }
}

/**
 * Fetch framework from a custom command.
 */
function fetchFromCommand(
  command: string,
  ref: string | undefined,
  outputDir: string,
): void {
  // Use temp dir + atomic rename to prevent corrupted cache on failure
  const tmpDir = `${outputDir}.tmp-${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const env = {
      ...process.env,
      CODEV_OUTPUT_DIR: tmpDir,
      CODEV_REF: ref || '',
    };

    execSync(command, {
      env: env as NodeJS.ProcessEnv,
      stdio: 'inherit',
    });

    // Atomic move to final location
    fs.mkdirSync(path.dirname(outputDir), { recursive: true });
    fs.renameSync(tmpDir, outputDir);
  } catch (err) {
    // Clean up temp dir on failure — no partial cache
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    throw err;
  }
}

/**
 * Run codev sync — fetch and cache remote framework.
 */
export async function sync(options: SyncOptions = {}): Promise<void> {
  const { force = false, status: showStatus = false } = options;
  const workspaceRoot = process.cwd();

  const config = loadConfig(workspaceRoot);
  const framework = config.framework;

  if (!framework?.source || framework.source === 'local') {
    console.log('No remote framework source configured. Nothing to sync.');
    return;
  }

  const source = framework.source;
  const ref = framework.ref;
  const type = framework.type || 'forge';
  const cacheDir = getCacheDir(source, ref);

  // --status: show cache state
  if (showStatus) {
    console.log(chalk.bold('Framework cache status'));
    console.log('');
    console.log(`  Source: ${source}`);
    console.log(`  Type:   ${type}`);
    console.log(`  Ref:    ${ref || '(default branch)'}`);
    console.log(`  Cache:  ${cacheDir}`);

    if (fs.existsSync(cacheDir)) {
      const stat = fs.statSync(cacheDir);
      console.log(`  Status: ${chalk.green('cached')}`);
      console.log(`  Last fetched: ${stat.mtime.toISOString()}`);
    } else {
      console.log(`  Status: ${chalk.yellow('not cached')}`);
    }
    return;
  }

  // Check cache
  if (fs.existsSync(cacheDir) && !force) {
    if (ref && isImmutableRef(ref)) {
      console.log(chalk.dim(`Framework cached (immutable ref: ${ref}). Use --force to re-fetch.`));
      return;
    }
    // Branch or no ref — re-fetch
    console.log(chalk.dim(`Re-fetching framework (branch ref or unspecified)...`));
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  if (force && fs.existsSync(cacheDir)) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }

  console.log(`Fetching framework from ${source}${ref ? ` @ ${ref}` : ''}...`);

  if (type === 'command') {
    const command = framework.command || source;
    fetchFromCommand(command, ref, cacheDir);
  } else {
    await fetchFromForge(source, ref, cacheDir, workspaceRoot);
  }

  console.log(chalk.green('Framework cached successfully.'));
}

/**
 * Get the framework cache directory if it exists.
 * Returns null if no remote source is configured or cache doesn't exist.
 */
export function getFrameworkCacheDir(workspaceRoot: string): string | null {
  try {
    const config = loadConfig(workspaceRoot);
    const framework = config.framework;

    if (!framework?.source || framework.source === 'local') {
      return null;
    }

    const cacheDir = getCacheDir(framework.source, framework.ref);
    if (fs.existsSync(cacheDir)) {
      return cacheDir;
    }

    return null;
  } catch {
    return null;
  }
}
