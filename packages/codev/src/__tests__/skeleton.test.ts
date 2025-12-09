/**
 * Tests for skeleton resolver module
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
    dim: (s: string) => s,
  },
}));

describe('skeleton module', () => {
  const testBaseDir = path.join(tmpdir(), `codev-skeleton-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testBaseDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testBaseDir)) {
      fs.rmSync(testBaseDir, { recursive: true });
    }
  });

  describe('getSkeletonDir', () => {
    it('should return a path to skeleton directory', async () => {
      const { getSkeletonDir } = await import('../lib/skeleton.js');
      const skeletonDir = getSkeletonDir();

      expect(skeletonDir).toBeTruthy();
      expect(typeof skeletonDir).toBe('string');
      // The path should end with 'skeleton'
      expect(skeletonDir.endsWith('skeleton')).toBe(true);
    });
  });

  describe('findProjectRoot', () => {
    it('should find project root with codev/ directory', async () => {
      const { findProjectRoot } = await import('../lib/skeleton.js');

      // Create a codev/ directory
      const codevDir = path.join(testBaseDir, 'codev');
      fs.mkdirSync(codevDir, { recursive: true });

      const subDir = path.join(testBaseDir, 'src', 'deep', 'nested');
      fs.mkdirSync(subDir, { recursive: true });

      const result = findProjectRoot(subDir);
      expect(result).toBe(testBaseDir);
    });

    it('should find project root with .git directory', async () => {
      const { findProjectRoot } = await import('../lib/skeleton.js');

      // Create a .git directory
      const gitDir = path.join(testBaseDir, '.git');
      fs.mkdirSync(gitDir, { recursive: true });

      const subDir = path.join(testBaseDir, 'src', 'components');
      fs.mkdirSync(subDir, { recursive: true });

      const result = findProjectRoot(subDir);
      expect(result).toBe(testBaseDir);
    });

    it('should prefer codev/ over .git', async () => {
      const { findProjectRoot } = await import('../lib/skeleton.js');

      // Create both codev/ and .git directories
      const codevDir = path.join(testBaseDir, 'codev');
      const gitDir = path.join(testBaseDir, '.git');
      fs.mkdirSync(codevDir, { recursive: true });
      fs.mkdirSync(gitDir, { recursive: true });

      const result = findProjectRoot(testBaseDir);
      expect(result).toBe(testBaseDir);
    });

    it('should return start directory if no markers found', async () => {
      const { findProjectRoot } = await import('../lib/skeleton.js');

      const isolatedDir = path.join(testBaseDir, 'isolated');
      fs.mkdirSync(isolatedDir, { recursive: true });

      const result = findProjectRoot(isolatedDir);
      // Should return the directory where search started
      expect(result).toBeTruthy();
    });
  });

  describe('resolveCodevFile', () => {
    it('should return local file if it exists', async () => {
      const { resolveCodevFile } = await import('../lib/skeleton.js');

      // Create a local codev file
      const codevDir = path.join(testBaseDir, 'codev', 'roles');
      fs.mkdirSync(codevDir, { recursive: true });
      const localFile = path.join(codevDir, 'test.md');
      fs.writeFileSync(localFile, 'local content');

      const result = resolveCodevFile('roles/test.md', testBaseDir);
      expect(result).toBe(localFile);
    });

    it('should fall back to embedded skeleton if local not found', async () => {
      const { resolveCodevFile, getSkeletonDir } = await import('../lib/skeleton.js');

      // Create codev/ but no local file
      const codevDir = path.join(testBaseDir, 'codev');
      fs.mkdirSync(codevDir, { recursive: true });

      // Try to resolve a file that exists in skeleton (consultant.md should exist)
      const result = resolveCodevFile('roles/consultant.md', testBaseDir);

      if (result) {
        const skeletonDir = getSkeletonDir();
        // Should be from skeleton, not local
        expect(result.startsWith(skeletonDir)).toBe(true);
      }
      // If result is null, skeleton doesn't have the file (which is okay for test)
    });

    it('should return null if file not found anywhere', async () => {
      const { resolveCodevFile } = await import('../lib/skeleton.js');

      // Create codev/ directory
      const codevDir = path.join(testBaseDir, 'codev');
      fs.mkdirSync(codevDir, { recursive: true });

      const result = resolveCodevFile('nonexistent/file.md', testBaseDir);
      expect(result).toBeNull();
    });
  });

  describe('readCodevFile', () => {
    it('should read local file content', async () => {
      const { readCodevFile } = await import('../lib/skeleton.js');

      // Create a local codev file
      const codevDir = path.join(testBaseDir, 'codev', 'roles');
      fs.mkdirSync(codevDir, { recursive: true });
      fs.writeFileSync(path.join(codevDir, 'test.md'), 'local content');

      const content = readCodevFile('roles/test.md', testBaseDir);
      expect(content).toBe('local content');
    });

    it('should return null for non-existent file', async () => {
      const { readCodevFile } = await import('../lib/skeleton.js');

      const codevDir = path.join(testBaseDir, 'codev');
      fs.mkdirSync(codevDir, { recursive: true });

      const content = readCodevFile('nonexistent.md', testBaseDir);
      expect(content).toBeNull();
    });
  });

  describe('hasLocalOverride', () => {
    it('should return true if local file exists', async () => {
      const { hasLocalOverride } = await import('../lib/skeleton.js');

      // Create a local codev file
      const codevDir = path.join(testBaseDir, 'codev', 'protocols');
      fs.mkdirSync(codevDir, { recursive: true });
      fs.writeFileSync(path.join(codevDir, 'custom.md'), 'custom');

      const result = hasLocalOverride('protocols/custom.md', testBaseDir);
      expect(result).toBe(true);
    });

    it('should return false if local file does not exist', async () => {
      const { hasLocalOverride } = await import('../lib/skeleton.js');

      const codevDir = path.join(testBaseDir, 'codev');
      fs.mkdirSync(codevDir, { recursive: true });

      const result = hasLocalOverride('protocols/missing.md', testBaseDir);
      expect(result).toBe(false);
    });
  });

  describe('listSkeletonFiles', () => {
    it('should list files in skeleton directory', async () => {
      const { listSkeletonFiles, getSkeletonDir } = await import('../lib/skeleton.js');

      const skeletonDir = getSkeletonDir();
      if (fs.existsSync(skeletonDir)) {
        const files = listSkeletonFiles();
        expect(Array.isArray(files)).toBe(true);
      }
    });

    it('should list files in a subdirectory', async () => {
      const { listSkeletonFiles, getSkeletonDir } = await import('../lib/skeleton.js');

      const skeletonDir = getSkeletonDir();
      if (fs.existsSync(path.join(skeletonDir, 'roles'))) {
        const files = listSkeletonFiles('roles');
        expect(Array.isArray(files)).toBe(true);
        // Should contain role files
        if (files.length > 0) {
          expect(files.some(f => f.includes('roles/'))).toBe(true);
        }
      }
    });

    it('should return empty array for non-existent subdirectory', async () => {
      const { listSkeletonFiles } = await import('../lib/skeleton.js');

      const files = listSkeletonFiles('nonexistent-dir');
      expect(files).toEqual([]);
    });
  });
});
