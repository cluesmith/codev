/**
 * Unit tests for the unified config loader (lib/config.ts).
 *
 * Tests: deep merge semantics, layer priority, error handling,
 * af-config.json rejection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { deepMerge, loadConfig, resolveProjectConfigPath, resolveLocalConfigPath, validateHarnessOptions, kimiAutoTrustWorkspace } from '../lib/config.js';
import { getActivityHooks } from '../agent-farm/utils/config.js';

// Helpers
let tmpDir: string;
let globalCodevDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-config-test-'));
  globalCodevDir = path.join(tmpDir, 'fake-home', '.codev');
  origHome = process.env.HOME;
  process.env.HOME = path.join(tmpDir, 'fake-home');
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeProjectConfig(workspaceRoot: string, config: Record<string, unknown>) {
  const dir = path.join(workspaceRoot, '.codev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function writeGlobalConfig(config: Record<string, unknown>) {
  fs.mkdirSync(globalCodevDir, { recursive: true });
  fs.writeFileSync(path.join(globalCodevDir, 'config.json'), JSON.stringify(config, null, 2));
}

function writeLocalConfig(workspaceRoot: string, config: Record<string, unknown>) {
  const dir = path.join(workspaceRoot, '.codev');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify(config, null, 2));
}

// =============================================================================
// deepMerge
// =============================================================================

describe('deepMerge', () => {
  it('merges nested objects recursively', () => {
    const base = { a: { x: 1, y: 2 }, b: 'hello' };
    const override = { a: { y: 99, z: 3 } };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: { x: 1, y: 99, z: 3 }, b: 'hello' });
  });

  it('replaces arrays instead of concatenating', () => {
    const base = { models: ['a', 'b', 'c'] };
    const override = { models: ['x'] };
    const result = deepMerge(base, override);
    expect(result).toEqual({ models: ['x'] });
  });

  it('null deletes the key', () => {
    const base = { a: 1, b: 2, c: 3 } as Record<string, unknown>;
    const override = { b: null };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: 1, c: 3 });
    expect('b' in result).toBe(false);
  });

  it('replaces primitives', () => {
    const base = { x: 'old' };
    const override = { x: 'new' };
    expect(deepMerge(base, override)).toEqual({ x: 'new' });
  });

  it('does not mutate the base object', () => {
    const base = { a: { nested: 1 } };
    const baseCopy = JSON.parse(JSON.stringify(base));
    deepMerge(base, { a: { nested: 99 } });
    expect(base).toEqual(baseCopy);
  });

  it('handles empty override', () => {
    const base = { a: 1 };
    expect(deepMerge(base, {})).toEqual({ a: 1 });
  });

  it('handles empty base', () => {
    const base = {} as Record<string, unknown>;
    expect(deepMerge(base, { a: 1 })).toEqual({ a: 1 });
  });
});

// =============================================================================
// resolveProjectConfigPath
// =============================================================================

describe('resolveProjectConfigPath', () => {
  it('returns .codev/config.json path when it exists', () => {
    writeProjectConfig(tmpDir, { shell: {} });
    const result = resolveProjectConfigPath(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.codev', 'config.json'));
  });

  it('returns null when no config exists', () => {
    expect(resolveProjectConfigPath(tmpDir)).toBeNull();
  });

  it('throws when af-config.json exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'af-config.json'), '{}');
    expect(() => resolveProjectConfigPath(tmpDir)).toThrow('af-config.json is no longer supported');
    expect(() => resolveProjectConfigPath(tmpDir)).toThrow('codev update');
  });
});

// =============================================================================
// resolveLocalConfigPath
// =============================================================================

describe('resolveLocalConfigPath', () => {
  it('returns .codev/config.local.json path when it exists', () => {
    writeLocalConfig(tmpDir, { shell: {} });
    const result = resolveLocalConfigPath(tmpDir);
    expect(result).toBe(path.join(tmpDir, '.codev', 'config.local.json'));
  });

  it('returns null when no local config exists', () => {
    expect(resolveLocalConfigPath(tmpDir)).toBeNull();
  });
});

// =============================================================================
// loadConfig
// =============================================================================

describe('loadConfig', () => {
  it('returns defaults when no config files exist', () => {
    const config = loadConfig(tmpDir);
    expect(config.shell?.architect).toBe('claude');
    expect(config.shell?.builder).toBe('claude');
    expect(config.shell?.shell).toBe('bash');
    expect(config.porch?.consultation?.models).toEqual(['gemini', 'codex', 'claude']);
    expect(config.framework?.source).toBe('local');
  });

  it('merges project config over defaults', () => {
    writeProjectConfig(tmpDir, {
      shell: { architect: 'my-custom-claude' },
    });
    const config = loadConfig(tmpDir);
    expect(config.shell?.architect).toBe('my-custom-claude');
    expect(config.shell?.builder).toBe('claude'); // default preserved
  });

  it('merges global config over defaults', () => {
    writeGlobalConfig({
      shell: { shell: 'zsh' },
    });
    const config = loadConfig(tmpDir);
    expect(config.shell?.shell).toBe('zsh');
    expect(config.shell?.architect).toBe('claude'); // default preserved
  });

  it('project config overrides global config', () => {
    writeGlobalConfig({ shell: { architect: 'global-cmd' } });
    writeProjectConfig(tmpDir, { shell: { architect: 'project-cmd' } });
    const config = loadConfig(tmpDir);
    expect(config.shell?.architect).toBe('project-cmd');
  });

  it('handles consultation models override', () => {
    writeProjectConfig(tmpDir, {
      porch: { consultation: { models: ['claude'] } },
    });
    const config = loadConfig(tmpDir);
    expect(config.porch?.consultation?.models).toEqual(['claude']);
  });

  it('null in override removes a key', () => {
    writeProjectConfig(tmpDir, {
      framework: null,
    });
    const config = loadConfig(tmpDir);
    expect(config.framework).toBeUndefined();
  });

  it('throws on invalid JSON in project config', () => {
    const dir = path.join(tmpDir, '.codev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ invalid json }');
    expect(() => loadConfig(tmpDir)).toThrow('Failed to parse');
  });

  it('throws on invalid JSON in global config', () => {
    fs.mkdirSync(globalCodevDir, { recursive: true });
    fs.writeFileSync(path.join(globalCodevDir, 'config.json'), '{ invalid }');
    expect(() => loadConfig(tmpDir)).toThrow('Failed to parse');
  });

  it('throws when af-config.json is present', () => {
    fs.writeFileSync(path.join(tmpDir, 'af-config.json'), '{}');
    expect(() => loadConfig(tmpDir)).toThrow('af-config.json is no longer supported');
  });

  it('handles forge config', () => {
    writeProjectConfig(tmpDir, {
      forge: { provider: 'gitlab', 'issue-view': 'custom-cmd' },
    });
    const config = loadConfig(tmpDir);
    expect(config.forge?.provider).toBe('gitlab');
    expect(config.forge?.['issue-view']).toBe('custom-cmd');
  });

  it('handles porch check overrides', () => {
    writeProjectConfig(tmpDir, {
      porch: { checks: { lint: { skip: true } } },
    });
    const config = loadConfig(tmpDir);
    expect(config.porch?.checks?.lint).toEqual({ skip: true });
  });

  it('leaves porch artifact auto-open unset by default', () => {
    const config = loadConfig(tmpDir);
    expect(config.porch?.autoOpenArtifacts).toBeUndefined();
  });

  it.each([true, false])('loads porch artifact auto-open value %s from project config', (value) => {
    writeProjectConfig(tmpDir, {
      porch: { autoOpenArtifacts: value },
    });
    const config = loadConfig(tmpDir);
    expect(config.porch?.autoOpenArtifacts).toBe(value);
  });

  it('loads porch artifact auto-open from global config', () => {
    writeGlobalConfig({ porch: { autoOpenArtifacts: false } });
    const config = loadConfig(tmpDir);
    expect(config.porch?.autoOpenArtifacts).toBe(false);
  });

  it('project porch artifact auto-open overrides the global value', () => {
    writeGlobalConfig({ porch: { autoOpenArtifacts: false } });
    writeProjectConfig(tmpDir, { porch: { autoOpenArtifacts: true } });
    const config = loadConfig(tmpDir);
    expect(config.porch?.autoOpenArtifacts).toBe(true);
  });

  it('local porch artifact auto-open overrides project and global values', () => {
    writeGlobalConfig({ porch: { autoOpenArtifacts: true } });
    writeProjectConfig(tmpDir, { porch: { autoOpenArtifacts: true } });
    writeLocalConfig(tmpDir, { porch: { autoOpenArtifacts: false } });
    const config = loadConfig(tmpDir);
    expect(config.porch?.autoOpenArtifacts).toBe(false);
  });

  it('layer 5: .codev/config.local.json overrides defaults when project config absent', () => {
    writeLocalConfig(tmpDir, {
      shell: { architect: 'local-only-architect' },
    });
    const config = loadConfig(tmpDir);
    expect(config.shell?.architect).toBe('local-only-architect');
    expect(config.shell?.builder).toBe('claude'); // default preserved
  });

  it('layer 5: local overrides project, non-overlapping project keys survive', () => {
    writeProjectConfig(tmpDir, {
      shell: { architect: 'project-architect', builder: 'project-builder' },
    });
    writeLocalConfig(tmpDir, {
      shell: { architect: 'local-architect' },
    });
    const config = loadConfig(tmpDir);
    expect(config.shell?.architect).toBe('local-architect');   // local wins
    expect(config.shell?.builder).toBe('project-builder');     // project survives
  });

  it('layer 5: missing config.local.json is a no-op', () => {
    writeProjectConfig(tmpDir, {
      shell: { architect: 'project-architect' },
    });
    // no writeLocalConfig — file absent
    const config = loadConfig(tmpDir);
    expect(config.shell?.architect).toBe('project-architect');
  });
});

describe('getActivityHooks (trusted personal layers only — never the committed config)', () => {
  it('resolves hooks from .codev/config.local.json, dropping malformed entries', () => {
    writeLocalConfig(tmpDir, {
      activityHooks: [
        { on: ['window-focus', 'builder-active'], url: 'app://x?w={workspace}', background: true },
        { on: ['bogus-event'], url: 'app://drop-me' }, // no valid event → dropped
        { on: ['window-focus'] },                       // no url → dropped
      ],
    });
    expect(getActivityHooks(tmpDir).hooks).toEqual([
      { on: ['window-focus', 'builder-active'], url: 'app://x?w={workspace}', background: true },
    ]);
  });

  it('IGNORES the committed .codev/config.json (closes the zero-click RCE vector)', () => {
    writeProjectConfig(tmpDir, { activityHooks: [{ on: ['window-focus'], url: 'app://committed-rce' }] });
    expect(getActivityHooks(tmpDir).hooks).toEqual([]);
  });

  it('a per-engineer config.local.json replaces the global hook', () => {
    writeGlobalConfig({ activityHooks: [{ on: ['window-focus'], url: 'app://global' }] });
    writeLocalConfig(tmpDir, { activityHooks: [{ on: ['window-focus'], url: 'app://mine' }] });
    expect(getActivityHooks(tmpDir).hooks.map((h) => h.url)).toEqual(['app://mine']);
  });

  it('picks up a personal hook from ~/.codev/config.json (global)', () => {
    writeGlobalConfig({ activityHooks: [{ on: ['builder-active'], url: 'app://global' }] });
    expect(getActivityHooks(tmpDir).hooks.map((h) => h.url)).toEqual(['app://global']);
  });

  it('returns [] when nothing is configured', () => {
    expect(getActivityHooks(tmpDir).hooks).toEqual([]);
  });
});

/**
 * `harnessOptions` (Issue #1620) — the namespace carrying the kimi workspace-trust opt-in.
 *
 * This block exists because the option gates a **capability grant**, and the two failure
 * directions are not symmetric. A typo that silently reads as `false` is a puzzled operator; one
 * that silently reads as `true` is a permission nobody granted. So the validator is strict about
 * unknown keys and non-booleans, and `kimiAutoTrustWorkspace` fails **closed** on anything it
 * cannot read — including a config file broken for entirely unrelated reasons.
 */
