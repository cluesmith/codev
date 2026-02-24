/**
 * Tests for porch config loader (loadCheckOverrides)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { loadCheckOverrides } from '../config.js';

describe('loadCheckOverrides', () => {
  const testDir = path.join(tmpdir(), `porch-config-test-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns null when af-config.json does not exist', () => {
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns null when af-config.json has no porch key', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ shell: { builder: 'claude' } })
    );
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns null when porch key exists but no checks key', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ porch: { someOtherKey: 'value' } })
    );
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns the overrides map when porch.checks is present', () => {
    const overrides = {
      build: { command: 'cargo build' },
      tests: { command: 'cargo test' },
      e2e_tests: { skip: true },
    };
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ porch: { checks: overrides } })
    );
    const result = loadCheckOverrides(testDir);
    expect(result).toEqual(overrides);
  });

  it('returns overrides with cwd field', () => {
    const overrides = {
      build: { command: 'make', cwd: 'src/' },
    };
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ porch: { checks: overrides } })
    );
    const result = loadCheckOverrides(testDir);
    expect(result).toEqual(overrides);
    expect(result?.build?.cwd).toBe('src/');
  });

  it('throws on malformed JSON', () => {
    fs.writeFileSync(path.join(testDir, 'af-config.json'), '{ invalid json }');
    expect(() => loadCheckOverrides(testDir)).toThrow('Failed to parse af-config.json');
  });

  it('returns null when af-config.json contains a non-object value', () => {
    fs.writeFileSync(path.join(testDir, 'af-config.json'), '"just a string"');
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns null when porch is not an object', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ porch: 'not-an-object' })
    );
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns null when porch.checks is not an object', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ porch: { checks: 'not-an-object' } })
    );
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('returns null when porch.checks is an array (not a map)', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({ porch: { checks: [{ command: 'cargo build' }] } })
    );
    const result = loadCheckOverrides(testDir);
    expect(result).toBeNull();
  });

  it('ignores non-porch keys in af-config.json', () => {
    fs.writeFileSync(
      path.join(testDir, 'af-config.json'),
      JSON.stringify({
        shell: { builder: 'claude' },
        porch: { checks: { build: { command: 'go build ./...' } } },
        templates: { dir: 'codev/templates' },
      })
    );
    const result = loadCheckOverrides(testDir);
    expect(result).toEqual({ build: { command: 'go build ./...' } });
  });
});
