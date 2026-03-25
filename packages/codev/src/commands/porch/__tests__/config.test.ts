/**
 * Tests for porch config loader (loadCheckOverrides)
 *
 * Config is now loaded from .codev/config.json via the unified config loader.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadCheckOverrides } from '../config.js';

describe('loadCheckOverrides', () => {
  let testDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'porch-config-test-'));
    origHome = process.env.HOME;
    // Isolate global config by pointing HOME to a temp dir
    process.env.HOME = path.join(testDir, 'fake-home');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    const dir = path.join(testDir, '.codev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  }

  it('returns null when no config exists', () => {
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns null when config has no porch key', () => {
    writeConfig({ shell: { builder: 'claude' } });
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns null when porch key exists but no checks key', () => {
    writeConfig({ porch: { someOtherKey: 'value' } });
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns the overrides map when porch.checks is present', () => {
    const overrides = {
      build: { command: 'cargo build' },
      tests: { command: 'cargo test' },
      e2e_tests: { skip: true },
    };
    writeConfig({ porch: { checks: overrides } });
    const result = loadCheckOverrides(testDir);
    expect(result).toEqual(overrides);
  });

  it('returns overrides with cwd field', () => {
    const overrides = {
      build: { command: 'make', cwd: 'src/' },
    };
    writeConfig({ porch: { checks: overrides } });
    const result = loadCheckOverrides(testDir);
    expect(result).toEqual(overrides);
    expect(result?.build?.cwd).toBe('src/');
  });

  it('throws on malformed JSON', () => {
    const dir = path.join(testDir, '.codev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), '{ invalid json }');
    expect(() => loadCheckOverrides(testDir)).toThrow('Failed to parse');
  });

  it('returns null when porch is not an object', () => {
    writeConfig({ porch: 'not-an-object' });
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns null when porch.checks is not an object', () => {
    writeConfig({ porch: { checks: 'not-an-object' } });
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns null when porch.checks is an array (not a map)', () => {
    writeConfig({ porch: { checks: [{ command: 'cargo build' }] } });
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('ignores non-porch keys in config', () => {
    writeConfig({
      shell: { builder: 'claude' },
      porch: { checks: { build: { command: 'go build ./...' } } },
      templates: { dir: 'codev/templates' },
    });
    const result = loadCheckOverrides(testDir);
    expect(result).toEqual({ build: { command: 'go build ./...' } });
  });
});