describe('harnessOptions — the kimi workspace-trust opt-in (Issue #1620)', () => {
  describe('validateHarnessOptions', () => {
    it('accepts an absent block, an empty block, and both boolean values', () => {
      expect(() => validateHarnessOptions(undefined)).not.toThrow();
      expect(() => validateHarnessOptions({})).not.toThrow();
      expect(() => validateHarnessOptions({ kimi: {} })).not.toThrow();
      expect(() => validateHarnessOptions({ kimi: { autoTrustWorkspace: true } })).not.toThrow();
      expect(() => validateHarnessOptions({ kimi: { autoTrustWorkspace: false } })).not.toThrow();
    });

    it('rejects an unknown harness, and points at the right namespace', () => {
      // `harness` (custom DEFINITIONS) and `harnessOptions` (built-in SETTINGS) are easy to
      // confuse, so the error says which is which rather than only that the key is wrong.
      expect(() => validateHarnessOptions({ claude: { autoTrustWorkspace: true } }))
        .toThrow(/harnessOptions\.claude.*unknown harness/s);
      expect(() => validateHarnessOptions({ claude: {} })).toThrow(/"harness", not "harnessOptions"/);
    });

    it('rejects an unknown option under kimi rather than ignoring it', () => {
      // The whole point: a misspelled security flag must not silently mean "off".
      expect(() => validateHarnessOptions({ kimi: { autoTrustWorkspac: true } }))
        .toThrow(/harnessOptions\.kimi\.autoTrustWorkspac.*unknown option/s);
    });

    it('rejects a non-boolean rather than coercing it', () => {
      for (const value of ['true', 1, null, {}, []]) {
        expect(() => validateHarnessOptions({ kimi: { autoTrustWorkspace: value } }))
          .toThrow(/must be a boolean/);
      }
    });

    it('rejects non-object shapes at both levels', () => {
      expect(() => validateHarnessOptions('yes')).toThrow(/expected an object, got string/);
      expect(() => validateHarnessOptions([])).toThrow(/expected an object, got array/);
      expect(() => validateHarnessOptions({ kimi: 'true' })).toThrow(/kimi.*expected an object, got string/s);
      expect(() => validateHarnessOptions({ kimi: [] })).toThrow(/kimi.*expected an object, got array/s);
    });
  });

  describe('loadConfig integration', () => {
    it('parses the block through the normal config path', () => {
      writeProjectConfig(tmpDir, { harnessOptions: { kimi: { autoTrustWorkspace: true } } });
      expect(loadConfig(tmpDir).harnessOptions?.kimi?.autoTrustWorkspace).toBe(true);
    });

    it('fails LOAD, not the eventual spawn, on a malformed block', () => {
      // Deliberately fail-fast: a bad security opt-in must surface on the next command, not when
      // a kimi builder is finally spawned days later. This matches how a malformed `harness`
      // block already behaves.
      writeProjectConfig(tmpDir, { harnessOptions: { kimi: { autoTrustWorkspace: 'yes' } } });
      expect(() => loadConfig(tmpDir)).toThrow(/must be a boolean/);
    });

    it('a config with no harnessOptions block is simply absent, not an error', () => {
      writeProjectConfig(tmpDir, { shell: { builder: 'kimi' } });
      expect(loadConfig(tmpDir).harnessOptions).toBeUndefined();
    });
  });

  describe('kimiAutoTrustWorkspace', () => {
    it('is false for a legacy config with no block — silence grants nothing', () => {
      writeProjectConfig(tmpDir, { shell: { builder: 'kimi' } });
      expect(kimiAutoTrustWorkspace(tmpDir)).toBe(false);
    });

    it('is false when no config exists at all', () => {
      expect(kimiAutoTrustWorkspace(tmpDir)).toBe(false);
    });

    it('is true only for an explicit true', () => {
      writeProjectConfig(tmpDir, { harnessOptions: { kimi: { autoTrustWorkspace: true } } });
      expect(kimiAutoTrustWorkspace(tmpDir)).toBe(true);
    });

    it('is false for an explicit false, and for an empty kimi block', () => {
      writeProjectConfig(tmpDir, { harnessOptions: { kimi: { autoTrustWorkspace: false } } });
      expect(kimiAutoTrustWorkspace(tmpDir)).toBe(false);
      writeProjectConfig(tmpDir, { harnessOptions: { kimi: {} } });
      expect(kimiAutoTrustWorkspace(tmpDir)).toBe(false);
    });

    it('fails CLOSED when the config cannot be read at all', () => {
      // A config broken for unrelated reasons must not be what decides we may grant trust. The
      // breakage still surfaces loudly through every other `loadConfig` caller; this one reader
      // answers "no" rather than propagating.
      fs.mkdirSync(path.join(tmpDir, '.codev'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.codev', 'config.json'), '{ not json', 'utf-8');
      expect(kimiAutoTrustWorkspace(tmpDir)).toBe(false);
    });
  });
});
