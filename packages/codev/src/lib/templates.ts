/**
 * Template handling utilities for codev init/adopt/update
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get the path to the embedded skeleton directory
 * (contains protocols, roles, agents - the codev framework files)
 */
export function getTemplatesDir(): string {
  // In development: packages/codev/skeleton
  // In installed: node_modules/@cluesmith/codev/skeleton
  const skeletonDir = path.resolve(__dirname, '../../skeleton');
  if (fs.existsSync(skeletonDir)) {
    return skeletonDir;
  }

  // Fallback: check dist location
  const distSkeletonDir = path.resolve(__dirname, '../../../skeleton');
  if (fs.existsSync(distSkeletonDir)) {
    return distSkeletonDir;
  }

  throw new Error('Skeleton directory not found. Package may be corrupted.');
}

/**
 * Get SHA256 hash of a file
 */
export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Get the path to the hash store file
 */
export function getHashStorePath(targetDir: string): string {
  return path.join(targetDir, 'codev', '.update-hashes.json');
}

/**
 * Load stored hashes for update tracking
 */
export function loadHashStore(targetDir: string): Record<string, string> {
  const hashStorePath = getHashStorePath(targetDir);
  if (fs.existsSync(hashStorePath)) {
    try {
      return JSON.parse(fs.readFileSync(hashStorePath, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Save hash store
 */
export function saveHashStore(targetDir: string, hashes: Record<string, string>): void {
  const hashStorePath = getHashStorePath(targetDir);
  const dir = path.dirname(hashStorePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(hashStorePath, JSON.stringify(hashes, null, 2));
}

/**
 * List of files that should never be copied/updated (user data)
 */
export const USER_DATA_PATTERNS = [
  'specs/',
  'plans/',
  'reviews/',
  'resources/arch.md',
  'resources/lessons-learned.md',
  // Hot-tier files are per-project-curated once materialized (Spec 987) — never overwrite.
  'resources/arch-critical.md',
  'resources/lessons-critical.md',
  '.update-hashes.json',
];

/**
 * Check if a file path matches user data patterns
 */
export function isUserDataPath(relativePath: string): boolean {
  return USER_DATA_PATTERNS.some(pattern =>
    relativePath.startsWith(pattern) || relativePath.includes(`/${pattern}`)
  );
}

/**
 * Validate that a relative path is safe (no directory traversal)
 * Returns true if path is safe, false if it contains traversal attempts
 */
export function isValidRelativePath(relativePath: string): boolean {
  // Normalize the path to resolve any . or .. components
  const normalized = path.normalize(relativePath);

  // Check for directory traversal patterns
  if (normalized.startsWith('..') || normalized.includes('../') || normalized.includes('..\\')) {
    return false;
  }

  // Check for absolute paths
  if (path.isAbsolute(normalized)) {
    return false;
  }

  // Ensure the normalized path doesn't escape the base directory
  // by checking it doesn't start with a path separator after normalization
  if (normalized.startsWith(path.sep) || normalized.startsWith('/')) {
    return false;
  }

  return true;
}

/**
 * Recursively copy template files to target directory
 */
export function copyTemplateDir(
  srcDir: string,
  targetDir: string,
  options: {
    skipExisting?: boolean;
    hashes?: Record<string, string>;
    onFile?: (relativePath: string, action: 'copy' | 'skip' | 'conflict') => void;
  } = {}
): void {
  const { skipExisting = false, hashes = {}, onFile } = options;

  function copyRecursive(src: string, dest: string, relativeBase: string): void {
    const stat = fs.statSync(src);

    if (stat.isDirectory()) {
      if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
      }

      const entries = fs.readdirSync(src);
      for (const entry of entries) {
        const srcPath = path.join(src, entry);
        const destPath = path.join(dest, entry);
        const relativePath = path.join(relativeBase, entry);

        // Validate relative path to prevent directory traversal
        if (!isValidRelativePath(relativePath)) {
          console.warn(`Skipping unsafe path: ${relativePath}`);
          continue;
        }

        copyRecursive(srcPath, destPath, relativePath);
      }
    } else {
      const relativePath = relativeBase;

      // Validate relative path to prevent directory traversal
      if (!isValidRelativePath(relativePath)) {
        console.warn(`Skipping unsafe path: ${relativePath}`);
        return;
      }

      // Skip user data files
      if (isUserDataPath(relativePath)) {
        onFile?.(relativePath, 'skip');
        return;
      }

      // Skip .gitkeep files (they just preserve empty dirs in git)
      if (path.basename(src) === '.gitkeep') {
        return;
      }

      if (fs.existsSync(dest)) {
        if (skipExisting) {
          onFile?.(relativePath, 'skip');
          return;
        }
        // File exists - this is a potential conflict
        onFile?.(relativePath, 'conflict');
        return;
      }

      // Copy the file
      fs.copyFileSync(src, dest);

      // Store hash for future updates
      if (hashes) {
        hashes[relativePath] = hashFile(dest);
      }

      onFile?.(relativePath, 'copy');
    }
  }

  copyRecursive(srcDir, targetDir, '');
}

/**
 * Get list of all template files (relative paths)
 */
export function getTemplateFiles(templatesDir: string): string[] {
  const files: string[] = [];

  function walk(dir: string, relativeBase: string): void {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const relativePath = path.join(relativeBase, entry);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath, relativePath);
      } else {
        // Skip .gitkeep
        if (entry !== '.gitkeep') {
          files.push(relativePath);
        }
      }
    }
  }

  walk(templatesDir, '');
  return files;
}

/**
 * Files that should be updatable (protocols, roles, agents)
 */
export const UPDATABLE_PREFIXES = [
  'protocols/',
  'roles/',
  'agents/',
  'bin/',
  'templates/',
  'resources/commands/',
  'resources/workflow-reference.md',
  // Note: config.json is intentionally NOT here - it's user configuration
];

/**
 * Check if a file is updatable (not user data)
 */
export function isUpdatableFile(relativePath: string): boolean {
  return UPDATABLE_PREFIXES.some(prefix => relativePath.startsWith(prefix));
}
