/**
 * Tests for configuration utilities
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getConfig,
  ensureDirectories,
  getArchitectHarness,
  getBuilderHarness,
  setCliOverrides,
} from '../utils/config.js';
import { existsSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Mock loadConfig to avoid depending on the real workspace's config files.
// The agent-farm config.ts imports from lib/config.ts which would detect
// af-config.json in the real workspace and error.
vi.mock('../../lib/config.js', () => ({
  loadConfig: () => ({
    shell: { architect: 'claude', builder: 'claude', shell: 'bash' },
    porch: { consultation: { models: ['gemini', 'codex', 'claude'] } },
    framework: { source: 'local' },
  }),
}));

describe('getConfig', () => {
  it('should return a valid config object', () => {
    const config = getConfig();

    expect(config).toBeDefined();
    expect(config.workspaceRoot).toBeDefined();
    expect(config.codevDir).toBeDefined();
    expect(config.buildersDir).toBeDefined();
    expect(config.stateDir).toBeDefined();
    expect(config.templatesDir).toBeDefined();
    expect(config.serversDir).toBeDefined();
  });

  it('should derive paths from workspaceRoot', () => {
    const config = getConfig();

    expect(config.codevDir).toBe(resolve(config.workspaceRoot, 'codev'));
    expect(config.buildersDir).toBe(resolve(config.workspaceRoot, '.builders'));
    expect(config.stateDir).toBe(resolve(config.workspaceRoot, '.agent-farm'));
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

// Issue #929 — harness resolution must be override-aware. The mocked config
// above resolves both shells to `claude` with NO explicit *Harness, so the
// harness is auto-detected from the resolved command. A command override
// (TOWER_ARCHITECT_CMD / --architect-cmd / --builder-cmd) without a matching
// harness config previously still resolved the CLAUDE harness, whose buildResume
// would inject `--resume <stale-claude-uuid>` into the non-claude command and
// crash-loop. `buildResume` being undefined is the precise property that makes
// codex/gemini relaunch fresh — so it's the regression assertion.
describe('getArchitectHarness / getBuilderHarness override-awareness (#929)', () => {
  const savedArchitectCmd = process.env.TOWER_ARCHITECT_CMD;

  afterEach(() => {
    setCliOverrides({});
    if (savedArchitectCmd === undefined) {
      delete process.env.TOWER_ARCHITECT_CMD;
    } else {
      process.env.TOWER_ARCHITECT_CMD = savedArchitectCmd;
    }
  });

  it('resolves the claude harness (buildResume defined) with no overrides', () => {
    delete process.env.TOWER_ARCHITECT_CMD;
    setCliOverrides({});
    expect(getArchitectHarness().buildResume).toBeDefined();
    expect(getBuilderHarness().buildResume).toBeDefined();
  });

  it('TOWER_ARCHITECT_CMD=codex → codex architect harness (no claude resume)', () => {
    process.env.TOWER_ARCHITECT_CMD = 'codex';
    const harness = getArchitectHarness();
    expect(harness.buildResume).toBeUndefined();
  });

  it('--architect-cmd codex → codex architect harness (no claude resume)', () => {
    delete process.env.TOWER_ARCHITECT_CMD;
    setCliOverrides({ architect: 'codex' });
    expect(getArchitectHarness().buildResume).toBeUndefined();
  });

  it('--builder-cmd gemini → gemini builder harness (no claude resume)', () => {
    setCliOverrides({ builder: 'gemini' });
    expect(getBuilderHarness().buildResume).toBeUndefined();
  });

  // Issue #1201, #929-class config angle: a kimi builder command must resolve
  // the KIMI harness, not fall through to claude. The distinguishing
  // properties: provider-owned launch script (kimi-only capability) and an
  // architect-side buildRoleInjection that throws instead of emitting
  // --append-system-prompt.
  it('--builder-cmd kimi → kimi builder harness (provider-owned script, no claude flags)', () => {
    setCliOverrides({ builder: 'kimi' });
    const harness = getBuilderHarness();
    expect(harness.buildBuilderLaunchScript).toBeDefined();
    expect(() => harness.buildRoleInjection('role', '/tmp/role.md')).toThrow(/builder shell/);
  });
});
