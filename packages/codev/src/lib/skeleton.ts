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
 * Resolve `{{> <codev-relative-path>}}` include directives by reading the
 * referenced framework file fresh through the four-tier resolver and
 * substituting its content in place (recursively). This is how framework files
 * (a protocol's `protocol.md` at spawn, a phase's template in a porch prompt) are
 * delivered to the builder without committing a copy — the canonical file stays
 * single-source and is read at delivery time, so it cannot drift.
 *
 * An include that does not resolve collapses to '' (never an error — the file
 * genuinely isn't shipped). Depth-guarded against include cycles.
 */
export function resolveCodevIncludes(
  content: string,
  workspaceRoot?: string,
  depth = 0,
): string {
  if (depth > 5) return content; // cycle / runaway guard
  return content.replace(/\{\{>\s*([^}\s]+)\s*\}\}/g, (_match, relPath: string) => {
    const resolved = resolveCodevFile(relPath, workspaceRoot);
    if (!resolved) return '';
    return resolveCodevIncludes(fs.readFileSync(resolved, 'utf-8'), workspaceRoot, depth + 1);
  });
}

/**
 * Framework cache directory management.
 *
 * Uses lazy initialization: the cache dir is computed on first access
 * by reading the config to find framework.source and checking if a
 * cache exists. This avoids requiring explicit startup wiring.
 */
let _frameworkCacheDir: string | null | undefined;
let _frameworkCacheDirWorkspace: string | null = null;
let _frameworkCacheDirExplicit = false;

export function setFrameworkCacheDir(dir: string | null): void {
  _frameworkCacheDir = dir;
  _frameworkCacheDirExplicit = true;
}

export function getFrameworkCacheDir(): string | null {
  return _frameworkCacheDir ?? null;
}

function _getFrameworkCacheDir(workspaceRoot: string): string | null {
  // If explicitly set (by test or startup), use that
  if (_frameworkCacheDirExplicit) return _frameworkCacheDir ?? null;

  // Return cached result if we already computed for this workspace
  if (_frameworkCacheDir !== undefined && _frameworkCacheDirWorkspace === workspaceRoot) {
    return _frameworkCacheDir;
  }

  // Lazy init: try to compute the cache dir from config
  _frameworkCacheDirWorkspace = workspaceRoot;
  try {
    // Read config directly (minimal — just framework.source and framework.ref)
    const configPath = path.join(workspaceRoot, '.codev', 'config.json');
    if (!fs.existsSync(configPath)) {
      _frameworkCacheDir = null;
      return null;
    }
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const source = config?.framework?.source;
    if (!source || source === 'local') {
      _frameworkCacheDir = null;
      return null;
    }

    // Compute cache dir
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const { homedir } = require('node:os') as typeof import('node:os');
    const sourceHash = createHash('sha256').update(source).digest('hex').slice(0, 12);
    const ref = config?.framework?.ref || 'default';
    const cacheDir = path.join(homedir(), '.codev', 'cache', 'framework', sourceHash, ref);

    _frameworkCacheDir = fs.existsSync(cacheDir) ? cacheDir : null;
    return _frameworkCacheDir;
  } catch {
    _frameworkCacheDir = null;
    return null;
  }
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
/**
 * All directories that may contain protocols, in resolution order.
 *
 * NOTE: this includes the framework cache. `porch/protocol.ts`'s alias scan historically checked
 * only three tiers (omitting the cache) — that is a pre-existing inconsistency with
 * resolveCodevFile's four tiers, and is deliberately NOT reproduced here.
 */
function protocolDirs(workspaceRoot?: string): string[] {
  const root = workspaceRoot || findWorkspaceRoot();
  const dirs = [
    path.join(root, '.codev', 'protocols'),
    path.join(root, 'codev', 'protocols'),
  ];
  const cacheDir = _getFrameworkCacheDir(root);
  if (cacheDir) dirs.push(path.join(cacheDir, 'protocols'));
  dirs.push(path.join(getSkeletonDir(), 'protocols'));
  return dirs;
}

function readProtocolJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null; // unreadable or invalid JSON — not this function's error to raise
  }
}

/**
 * Every protocol name visible at ANY tier, plus any aliases those protocols declare.
 *
 * Union, not precedence: a name present at any tier is a name porch can run, so configuring it is
 * legitimate. Aliases are included because porch resolves by them (`spir`/`spider`,
 * `maintain`/`maint`, `pir`/`plan-implement-review`), so rejecting an alias would reject config the
 * CLI itself accepts.
 */
export function listProtocolNames(workspaceRoot?: string): Set<string> {
  const names = new Set<string>();
  for (const dir of protocolDirs(workspaceRoot)) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const jsonPath = path.join(dir, entry.name, 'protocol.json');
      if (!fs.existsSync(jsonPath)) continue;
      names.add(entry.name);
      const parsed = readProtocolJson(jsonPath);
      const alias = parsed?.alias;
      if (typeof alias === 'string' && alias.length > 0) names.add(alias);
    }
  }
  return names;
}

/**
 * Map a protocol name or alias to its canonical (directory) name.
 *
 * Returns the input unchanged when it is already canonical or cannot be resolved — callers use this
 * for identity comparison, so an unresolvable name simply compares equal only to itself.
 */
export function canonicalProtocolName(workspaceRoot: string | undefined, nameOrAlias: string): string {
  for (const dir of protocolDirs(workspaceRoot)) {
    if (!fs.existsSync(dir)) continue;
    // A directory of this name is already canonical.
    if (fs.existsSync(path.join(dir, nameOrAlias, 'protocol.json'))) return nameOrAlias;
  }
  for (const dir of protocolDirs(workspaceRoot)) {
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const jsonPath = path.join(dir, entry.name, 'protocol.json');
      if (!fs.existsSync(jsonPath)) continue;
      const parsed = readProtocolJson(jsonPath);
      if (parsed?.alias === nameOrAlias) return entry.name;
    }
  }
  return nameOrAlias;
}

/**
 * Every review type (`phases[].verify.type`) declared by the protocols available here.
 *
 * Unlike listProtocolNames, this reads the RESOLVED protocol.json per name (tier precedence via
 * resolveCodevFile) rather than unioning across tiers: only the file that will actually execute
 * defines which review types can occur, so a shadowed skeleton copy's types must not leak in.
 */
export function listReviewTypes(workspaceRoot?: string): Set<string> {
  const types = new Set<string>();
  for (const name of listProtocolNames(workspaceRoot)) {
    const resolved = resolveCodevFile(`protocols/${name}/protocol.json`, workspaceRoot);
    if (!resolved) continue; // alias entries have no directory of their own
    const parsed = readProtocolJson(resolved);
    const phases = parsed?.phases;
    if (!Array.isArray(phases)) continue;
    for (const phase of phases) {
      const verifyType = (phase as { verify?: { type?: unknown } })?.verify?.type;
      if (typeof verifyType === 'string' && verifyType.length > 0) types.add(verifyType);
    }
  }
  return types;
}

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
