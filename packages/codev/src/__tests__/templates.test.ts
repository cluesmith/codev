/**
 * Tests for template utilities
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  hashFile,
  loadHashStore,
  saveHashStore,
  isUserDataPath,
  isUpdatableFile,
  isValidRelativePath,
  copyTemplateDir,
  getTemplateFiles,
} from '../lib/templates.js';

describe('template utilities', () => {
  const testDir = path.join(tmpdir(), `codev-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  describe('hashFile', () => {
    it('should return consistent hash for same content', () => {
      const filePath = path.join(testDir, 'test.txt');
      fs.writeFileSync(filePath, 'hello world');

      const hash1 = hashFile(filePath);
      const hash2 = hashFile(filePath);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex string
    });

    it('should return different hash for different content', () => {
      const file1 = path.join(testDir, 'file1.txt');
      const file2 = path.join(testDir, 'file2.txt');

      fs.writeFileSync(file1, 'content 1');
      fs.writeFileSync(file2, 'content 2');

      const hash1 = hashFile(file1);
      const hash2 = hashFile(file2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('loadHashStore', () => {
    it('should return empty object when no hash store exists', () => {
      const hashes = loadHashStore(testDir);
      expect(hashes).toEqual({});
    });

    it('should load existing hash store', () => {
      const codevDir = path.join(testDir, 'codev');
      fs.mkdirSync(codevDir, { recursive: true });

      const expectedHashes = { 'file1.txt': 'abc123', 'file2.txt': 'def456' };
      fs.writeFileSync(
        path.join(codevDir, '.update-hashes.json'),
        JSON.stringify(expectedHashes)
      );

      const hashes = loadHashStore(testDir);
      expect(hashes).toEqual(expectedHashes);
    });

    it('should return empty object for corrupted JSON', () => {
      const codevDir = path.join(testDir, 'codev');
      fs.mkdirSync(codevDir, { recursive: true });
      fs.writeFileSync(path.join(codevDir, '.update-hashes.json'), 'not valid json');

      const hashes = loadHashStore(testDir);
      expect(hashes).toEqual({});
    });
  });

  describe('saveHashStore', () => {
    it('should create codev directory and save hashes', () => {
      const hashes = { 'protocols/spider/protocol.md': 'hash123' };
      saveHashStore(testDir, hashes);

      const savedPath = path.join(testDir, 'codev', '.update-hashes.json');
      expect(fs.existsSync(savedPath)).toBe(true);

      const saved = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
      expect(saved).toEqual(hashes);
    });
  });

  describe('isUserDataPath', () => {
    it('should identify user data paths', () => {
      expect(isUserDataPath('specs/0001-feature.md')).toBe(true);
      expect(isUserDataPath('plans/0001-feature.md')).toBe(true);
      expect(isUserDataPath('reviews/0001-feature.md')).toBe(true);
      expect(isUserDataPath('resources/arch.md')).toBe(true);
      expect(isUserDataPath('.update-hashes.json')).toBe(true);
    });

    it('should not match non-user data paths', () => {
      expect(isUserDataPath('protocols/spider/protocol.md')).toBe(false);
      expect(isUserDataPath('roles/architect.md')).toBe(false);
      expect(isUserDataPath('agents/builder.md')).toBe(false);
      expect(isUserDataPath('resources/commands/codev.md')).toBe(false);
      expect(isUserDataPath('resources/workflow-reference.md')).toBe(false);
      expect(isUserDataPath('config.json')).toBe(false);
    });
  });

  describe('isUpdatableFile', () => {
    it('should identify updatable files', () => {
      expect(isUpdatableFile('protocols/spider/protocol.md')).toBe(true);
      expect(isUpdatableFile('roles/architect.md')).toBe(true);
      expect(isUpdatableFile('agents/builder.md')).toBe(true);
      expect(isUpdatableFile('bin/agent-farm')).toBe(true);
      expect(isUpdatableFile('templates/dashboard.html')).toBe(true);
    });

    it('should not match non-updatable files', () => {
      expect(isUpdatableFile('specs/0001-feature.md')).toBe(false);
      expect(isUpdatableFile('plans/0001-feature.md')).toBe(false);
    });

    it('should NOT match config.json as updatable (user configuration)', () => {
      expect(isUpdatableFile('config.json')).toBe(false);
    });

    it('should match resources/commands as updatable', () => {
      expect(isUpdatableFile('resources/commands/codev.md')).toBe(true);
      expect(isUpdatableFile('resources/workflow-reference.md')).toBe(true);
    });
  });

  describe('copyTemplateDir', () => {
    it('should copy files and record hashes', () => {
      // Create source structure
      const srcDir = path.join(testDir, 'src');
      const destDir = path.join(testDir, 'dest');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'file1.txt'), 'content 1');

      const hashes: Record<string, string> = {};
      const copied: string[] = [];

      copyTemplateDir(srcDir, destDir, {
        hashes,
        onFile: (relativePath, action) => {
          if (action === 'copy') copied.push(relativePath);
        },
      });

      expect(fs.existsSync(path.join(destDir, 'file1.txt'))).toBe(true);
      expect(copied).toContain('file1.txt');
      expect(hashes['file1.txt']).toBeDefined();
    });

    it('should skip existing files when skipExisting is true', () => {
      const srcDir = path.join(testDir, 'src');
      const destDir = path.join(testDir, 'dest');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.mkdirSync(destDir, { recursive: true });

      fs.writeFileSync(path.join(srcDir, 'file1.txt'), 'new content');
      fs.writeFileSync(path.join(destDir, 'file1.txt'), 'old content');

      const skipped: string[] = [];
      copyTemplateDir(srcDir, destDir, {
        skipExisting: true,
        onFile: (relativePath, action) => {
          if (action === 'skip') skipped.push(relativePath);
        },
      });

      expect(skipped).toContain('file1.txt');
      expect(fs.readFileSync(path.join(destDir, 'file1.txt'), 'utf-8')).toBe('old content');
    });

    it('should handle nested directories', () => {
      const srcDir = path.join(testDir, 'src');
      const destDir = path.join(testDir, 'dest');
      fs.mkdirSync(path.join(srcDir, 'sub', 'deep'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'sub', 'deep', 'file.txt'), 'deep content');

      copyTemplateDir(srcDir, destDir, {});

      expect(fs.existsSync(path.join(destDir, 'sub', 'deep', 'file.txt'))).toBe(true);
    });

    it('should skip user data paths', () => {
      const srcDir = path.join(testDir, 'src');
      const destDir = path.join(testDir, 'dest');
      fs.mkdirSync(path.join(srcDir, 'specs'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'specs', 'test.md'), 'user data');

      const skipped: string[] = [];
      copyTemplateDir(srcDir, destDir, {
        onFile: (relativePath, action) => {
          if (action === 'skip') skipped.push(relativePath);
        },
      });

      expect(skipped).toContain(path.join('specs', 'test.md'));
      expect(fs.existsSync(path.join(destDir, 'specs', 'test.md'))).toBe(false);
    });
  });

  describe('getTemplateFiles', () => {
    it('should list all files recursively', () => {
      const srcDir = path.join(testDir, 'templates');
      fs.mkdirSync(path.join(srcDir, 'protocols'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'root.txt'), 'root');
      fs.writeFileSync(path.join(srcDir, 'protocols', 'spider.md'), 'spider');

      const files = getTemplateFiles(srcDir);

      expect(files).toContain('root.txt');
      expect(files).toContain(path.join('protocols', 'spider.md'));
    });

    it('should exclude .gitkeep files', () => {
      const srcDir = path.join(testDir, 'templates');
      fs.mkdirSync(path.join(srcDir, 'specs'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'specs', '.gitkeep'), '');
      fs.writeFileSync(path.join(srcDir, 'specs', 'test.md'), 'content');

      const files = getTemplateFiles(srcDir);

      expect(files).not.toContain(path.join('specs', '.gitkeep'));
      expect(files).toContain(path.join('specs', 'test.md'));
    });
  });
});

describe('path validation', () => {
  describe('isValidRelativePath', () => {
    it('should accept valid relative paths', () => {
      expect(isValidRelativePath('file.txt')).toBe(true);
      expect(isValidRelativePath('dir/file.txt')).toBe(true);
      expect(isValidRelativePath('protocols/spider/protocol.md')).toBe(true);
      expect(isValidRelativePath('deep/nested/path/file.md')).toBe(true);
    });

    it('should reject directory traversal attempts', () => {
      expect(isValidRelativePath('../etc/passwd')).toBe(false);
      expect(isValidRelativePath('../../etc/passwd')).toBe(false);
      expect(isValidRelativePath('../../../etc/passwd')).toBe(false);
      expect(isValidRelativePath('dir/../../../etc/passwd')).toBe(false);
      expect(isValidRelativePath('..\\etc\\passwd')).toBe(false);
    });

    it('should reject absolute paths', () => {
      expect(isValidRelativePath('/etc/passwd')).toBe(false);
      expect(isValidRelativePath('/Users/test/file.txt')).toBe(false);
    });

    it('should handle edge cases', () => {
      // Empty path
      expect(isValidRelativePath('')).toBe(true);

      // Just a dot (current directory)
      expect(isValidRelativePath('.')).toBe(true);

      // Paths with dots that are not traversal
      expect(isValidRelativePath('file.test.md')).toBe(true);
      expect(isValidRelativePath('.hidden/file.txt')).toBe(true);
    });
  });

  it('should not allow path traversal in relative paths (legacy test)', () => {
    // Test that malicious paths are handled correctly
    expect(isUserDataPath('../../../etc/passwd')).toBe(false);
    expect(isUserDataPath('specs/../../../etc/passwd')).toBe(true); // starts with specs/
  });
});
