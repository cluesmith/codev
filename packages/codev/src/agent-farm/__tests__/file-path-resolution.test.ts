/**
 * Unit tests for file path resolution logic (Spec 0101, Phase 2)
 *
 * Tests the path resolution patterns used in the POST /api/tabs/file endpoint
 * of tower-routes.ts.
 *
 * Note: Workspace containment checks were removed in bugfix #502 to allow
 * `af open` to work with files outside the workspace directory.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Replicates the path resolution logic from tower-routes.ts
 * for testability without starting a full tower server.
 */
function resolveFilePath(
  filePath: string,
  workspacePath: string,
  sessionCwd?: string,
): string {
  // Resolution: use session cwd for relative paths if provided
  let fullPath: string;
  if (path.isAbsolute(filePath)) {
    fullPath = filePath;
  } else if (sessionCwd) {
    fullPath = path.join(sessionCwd, filePath);
  } else {
    fullPath = path.join(workspacePath, filePath);
  }

  // Resolve symlinks for canonical path
  try {
    fullPath = fs.realpathSync(fullPath);
  } catch {
    try {
      fullPath = path.join(fs.realpathSync(path.dirname(fullPath)), path.basename(fullPath));
    } catch {
      fullPath = path.resolve(fullPath);
    }
  }

  return fullPath;
}

describe('File path resolution (Spec 0101)', () => {
  // Use a temp directory as a stand-in for workspace root
  const tmpBase = os.tmpdir();
  let workspacePath: string;

  // Create temp workspace structure before tests
  const setup = () => {
    workspacePath = fs.mkdtempSync(path.join(tmpBase, 'path-resolution-test-'));
    // Create some test files and dirs
    fs.mkdirSync(path.join(workspacePath, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(workspacePath, '.builders', '0099', 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'src', 'lib', 'foo.ts'), 'export default 1;');
    fs.writeFileSync(path.join(workspacePath, '.builders', '0099', 'src', 'bar.ts'), 'export default 2;');
  };

  setup();

  describe('relative path resolution', () => {
    it('resolves relative path using workspace root when no session cwd', () => {
      const result = resolveFilePath('src/lib/foo.ts', workspacePath);
      // realpathSync resolves the full canonical path
      expect(result).toBe(fs.realpathSync(path.join(workspacePath, 'src/lib/foo.ts')));
    });

    it('resolves relative path using session cwd when provided', () => {
      const sessionCwd = path.join(workspacePath, '.builders', '0099');
      const result = resolveFilePath('src/bar.ts', workspacePath, sessionCwd);
      expect(result).toBe(fs.realpathSync(path.join(sessionCwd, 'src/bar.ts')));
    });

    it('resolves absolute path directly (ignoring session cwd)', () => {
      const absPath = path.join(workspacePath, 'src', 'lib', 'foo.ts');
      const result = resolveFilePath(absPath, workspacePath, '/some/other/cwd');
      expect(result).toBe(fs.realpathSync(absPath));
    });
  });

  describe('paths outside workspace (bugfix #502)', () => {
    it('resolves absolute paths outside workspace without rejection', () => {
      // /etc/hosts exists on macOS/Linux — resolution should succeed
      const result = resolveFilePath('/etc/hosts', workspacePath);
      expect(result).toBe(fs.realpathSync('/etc/hosts'));
    });

    it('resolves relative path traversal to canonical path', () => {
      const result = resolveFilePath('../../etc/hosts', workspacePath);
      // Should resolve to a canonical path (not reject)
      expect(path.isAbsolute(result)).toBe(true);
    });
  });

  describe('non-existent files', () => {
    it('handles non-existent files via parent directory resolution', () => {
      const result = resolveFilePath('src/nonexistent.ts', workspacePath);
      // Parent dir (src/) exists, so realpathSync on parent works
      expect(result).toContain('nonexistent.ts');
    });
  });

  describe('symlink handling', () => {
    it('resolves symlinks for existing files', () => {
      const linkPath = path.join(workspacePath, 'src', 'link.ts');
      try {
        fs.symlinkSync(
          path.join(workspacePath, 'src', 'lib', 'foo.ts'),
          linkPath,
        );
        const result = resolveFilePath('src/link.ts', workspacePath);
        // Should resolve to the target, not the symlink
        expect(result).toBe(fs.realpathSync(path.join(workspacePath, 'src', 'lib', 'foo.ts')));
      } finally {
        try { fs.unlinkSync(linkPath); } catch { /* cleanup */ }
      }
    });

    it('resolves symlinks pointing outside workspace (bugfix #502)', () => {
      const linkPath = path.join(workspacePath, 'src', 'escape-link.ts');
      try {
        fs.symlinkSync('/etc/hosts', linkPath);
        const result = resolveFilePath('src/escape-link.ts', workspacePath);
        // Should resolve to the target without rejection
        expect(result).toBe(fs.realpathSync('/etc/hosts'));
      } finally {
        try { fs.unlinkSync(linkPath); } catch { /* cleanup */ }
      }
    });
  });
});
