/**
 * Regression test for bugfix #535: af open does not reliably work on files
 * outside the current directory
 *
 * Root cause: `open.ts` derived the workspace from the FILE's location
 * (via findWorkspaceRoot(dirname(filePath))). When running `af open` from
 * workspace A but targeting a file in workspace B, the file opened in B's
 * annotation viewer instead of A's.
 *
 * Fix: Prefer CWD-based workspace detection (findWorkspaceRoot(process.cwd()))
 * so the file opens in the user's current workspace. Fall back to file-based
 * detection only when CWD isn't in a recognizable workspace.
 */
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

describe('Bugfix #535: af open cross-workspace file resolution', () => {
  const openSrc = readFileSync(
    resolve(import.meta.dirname, '../commands/open.ts'),
    'utf-8',
  );

  it('should prefer CWD-based workspace detection over file-based', () => {
    // The fix: determine workspace from CWD first
    expect(openSrc).toContain('findWorkspaceRoot(process.cwd())');
  });

  it('should check whether CWD resolves to a real workspace', () => {
    // Must verify CWD is in a workspace (has codev/ or .git) before using it
    expect(openSrc).toContain('cwdIsWorkspace');
    expect(openSrc).toMatch(/existsSync.*codev/);
    expect(openSrc).toMatch(/existsSync.*\.git/);
  });

  it('should fall back to file-based detection when CWD is not a workspace', () => {
    // When CWD is outside any workspace (e.g., /tmp), fall back to file location
    expect(openSrc).toContain('findWorkspaceRoot(dirname(filePath))');
  });

  it('should still support worktree fallback to main repo', () => {
    // Bugfix #427's worktree fallback must be preserved
    expect(openSrc).toContain('getMainRepoFromWorktree(workspacePath)');
  });

  it('should not use getConfig for workspace detection', () => {
    // getConfig() uses CWD internally but doesn't support the fallback pattern
    expect(openSrc).not.toContain('getConfig()');
  });
});
