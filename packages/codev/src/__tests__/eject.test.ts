/**
 * Tests for codev eject command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

// Mock chalk for cleaner test output
vi.mock('chalk', () => ({
  default: {
    bold: (s: string) => s,
    green: Object.assign((s: string) => s, { bold: (s: string) => s }),
    yellow: (s: string) => s,
    red: (s: string) => s,
    blue: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
  },
}));

describe('eject command', () => {
  const testBaseDir = path.join(tmpdir(), `codev-eject-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testBaseDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
  });

  describe('eject function', () => {
    it('should list available files with --list', async () => {
      const { eject } = await import('../commands/eject.js');

      // Create a codev directory so findProjectRoot works
      fs.mkdirSync(path.join(testBaseDir, 'codev'), { recursive: true });

      const originalCwd = process.cwd();
      process.chdir(testBaseDir);

      try {
        await eject(undefined, { list: true });
        // Should complete without error
        expect(console.log).toHaveBeenCalled();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should show list when no path provided', async () => {
      const { eject } = await import('../commands/eject.js');

      fs.mkdirSync(path.join(testBaseDir, 'codev'), { recursive: true });

      const originalCwd = process.cwd();
      process.chdir(testBaseDir);

      try {
        await eject(undefined, {});
        // Should show list without error
        expect(console.log).toHaveBeenCalled();
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should error on non-existent path', async () => {
      const { eject } = await import('../commands/eject.js');

      fs.mkdirSync(path.join(testBaseDir, 'codev'), { recursive: true });

      const originalCwd = process.cwd();
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      process.chdir(testBaseDir);

      try {
        await expect(eject('nonexistent/path', {})).rejects.toThrow('exit');
        expect(console.error).toHaveBeenCalled();
      } finally {
        process.chdir(originalCwd);
        mockExit.mockRestore();
      }
    });

    it('should refuse to overwrite existing file without --force', async () => {
      const { eject } = await import('../commands/eject.js');
      const { getSkeletonDir } = await import('../lib/skeleton.js');

      // Create codev directory with an existing file
      const codevDir = path.join(testBaseDir, 'codev', 'roles');
      fs.mkdirSync(codevDir, { recursive: true });

      const skeletonDir = getSkeletonDir();
      const consultantPath = path.join(skeletonDir, 'roles', 'consultant.md');

      // Only run this test if the skeleton has consultant.md
      if (!fs.existsSync(consultantPath)) {
        return;
      }

      // Create existing local file
      fs.writeFileSync(path.join(codevDir, 'consultant.md'), 'local content');

      const originalCwd = process.cwd();
      const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      process.chdir(testBaseDir);

      try {
        await expect(eject('roles/consultant.md', {})).rejects.toThrow('exit');
        // Should have warned about existing file
        expect(console.error).toHaveBeenCalled();
      } finally {
        process.chdir(originalCwd);
        mockExit.mockRestore();
      }
    });

    it('should overwrite with --force', async () => {
      const { eject } = await import('../commands/eject.js');
      const { getSkeletonDir } = await import('../lib/skeleton.js');

      const codevDir = path.join(testBaseDir, 'codev', 'roles');
      fs.mkdirSync(codevDir, { recursive: true });

      const skeletonDir = getSkeletonDir();
      const consultantPath = path.join(skeletonDir, 'roles', 'consultant.md');

      // Only run this test if the skeleton has consultant.md
      if (!fs.existsSync(consultantPath)) {
        return;
      }

      // Create existing local file
      const localPath = path.join(codevDir, 'consultant.md');
      fs.writeFileSync(localPath, 'local content');

      const originalCwd = process.cwd();
      process.chdir(testBaseDir);

      try {
        await eject('roles/consultant.md', { force: true });
        // File should now have skeleton content, not "local content"
        const content = fs.readFileSync(localPath, 'utf-8');
        expect(content).not.toBe('local content');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should create parent directories as needed', async () => {
      const { eject } = await import('../commands/eject.js');
      const { getSkeletonDir } = await import('../lib/skeleton.js');

      // Just create codev dir, not the roles subdir
      fs.mkdirSync(path.join(testBaseDir, 'codev'), { recursive: true });

      const skeletonDir = getSkeletonDir();
      const consultantPath = path.join(skeletonDir, 'roles', 'consultant.md');

      // Only run this test if the skeleton has consultant.md
      if (!fs.existsSync(consultantPath)) {
        return;
      }

      const originalCwd = process.cwd();
      process.chdir(testBaseDir);

      try {
        await eject('roles/consultant.md', {});
        // Parent directory should have been created
        expect(fs.existsSync(path.join(testBaseDir, 'codev', 'roles', 'consultant.md'))).toBe(true);
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
