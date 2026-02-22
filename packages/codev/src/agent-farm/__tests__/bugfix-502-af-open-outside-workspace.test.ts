/**
 * Regression test for bugfix #502: af open blocks files outside workspace directory
 *
 * Root cause: The POST /api/tabs/file handler in tower-routes.ts had a workspace
 * containment check that rejected any file path not under the workspace root with
 * HTTP 403 "Path outside workspace". The GET /file handler had a similar check.
 *
 * Fix: Removed the workspace containment checks from both handlers. Tower runs
 * on localhost only — there's no security reason to restrict file access to the
 * workspace. Users need to open files from anywhere (e.g., files in other repos,
 * system configs for reference, etc.).
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

describe('Bugfix #502: af open allows files outside workspace', () => {
  const routesSrc = readFileSync(
    resolve(import.meta.dirname, '../servers/tower-routes.ts'),
    'utf-8',
  );

  describe('POST /api/tabs/file handler', () => {
    // Find the function definition (async function handleWorkspaceFileTabCreate)
    const fnDefIdx = routesSrc.indexOf('async function handleWorkspaceFileTabCreate');

    it('should NOT have workspace containment check', () => {
      expect(fnDefIdx).toBeGreaterThan(-1);

      // Extract the function body (up to ~2000 chars covers it)
      const fnSection = routesSrc.slice(fnDefIdx, fnDefIdx + 2000);

      // Must not reject with "Path outside workspace"
      expect(fnSection).not.toContain("'Path outside workspace'");
      expect(fnSection).not.toContain('isWithinWorkspace');
    });

    it('should still resolve symlinks for canonical paths', () => {
      expect(fnDefIdx).toBeGreaterThan(-1);
      const fnSection = routesSrc.slice(fnDefIdx, fnDefIdx + 2000);

      // Symlink resolution should still be present
      expect(fnSection).toContain('realpathSync');
    });
  });

  describe('GET /file handler', () => {
    it('should NOT have workspace containment check', () => {
      // Find the GET /file handler
      const getFileIdx = routesSrc.indexOf("subPath === 'file'");
      expect(getFileIdx).toBeGreaterThan(-1);

      const section = routesSrc.slice(getFileIdx, getFileIdx + 500);

      // Must not have the old containment rejection
      expect(section).not.toContain('Forbidden');
      expect(section).not.toContain('403');
    });
  });
});
