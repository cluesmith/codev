/**
 * Unit tests for file path resolution and containment logic (Spec 0101, Phase 2)
 *
 * Tests the path resolution and security containment patterns used in
 * the POST /api/tabs/file endpoint of tower-server.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Replicates the containment check logic from tower-server.ts
 * for testability without starting a full tower server.
 */
function resolveAndCheckContainment(
  filePath: string,
  workspacePath: string,
  sessionCwd?: string,
): { fullPath: string; contained: boolean } {
  // Resolution: use session cwd for relative paths if provided
  let fullPath: string;
  if (path.isAbsolute(filePath)) {
    fullPath = filePath;
  } else if (sessionCwd) {
    fullPath = path.join(sessionCwd, filePath);
  } else {
    fullPath = path.join(workspacePath, filePath);
  }

  // Symlink-aware containment check
  // For non-existent files, resolve the parent directory to handle
  // intermediate symlinks (e.g., /tmp -> /private/tmp on macOS).
  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(fullPath);
  } catch {
    try {
      resolvedPath = path.join(fs.realpathSync(path.dirname(fullPath)), path.basename(fullPath));
    } catch {
      resolvedPath = path.resolve(fullPath);
    }
  }

  let normalizedWorkspace: string;
  try {
    normalizedWorkspace = fs.realpathSync(workspacePath);
  } catch {
    normalizedWorkspace = path.resolve(workspacePath);
  }

  const contained = resolvedPath.startsWith(normalizedWorkspace + path.sep)
    || resolvedPath === normalizedWorkspace;

  return { fullPath, contained };
}

describe('File path resolution and containment (Spec 0101)', () => {
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
      const result = resolveAndCheckContainment('src/lib/foo.ts', workspacePath);
      expect(result.fullPath).toBe(path.join(workspacePath, 'src/lib/foo.ts'));
      expect(result.contained).toBe(true);
    });

    it('resolves relative path using session cwd when provided', () => {
      const sessionCwd = path.join(workspacePath, '.builders', '0099');
      const result = resolveAndCheckContainment('src/bar.ts', workspacePath, sessionCwd);
      expect(result.fullPath).toBe(path.join(sessionCwd, 'src/bar.ts'));
      expect(result.contained).toBe(true);
    });

    it('resolves absolute path directly (ignoring session cwd)', () => {
      const absPath = path.join(workspacePath, 'src', 'lib', 'foo.ts');
      const result = resolveAndCheckContainment(absPath, workspacePath, '/some/other/cwd');
      expect(result.fullPath).toBe(absPath);
      expect(result.contained).toBe(true);
    });
  });

  describe('containment check', () => {
    it('allows paths within workspace root', () => {
      const result = resolveAndCheckContainment('src/lib/foo.ts', workspacePath);
      expect(result.contained).toBe(true);
    });

    it('allows paths within .builders/ worktrees', () => {
      const result = resolveAndCheckContainment(
        '.builders/0099/src/bar.ts',
        workspacePath,
      );
      expect(result.contained).toBe(true);
    });

    it('allows builder worktree paths resolved via session cwd', () => {
      const sessionCwd = path.join(workspacePath, '.builders', '0099');
      const result = resolveAndCheckContainment('src/bar.ts', workspacePath, sessionCwd);
      expect(result.contained).toBe(true);
    });

    it('rejects path traversal escaping workspace (../../etc/passwd)', () => {
      const result = resolveAndCheckContainment('../../etc/passwd', workspacePath);
      expect(result.contained).toBe(false);
    });

    it('rejects path traversal from builder worktree', () => {
      const sessionCwd = path.join(workspacePath, '.builders', '0099');
      const result = resolveAndCheckContainment('../../../../etc/passwd', workspacePath, sessionCwd);
      expect(result.contained).toBe(false);
    });

    it('rejects absolute path outside workspace', () => {
      const result = resolveAndCheckContainment('/etc/passwd', workspacePath);
      expect(result.contained).toBe(false);
    });

    it('rejects path targeting ~/.ssh', () => {
      const result = resolveAndCheckContainment('../../.ssh/id_rsa', workspacePath);
      expect(result.contained).toBe(false);
    });
  });

  describe('non-existent files', () => {
    it('handles non-existent files via path.resolve fallback', () => {
      const result = resolveAndCheckContainment('src/nonexistent.ts', workspacePath);
      expect(result.fullPath).toBe(path.join(workspacePath, 'src/nonexistent.ts'));
      expect(result.contained).toBe(true);
    });

    it('non-existent file with traversal still fails containment', () => {
      const result = resolveAndCheckContainment('../../nonexistent.ts', workspacePath);
      expect(result.contained).toBe(false);
    });
  });

  describe('symlink handling', () => {
    it('resolves symlinks for existing files', () => {
      // Create a symlink within the workspace
      const linkPath = path.join(workspacePath, 'src', 'link.ts');
      try {
        fs.symlinkSync(
          path.join(workspacePath, 'src', 'lib', 'foo.ts'),
          linkPath,
        );
        const result = resolveAndCheckContainment('src/link.ts', workspacePath);
        expect(result.contained).toBe(true);
      } finally {
        try { fs.unlinkSync(linkPath); } catch { /* cleanup */ }
      }
    });

    it('rejects symlinks pointing outside workspace', () => {
      const linkPath = path.join(workspacePath, 'src', 'escape-link.ts');
      try {
        fs.symlinkSync('/etc/hosts', linkPath);
        const result = resolveAndCheckContainment('src/escape-link.ts', workspacePath);
        expect(result.contained).toBe(false);
      } finally {
        try { fs.unlinkSync(linkPath); } catch { /* cleanup */ }
      }
    });
  });
});
