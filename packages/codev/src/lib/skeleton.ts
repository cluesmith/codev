/**
 * Skeleton resolver - finds codev files with unified resolution
 *
 * Resolution order (first match wins):
 * 1. .codev/<path>              — user customization (optional overrides)
 * 2. codev/<path>               — project-level (legacy local copies)
 * 3. <cache>/<path>             — remote framework (fetched via forge)
 * 4. <package>/skeleton/<path>  — npm package defaults
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get path to embedded skeleton directory.
 * The skeleton is copied from codev-skeleton/ at build time.
 */
export function getSkeletonDir(): string {
  // In built package: dist/lib/skeleton.js
  // Skeleton is at: packages/codev/skeleton/
  // So: dist/lib -> ../../skeleton
  return path.resolve(__dirname, '../../skeleton');
}

/**
 * Find workspace root by looking for codev/ directory or .git
 */
export function findWorkspaceRoot(startDir?: string): string {
  let current = startDir || process.cwd();

  while (current !== path.dirname(current)) {
    // Check for codev/ directory
    if (fs.existsSync(path.join(current, 'codev'))) {
      return current;
    }
    // Check for .git as fallback
    if (fs.existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }

  return startDir || process.cwd();
}

/**
 * Resolve a codev file using the unified four-tier resolution chain.
 *
 * Resolution order (first match wins):
 * 1. .codev/<path>              — user customization
 * 2. codev/<path>               — project-level (legacy local copies)
 * 3. <cache>/<path>             — remote framework (fetched via codev sync)
 * 4. <package>/skeleton/<path>  — npm package defaults
 *
 * @param relativePath - Path relative to codev/ (e.g., 'roles/consultant.md')
 * @param workspaceRoot - Optional workspace root (auto-detected if not provided)
 * @returns Absolute path to the file, or null if not found
 */
export function resolveCodevFile(relativePath: string, workspaceRoot?: string): string | null {
  const root = workspaceRoot || findWorkspaceRoot();

  // 1. Check .codev/ directory first (user customization overrides)
  const overridePath = path.join(root, '.codev', relativePath);
  if (fs.existsSync(overridePath)) {
    return overridePath;
  }

  // 2. Check local codev/ directory (legacy local copies)
  const localPath = path.join(root, 'codev', relativePath);
  if (fs.existsSync(localPath)) {
    return localPath;
  }

  // 3. Check remote framework cache (fetched via codev sync)
  const cacheDir = _getFrameworkCacheDir(root);
  if (cacheDir) {
    const cachePath = path.join(cacheDir, relativePath);
    if (fs.existsSync(cachePath)) {
      return cachePath;
    }
  }

  // 4. Fall back to embedded skeleton (npm package defaults)
  const skeletonDir = getSkeletonDir();
  const embeddedPath = path.join(skeletonDir, relativePath);
  if (fs.existsSync(embeddedPath)) {
    return embeddedPath;
  }

  return null;
}

/**
 * Set the framework cache directory for the current process.
 * Called once during startup by commands that need remote framework resolution.
 */
let _frameworkCacheDir: string | null = null;

export function setFrameworkCacheDir(dir: string | null): void {
  _frameworkCacheDir = dir;
}

export function getFrameworkCacheDir(): string | null {
  return _frameworkCacheDir;
}

function _getFrameworkCacheDir(_workspaceRoot: string): string | null {
  return _frameworkCacheDir;
}

/**
 * Read a codev file, checking local first then embedded skeleton.
 *
 * @param relativePath - Path relative to codev/ (e.g., 'roles/consultant.md')
 * @param workspaceRoot - Optional workspace root (auto-detected if not provided)
 * @returns File contents, or null if not found
 */
export function readCodevFile(relativePath: string, workspaceRoot?: string): string | null {
  const filePath = resolveCodevFile(relativePath, workspaceRoot);
  if (!filePath) {
    return null;
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * Check if a file exists in local codev/ directory (not skeleton)
 */
export function hasLocalOverride(relativePath: string, workspaceRoot?: string): boolean {
  const root = workspaceRoot || findWorkspaceRoot();
  const localPath = path.join(root, 'codev', relativePath);
  return fs.existsSync(localPath);
}

/**
 * List all files in the skeleton directory matching a pattern
 */
export function listSkeletonFiles(subdir?: string): string[] {
  const skeletonDir = getSkeletonDir();
  const targetDir = subdir ? path.join(skeletonDir, subdir) : skeletonDir;

  if (!fs.existsSync(targetDir)) {
    return [];
  }

  const results: string[] = [];

  function walk(dir: string, prefix: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relativePath);
      } else {
        results.push(relativePath);
      }
    }
  }

  walk(targetDir, subdir || '');
  return results;
}
