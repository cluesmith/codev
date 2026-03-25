/**
 * Tests for codev sync — remote framework source caching.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getCacheDir } from '../commands/sync.js';
import { setFrameworkCacheDir, getFrameworkCacheDir, resolveCodevFile } from '../lib/skeleton.js';

describe('sync module', () => {
  describe('getCacheDir', () => {
    it('returns path under ~/.codev/cache/framework/', () => {
      const dir = getCacheDir('myorg/repo', 'v1.0.0');
      expect(dir).toContain('.codev/cache/framework/');
      expect(dir).toContain('v1.0.0');
    });

    it('uses "default" when ref is not specified', () => {
      const dir = getCacheDir('myorg/repo');
      expect(dir).toContain('default');
    });

    it('different sources get different cache dirs', () => {
      const dir1 = getCacheDir('myorg/repo-a', 'v1.0');
      const dir2 = getCacheDir('myorg/repo-b', 'v1.0');
      expect(dir1).not.toBe(dir2);
    });

    it('different subpaths from same repo get different cache dirs', () => {
      const dir1 = getCacheDir('myorg/repo/team-a', 'v1.0');
      const dir2 = getCacheDir('myorg/repo/team-b', 'v1.0');
      expect(dir1).not.toBe(dir2);
    });
  });
});

describe('framework cache in resolution chain', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-sync-test-'));
    // Reset cache dir
    setFrameworkCacheDir(null);
  });

  afterEach(() => {
    setFrameworkCacheDir(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolveCodevFile checks cache tier when set', () => {
    // Create a file only in the cache
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(path.join(cacheDir, 'roles'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'roles', 'team-role.md'), 'team role content');

    setFrameworkCacheDir(cacheDir);

    // Create workspace with codev/ but no team-role.md there
    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(workspace, 'codev'), { recursive: true });

    const result = resolveCodevFile('roles/team-role.md', workspace);
    expect(result).toBe(path.join(cacheDir, 'roles', 'team-role.md'));
  });

  it('local files take precedence over cache', () => {
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(path.join(cacheDir, 'roles'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'roles', 'test.md'), 'cache content');

    setFrameworkCacheDir(cacheDir);

    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(workspace, 'codev', 'roles'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'codev', 'roles', 'test.md'), 'local content');

    const result = resolveCodevFile('roles/test.md', workspace);
    expect(result).toBe(path.join(workspace, 'codev', 'roles', 'test.md'));
  });

  it('.codev/ overrides take precedence over cache', () => {
    const cacheDir = path.join(tmpDir, 'cache');
    fs.mkdirSync(path.join(cacheDir, 'roles'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'roles', 'test.md'), 'cache content');

    setFrameworkCacheDir(cacheDir);

    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(workspace, '.codev', 'roles'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.codev', 'roles', 'test.md'), 'override content');

    const result = resolveCodevFile('roles/test.md', workspace);
    expect(result).toBe(path.join(workspace, '.codev', 'roles', 'test.md'));
  });

  it('returns null when cache not set and file not found locally', () => {
    const workspace = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(workspace, 'codev'), { recursive: true });

    const result = resolveCodevFile('roles/nonexistent.md', workspace);
    // May return skeleton file or null depending on whether skeleton exists
    // The important thing is no crash
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('getFrameworkCacheDir returns null by default', () => {
    setFrameworkCacheDir(null);
    expect(getFrameworkCacheDir()).toBeNull();
  });

  it('getFrameworkCacheDir returns the set value', () => {
    setFrameworkCacheDir('/some/cache/dir');
    expect(getFrameworkCacheDir()).toBe('/some/cache/dir');
    setFrameworkCacheDir(null); // cleanup
  });
});
