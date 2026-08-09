/**
 * Tests for configuration utilities
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getConfig,
  ensureDirectories,
  getArchitectHarness,
  getBuilderHarness,
  assertBuilderHarnessNotRetired,
  setCliOverrides,
} from '../utils/config.js';
import { logger } from '../utils/logger.js';
import { existsSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Mock loadConfig to avoid depending on the real workspace's config files.
// The agent-farm config.ts imports from lib/config.ts which would detect
// af-config.json in the real workspace and error.
//
// The shell block is a mutable, hoisted object so the retirement tests (#1338)
// can drive builder/architect to a gemini command (string OR array form) or an
// explicit gemini *Harness. Every retirement test resets it in afterEach, so
// the default (claude everywhere) is what all other tests observe.
const configMock = vi.hoisted(() => ({
  shell: { architect: 'claude', builder: 'claude', shell: 'bash' } as {
    architect: string | string[];
    builder: string | string[];
    shell: string;
    architectHarness?: string;
    builderHarness?: string;
  },
}));

vi.mock('../../lib/config.js', () => ({
  loadConfig: () => ({
    shell: configMock.shell,
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

  it('--builder-cmd codex → codex builder harness (no claude resume)', () => {
    setCliOverrides({ builder: 'codex' });
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

// Issue #1338 — the built-in gemini harness is retired. Every config path that
// resolves to gemini (an explicit *Harness, a --*-cmd override, or an
// auto-detected gemini command in string OR array form) must fail closed with
// the retirement, never silently resolve the Claude harness (#929-class
// mismatch) or undefined.
describe('gemini harness retirement (#1338)', () => {
  const savedArchitectCmd = process.env.TOWER_ARCHITECT_CMD;

  afterEach(() => {
    setCliOverrides({});
    configMock.shell.architect = 'claude';
    configMock.shell.builder = 'claude';
    delete configMock.shell.architectHarness;
    delete configMock.shell.builderHarness;
    if (savedArchitectCmd === undefined) {
      delete process.env.TOWER_ARCHITECT_CMD;
    } else {
      process.env.TOWER_ARCHITECT_CMD = savedArchitectCmd;
    }
  });

  it('--builder-cmd gemini fails closed with the retirement', () => {
    setCliOverrides({ builder: 'gemini' });
    expect(() => getBuilderHarness()).toThrow(/retired/i);
  });

  it('--architect-cmd gemini fails closed with the retirement', () => {
    delete process.env.TOWER_ARCHITECT_CMD;
    setCliOverrides({ architect: 'gemini' });
    expect(() => getArchitectHarness()).toThrow(/retired/i);
  });

  it('explicit builderHarness "gemini" fails closed with the retirement', () => {
    configMock.shell.builderHarness = 'gemini';
    expect(() => getBuilderHarness()).toThrow(/retired/i);
  });

  it('array-form builder ["gemini", "--yolo"] fails closed with the retirement', () => {
    configMock.shell.builder = ['gemini', '--yolo'];
    expect(() => getBuilderHarness()).toThrow(/retired/i);
  });

  it('the retirement message names the cause and a supported alternative', () => {
    setCliOverrides({ builder: 'gemini' });
    expect(() => getBuilderHarness()).toThrow(/2026-06-18/);
    expect(() => getBuilderHarness()).toThrow(/claude/);
  });
});

// Issue #1338 — the spawn preflight. `assertBuilderHarnessNotRetired` is called
// in the spawn() dispatcher BEFORE any worktree/porch/db state is created, so a
// retired builder harness aborts with no orphaned state. It must abort on the
// retirement for every config form (explicit *Harness, --builder-cmd override,
// auto-detected command in string OR array form), stay a no-op for supported
// harnesses, and — crucially — defer (NOT abort) on any non-retirement error so
// an unknown harness still surfaces at its normal resolution call site.
describe('assertBuilderHarnessNotRetired spawn preflight (#1338)', () => {
  afterEach(() => {
    setCliOverrides({});
    configMock.shell.architect = 'claude';
    configMock.shell.builder = 'claude';
    delete configMock.shell.architectHarness;
    delete configMock.shell.builderHarness;
  });

  it('aborts on --builder-cmd gemini with the retirement', () => {
    setCliOverrides({ builder: 'gemini' });
    expect(() => assertBuilderHarnessNotRetired()).toThrow(/retired/i);
  });

  it('aborts on explicit builderHarness "gemini" with the retirement', () => {
    configMock.shell.builderHarness = 'gemini';
    expect(() => assertBuilderHarnessNotRetired()).toThrow(/retired/i);
  });

  it('aborts on array-form builder ["gemini", "--yolo"] with the retirement', () => {
    configMock.shell.builder = ['gemini', '--yolo'];
    expect(() => assertBuilderHarnessNotRetired()).toThrow(/retired/i);
  });

  it('is a no-op for a supported builder harness (claude default)', () => {
    expect(() => assertBuilderHarnessNotRetired()).not.toThrow();
  });

  it('is a no-op for a supported builder harness (codex)', () => {
    setCliOverrides({ builder: 'codex' });
    expect(() => assertBuilderHarnessNotRetired()).not.toThrow();
  });

  it('defers (does NOT abort) on an unknown builder harness — surfaces later', () => {
    // An unknown name throws a generic "Unknown harness" (not the retirement).
    // The preflight only aborts spawns for retired harnesses; every other
    // resolution error is left to surface at the real getBuilderHarness call.
    // The deferred error is routed through `logger.debug` (NOT `console.debug`),
    // so it stays out of Tower's stdout log stream unless DEBUG is set (#1338
    // review): Tower imports this module and a bare console.debug always prints.
    configMock.shell.builderHarness = 'no-such-harness';
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    expect(() => assertBuilderHarnessNotRetired()).not.toThrow();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringMatching(/non-retirement, deferred/),
    );
    debugSpy.mockRestore();
  });
});
