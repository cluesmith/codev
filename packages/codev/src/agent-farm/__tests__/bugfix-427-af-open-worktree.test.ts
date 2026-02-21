/**
 * Regression test for bugfix #427: af open fails regularly — recent regression
 *
 * Root cause: When `af open` runs from a builder worktree, `findWorkspaceRoot()`
 * returns the worktree root (because it has its own `codev/` directory). But
 * Tower only knows about the main repo workspace. The API call targets a
 * non-existent workspace, causing 404 or 403 errors.
 *
 * Fix: In open.ts, detect worktree context via `getMainRepoFromWorktree()` and
 * fall back to the main repo path for the Tower API call.
 *
 * Additional fix: Standardize containment checks between GET /file and
 * POST /tabs/file routes to both use symlink-aware fs.realpathSync().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'node:path';

// ============================================================================
// Test 1: open.ts imports getMainRepoFromWorktree and uses it
// ============================================================================

describe('Bugfix #427: af open worktree fallback', () => {
  describe('source code contains the worktree fallback', () => {
    it('should import getMainRepoFromWorktree in open.ts', async () => {
      const { readFileSync } = await import('node:fs');
      const openSrc = readFileSync(
        resolve(import.meta.dirname, '../commands/open.ts'),
        'utf-8',
      );

      expect(openSrc).toContain('getMainRepoFromWorktree');
    });

    it('should use mainRepo fallback before calling Tower API', async () => {
      const { readFileSync } = await import('node:fs');
      const openSrc = readFileSync(
        resolve(import.meta.dirname, '../commands/open.ts'),
        'utf-8',
      );

      // The fix: detect worktree and fall back to main repo
      expect(openSrc).toContain('getMainRepoFromWorktree(config.workspaceRoot)');
      // Should use the resolved workspace path (not config.workspaceRoot directly)
      // for the Tower API call
      expect(openSrc).toMatch(/tryTowerApi\(client,\s*workspacePath/);
    });
  });

  describe('error logging includes HTTP status', () => {
    it('should log HTTP status code in Tower API errors', async () => {
      const { readFileSync } = await import('node:fs');
      const openSrc = readFileSync(
        resolve(import.meta.dirname, '../commands/open.ts'),
        'utf-8',
      );

      // The fix: include status code in error message
      expect(openSrc).toContain('HTTP ${result.status}');
      // Should also log workspace and file paths for debugging
      expect(openSrc).toContain("logger.kv('Workspace'");
      expect(openSrc).toContain("logger.kv('File'");
    });
  });
});

// ============================================================================
// Test 2: getMainRepoFromWorktree is exported
// ============================================================================

describe('Bugfix #427: getMainRepoFromWorktree export', () => {
  it('should be exported from config.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const configSrc = readFileSync(
      resolve(import.meta.dirname, '../utils/config.ts'),
      'utf-8',
    );

    // Must be exported (not just a local function)
    expect(configSrc).toMatch(/export\s+function\s+getMainRepoFromWorktree/);
  });
});

// ============================================================================
// Test 3: Consistent containment checks in tower-routes.ts
// ============================================================================

describe('Bugfix #427: GET /file route exists', () => {
  it('GET /file route handler is present', async () => {
    const { readFileSync } = await import('node:fs');
    const routesSrc = readFileSync(
      resolve(import.meta.dirname, '../servers/tower-routes.ts'),
      'utf-8',
    );

    // GET /file handler should still exist
    const getFileIdx = routesSrc.indexOf("subPath === 'file'");
    expect(getFileIdx).toBeGreaterThan(-1);

    // Containment check removed in bugfix #502 to allow files outside workspace
    const section = routesSrc.slice(getFileIdx, getFileIdx + 800);
    expect(section).not.toContain('Forbidden');
  });
});
