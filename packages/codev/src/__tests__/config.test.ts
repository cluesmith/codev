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
import { deepMerge, loadConfig, resolveProjectConfigPath, resolveLocalConfigPath } from '../lib/config.js';
import { getActivityHooks } from '../agent-farm/utils/config.js';
import { getForgeCommand, loadForgeConfig } from '../lib/forge.js';
import { setFrameworkCacheDir } from '../lib/skeleton.js';
import { forceHostPlatform } from './helpers/host-platform.js';

// Helpers
let tmpDir: string;
let globalCodevDir: string;
let origHome: string | undefined;
let origUserProfile: string | undefined;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-config-test-'));
  globalCodevDir = path.join(tmpDir, 'fake-home', '.codev');
  origHome = process.env.HOME;
  origUserProfile = process.env.USERPROFILE;
  // os.homedir() reads HOME on POSIX and USERPROFILE on Windows; point both at the fake home.
  process.env.HOME = path.join(tmpDir, 'fake-home');
  process.env.USERPROFILE = path.join(tmpDir, 'fake-home');
});

afterEach(() => {
  restoreEnv('HOME', origHome);
  restoreEnv('USERPROFILE', origUserProfile);
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
    // The POSIX defaults; the Windows default shell (powershell.exe) is covered by
    // shell-launch.test.ts 'defaultInteractiveShell' (lib/platform/windows/git-bash-launch.ts).
    forceHostPlatform('linux');
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

// =============================================================================
// forge section layering: a concept's null is "disabled", in every layer (Spec 1995)
// =============================================================================

describe('loadConfig forge section layering', () => {
  afterEach(() => {
    setFrameworkCacheDir(null);
  });

  it('a project null survives a global forge object', () => {
    writeGlobalConfig({ forge: { 'pr-list': 'global-pr-list' } });
    writeProjectConfig(tmpDir, { forge: { 'overview-bundle': null } });
    const forge = loadConfig(tmpDir).forge!;
    expect(forge['overview-bundle']).toBeNull();
    expect('overview-bundle' in forge).toBe(true);
    expect(forge['pr-list']).toBe('global-pr-list');
  });

  it('a project null survives a framework-cache forge object', () => {
    const cacheDir = path.join(tmpDir, 'framework-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'config.json'), JSON.stringify({ forge: { 'issue-list': 'cache-issue-list' } }));
    setFrameworkCacheDir(cacheDir);
    writeProjectConfig(tmpDir, { forge: { 'recently-merged': null } });
    const forge = loadConfig(tmpDir).forge!;
    expect(forge['recently-merged']).toBeNull();
    expect(forge['issue-list']).toBe('cache-issue-list');
  });

  it('a config.local.json null over a project string disables the concept', () => {
    writeProjectConfig(tmpDir, { forge: { 'overview-bundle': 'project-bundle' } });
    writeLocalConfig(tmpDir, { forge: { 'overview-bundle': null } });
    expect(loadConfig(tmpDir).forge?.['overview-bundle']).toBeNull();
  });

  it('a project string over a global null is that string', () => {
    writeGlobalConfig({ forge: { 'overview-bundle': null } });
    writeProjectConfig(tmpDir, { forge: { 'overview-bundle': 'project-bundle' } });
    expect(loadConfig(tmpDir).forge?.['overview-bundle']).toBe('project-bundle');
  });

  it('keeps a key present in only one layer, across all four file layers', () => {
    const cacheDir = path.join(tmpDir, 'framework-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'config.json'), JSON.stringify({ forge: { 'issue-view': 'cache-view' } }));
    setFrameworkCacheDir(cacheDir);
    writeGlobalConfig({ forge: { provider: 'gitlab', 'team-activity': null } });
    writeProjectConfig(tmpDir, { forge: { 'pr-list': 'project-pr-list' } });
    writeLocalConfig(tmpDir, { forge: { 'on-it-timestamps': null } });
    expect(loadConfig(tmpDir).forge).toEqual({
      'issue-view': 'cache-view',
      provider: 'gitlab',
      'team-activity': null,
      'pr-list': 'project-pr-list',
      'on-it-timestamps': null,
    });
  });

  it('a whole-section "forge": null still deletes the section', () => {
    writeGlobalConfig({ forge: { provider: 'gitlab' } });
    writeProjectConfig(tmpDir, { forge: null });
    expect(loadConfig(tmpDir).forge).toBeUndefined();
  });

  it('a null outside the forge section still deletes the key across layers', () => {
    writeGlobalConfig({ shell: { shell: 'zsh' } });
    writeProjectConfig(tmpDir, { shell: { shell: null } });
    const shell = loadConfig(tmpDir).shell!;
    expect('shell' in shell).toBe(false);
    expect(shell.architect).toBe('claude');
  });

  it('a disabled concept resolves to no command through getForgeCommand', () => {
    writeGlobalConfig({ forge: { 'pr-list': 'global-pr-list' } });
    writeProjectConfig(tmpDir, { forge: {} });
    expect(getForgeCommand('overview-bundle', loadForgeConfig(tmpDir))).not.toBeNull();

    writeProjectConfig(tmpDir, { forge: { 'overview-bundle': null } });
    expect(getForgeCommand('overview-bundle', loadForgeConfig(tmpDir))).toBeNull();
    expect(getForgeCommand('pr-list', loadForgeConfig(tmpDir))).toBe('global-pr-list');
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
