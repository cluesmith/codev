/**
 * Tests for configuration utilities
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getConfig, ensureDirectories } from '../utils/config.js';
import { existsSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

describe('getConfig', () => {
  it('should return a valid config object', () => {
    const config = getConfig();

    expect(config).toBeDefined();
    expect(config.projectRoot).toBeDefined();
    expect(config.codevDir).toBeDefined();
    expect(config.buildersDir).toBeDefined();
    expect(config.stateDir).toBeDefined();
    expect(config.templatesDir).toBeDefined();
    expect(config.serversDir).toBeDefined();
  });

  it('should derive paths from projectRoot', () => {
    const config = getConfig();

    expect(config.codevDir).toBe(resolve(config.projectRoot, 'codev'));
    expect(config.buildersDir).toBe(resolve(config.projectRoot, '.builders'));
    expect(config.stateDir).toBe(resolve(config.projectRoot, '.agent-farm'));
  });
});

describe('ensureDirectories', () => {
  const testDir = resolve(process.cwd(), '.test-agent-farm');

  beforeEach(async () => {
    // Clean up before each test
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true });
    }
  });

  afterEach(async () => {
    // Clean up after each test
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true });
    }
  });

  it('should create required directories', async () => {
    const config = getConfig();
    // Override stateDir for testing
    const testConfig = {
      ...config,
      stateDir: testDir,
      buildersDir: resolve(testDir, 'builders'),
    };

    await ensureDirectories(testConfig);

    expect(existsSync(testDir)).toBe(true);
    expect(existsSync(testConfig.buildersDir)).toBe(true);
  });

  it('should not fail if directories already exist', async () => {
    const config = getConfig();
    const testConfig = {
      ...config,
      stateDir: testDir,
      buildersDir: resolve(testDir, 'builders'),
    };

    // Create directories first
    await mkdir(testDir, { recursive: true });
    await mkdir(testConfig.buildersDir, { recursive: true });

    // Should not throw
    await expect(ensureDirectories(testConfig)).resolves.not.toThrow();
  });
});
