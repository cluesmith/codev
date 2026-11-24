/**
 * The keep list (#1950) as pure definitions, shared by `afx cleanup --keep-ignored`
 * (`keep-files.ts`, which does the copying) and `codev check worktree` (Spec 1951, which only
 * reports). One source of truth, so the two agree on what is kept.
 *
 * Kept: ignored files matching `cleanup.keepIgnored` (default below). Never kept, whatever the
 * list says: any path with a dependency- or build-output segment.
 */

export const DEFAULT_KEEP_IGNORED: readonly string[] = [
  'codev/projects/**',
  'codev/state/**',
  '.builder-*',
  'tmp/**',
  'scratch/**',
];

/** Path segments that mark dependency or build output. */
const NEVER_KEEP = new Set([
  'node_modules', 'bower_components', 'dist', 'build', 'target', '.next', '.nuxt', '.turbo',
  '.parcel-cache', '.gradle', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox',
]);

/** Whether a worktree-relative, `/`-separated path is dependency or build output, and so never kept. */
export function isNeverKeep(path: string): boolean {
  return path.split('/').some((segment) => NEVER_KEEP.has(segment));
}

/** Validate a `cleanup.keepIgnored` value from config; undefined means the default list. */
export function keepPatterns(configured: unknown): readonly string[] {
  if (configured === undefined) return DEFAULT_KEEP_IGNORED;
  if (!Array.isArray(configured) || configured.some((p) => typeof p !== 'string' || p.trim() === '')) {
    throw new Error('cleanup.keepIgnored in .codev/config.json must be an array of non-empty glob strings');
  }
  return configured;
}
