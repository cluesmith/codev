/**
 * Tests for cloud-config module (Spec 0097 Phase 1)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// vi.hoisted runs before vi.mock hoisting, so TEST_DIR is available
const { TEST_DIR, AGENT_FARM_DIR, CONFIG_PATH } = vi.hoisted(() => {
  const { resolve } = require('node:path');
  const { tmpdir } = require('node:os');
  const { randomBytes } = require('node:crypto');
  const testDir = resolve(tmpdir(), `cloud-config-test-${randomBytes(4).toString('hex')}`);
  return {
    TEST_DIR: testDir,
    AGENT_FARM_DIR: resolve(testDir, '.agent-farm'),
    CONFIG_PATH: resolve(testDir, '.agent-farm', 'cloud-config.json'),
  };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual('node:os');
  return {
    ...actual,
    homedir: () => TEST_DIR,
  };
});

import {
  getCloudConfigPath,
  readCloudConfig,
  writeCloudConfig,
  deleteCloudConfig,
  isRegistered,
  maskApiKey,
  type CloudConfig,
} from '../lib/cloud-config.js';

const VALID_CONFIG: CloudConfig = {
  tower_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  tower_name: 'my-macbook',
  api_key: 'ctk_AbCdEfGhIjKlMnOpQrStUvWxYz12345678',
  server_url: 'https://codevos.ai',
};

function writeRawConfig(content: string): void {
  mkdirSync(AGENT_FARM_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, content, { mode: 0o600 });
}

describe('cloud-config', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('getCloudConfigPath', () => {
    it('returns path under ~/.agent-farm/', () => {
      const path = getCloudConfigPath();
      expect(path).toBe(CONFIG_PATH);
      expect(path).toContain('.agent-farm');
      expect(path).toContain('cloud-config.json');
    });
  });

  describe('readCloudConfig', () => {
    it('returns null when config file does not exist', () => {
      const result = readCloudConfig();
      expect(result).toBeNull();
    });

    it('reads a valid config file correctly', () => {
      writeRawConfig(JSON.stringify(VALID_CONFIG, null, 2));

      const result = readCloudConfig();
      expect(result).toEqual(VALID_CONFIG);
    });

    it('throws on corrupted JSON', () => {
      writeRawConfig('{invalid json!!!}');

      expect(() => readCloudConfig()).toThrow('invalid JSON');
    });

    it('throws when config is not an object', () => {
      writeRawConfig('"just a string"');

      expect(() => readCloudConfig()).toThrow('Expected an object');
    });

    it('throws when config is an array', () => {
      writeRawConfig('[1, 2, 3]');

      expect(() => readCloudConfig()).toThrow('Expected an object');
    });

    it('returns null with warning when tower_id is missing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const partial = { ...VALID_CONFIG };
      delete (partial as Record<string, unknown>).tower_id;
      writeRawConfig(JSON.stringify(partial));

      const result = readCloudConfig();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tower_id'));
      warnSpy.mockRestore();
    });

    it('returns null with warning when api_key is missing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const partial = { ...VALID_CONFIG };
      delete (partial as Record<string, unknown>).api_key;
      writeRawConfig(JSON.stringify(partial));

      const result = readCloudConfig();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('api_key'));
      warnSpy.mockRestore();
    });

    it('returns null with warning when server_url is missing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const partial = { ...VALID_CONFIG };
      delete (partial as Record<string, unknown>).server_url;
      writeRawConfig(JSON.stringify(partial));

      const result = readCloudConfig();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('server_url'));
      warnSpy.mockRestore();
    });

    it('returns null with warning when tower_name is missing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const partial = { ...VALID_CONFIG };
      delete (partial as Record<string, unknown>).tower_name;
      writeRawConfig(JSON.stringify(partial));

      const result = readCloudConfig();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tower_name'));
      warnSpy.mockRestore();
    });

    it('returns null with warning when all fields are missing', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      writeRawConfig('{}');

      const result = readCloudConfig();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('returns null with warning when a field is empty string', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const partial = { ...VALID_CONFIG, api_key: '' };
      writeRawConfig(JSON.stringify(partial));

      const result = readCloudConfig();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('api_key'));
      warnSpy.mockRestore();
    });

    it('returns null with warning when a field is a number instead of string', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = { ...VALID_CONFIG, tower_id: 12345 };
      writeRawConfig(JSON.stringify(config));

      const result = readCloudConfig();
      expect(result).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('tower_id'));
      warnSpy.mockRestore();
    });

    it('ignores extra fields and returns valid config', () => {
      const configWithExtra = { ...VALID_CONFIG, extra_field: 'hello', another: 42 };
      writeRawConfig(JSON.stringify(configWithExtra));

      const result = readCloudConfig();
      expect(result).toEqual(VALID_CONFIG);
    });
  });

  describe('writeCloudConfig', () => {
    it('writes config file with correct content', () => {
      writeCloudConfig(VALID_CONFIG);

      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual(VALID_CONFIG);
    });

    it('writes config file with 0600 permissions', () => {
      writeCloudConfig(VALID_CONFIG);

      const stats = statSync(CONFIG_PATH);
      // Check owner read+write only (0600)
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('creates parent directory if it does not exist', () => {
      // Remove the .agent-farm dir if it was created
      rmSync(AGENT_FARM_DIR, { recursive: true, force: true });
      expect(existsSync(AGENT_FARM_DIR)).toBe(false);

      writeCloudConfig(VALID_CONFIG);

      expect(existsSync(AGENT_FARM_DIR)).toBe(true);
      expect(existsSync(CONFIG_PATH)).toBe(true);
    });

    it('enforces 0600 on pre-existing files with wrong permissions', () => {
      // Create file with world-readable permissions (0644)
      mkdirSync(AGENT_FARM_DIR, { recursive: true, mode: 0o700 });
      writeFileSync(CONFIG_PATH, '{}', { mode: 0o644 });
      const beforeMode = statSync(CONFIG_PATH).mode & 0o777;
      expect(beforeMode).toBe(0o644);

      // writeCloudConfig should fix permissions
      writeCloudConfig(VALID_CONFIG);

      const afterMode = statSync(CONFIG_PATH).mode & 0o777;
      expect(afterMode).toBe(0o600);
    });

    it('overwrites existing config file', () => {
      writeCloudConfig(VALID_CONFIG);

      const updated = { ...VALID_CONFIG, tower_name: 'new-name' };
      writeCloudConfig(updated);

      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.tower_name).toBe('new-name');
    });

    it('writes valid JSON with trailing newline', () => {
      writeCloudConfig(VALID_CONFIG);

      const raw = readFileSync(CONFIG_PATH, 'utf-8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  describe('deleteCloudConfig', () => {
    it('deletes existing config file', () => {
      writeCloudConfig(VALID_CONFIG);
      expect(existsSync(CONFIG_PATH)).toBe(true);

      deleteCloudConfig();
      expect(existsSync(CONFIG_PATH)).toBe(false);
    });

    it('is a no-op when config file does not exist', () => {
      expect(existsSync(CONFIG_PATH)).toBe(false);
      expect(() => deleteCloudConfig()).not.toThrow();
    });
  });

  describe('isRegistered', () => {
    it('returns false when config does not exist', () => {
      expect(isRegistered()).toBe(false);
    });

    it('returns true when valid config exists', () => {
      writeCloudConfig(VALID_CONFIG);
      expect(isRegistered()).toBe(true);
    });

    it('returns false when config has missing fields', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      writeRawConfig(JSON.stringify({ tower_id: 'abc' }));

      expect(isRegistered()).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe('maskApiKey', () => {
    it('masks a standard ctk_ prefixed key', () => {
      expect(maskApiKey('ctk_AbCdEfGhIjKlMnOpQrStUvWxYz12345678')).toBe('ctk_****5678');
    });

    it('masks a key with different prefix', () => {
      expect(maskApiKey('pat_somethinglong1234')).toBe('pat_****1234');
    });

    it('handles a key with no prefix', () => {
      expect(maskApiKey('abcdefghijklmnop')).toBe('****mnop');
    });

    it('handles a very short key', () => {
      expect(maskApiKey('abc')).toBe('****');
    });

    it('handles empty string', () => {
      expect(maskApiKey('')).toBe('****');
    });

    it('handles key where prefix + 4 chars is the whole key', () => {
      expect(maskApiKey('ctk_abcd')).toBe('ctk_****abcd');
    });

    it('handles key with underscore but too short after prefix', () => {
      // "c_ab" is 4 chars total — too short to show any chars safely
      expect(maskApiKey('c_ab')).toBe('****');
    });
  });
});
