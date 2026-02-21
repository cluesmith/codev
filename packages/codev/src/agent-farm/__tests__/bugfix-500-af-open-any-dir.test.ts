/**
 * Regression test for bugfix #500: af open should work from any directory
 *
 * Root cause: `open.ts` used `getConfig().workspaceRoot` which derives the
 * workspace root from `process.cwd()`. When CWD is outside the workspace
 * (or in a different subdirectory), the wrong workspace path is sent to
 * the Tower API, causing the open to fail.
 *
 * Fix: Derive workspace root from the FILE's directory (via findWorkspaceRoot)
 * instead of CWD. The file itself determines which workspace it belongs to.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

describe('Bugfix #500: af open works from any directory', () => {
  const openSrc = readFileSync(
    resolve(import.meta.dirname, '../commands/open.ts'),
    'utf-8',
  );

  it('should use findWorkspaceRoot from file directory, not getConfig', () => {
    // The fix: workspace root is derived from the file's location
    expect(openSrc).toContain('findWorkspaceRoot(dirname(filePath))');
    // Should NOT use getConfig() — that uses CWD which is the wrong approach
    expect(openSrc).not.toContain('getConfig()');
  });

  it('should import findWorkspaceRoot and dirname', () => {
    expect(openSrc).toContain('findWorkspaceRoot');
    expect(openSrc).toContain('dirname');
  });

  it('should still support worktree fallback to main repo', () => {
    // Bugfix #427's worktree fallback must be preserved
    expect(openSrc).toContain('getMainRepoFromWorktree(workspacePath)');
  });
});

describe('Bugfix #500: findWorkspaceRoot is properly exported', () => {
  it('should be exported from config.ts', () => {
    const configSrc = readFileSync(
      resolve(import.meta.dirname, '../utils/config.ts'),
      'utf-8',
    );

    // Must be exported (not just a local function or test-only export)
    expect(configSrc).toMatch(/export\s*\{[^}]*findWorkspaceRoot[^}]*\}/);
  });
});
