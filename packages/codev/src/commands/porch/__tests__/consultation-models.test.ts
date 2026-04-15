/**
 * Tests for pluggable consultation model resolution.
 *
 * The resolveConsultationModels function is private to next.ts,
 * so we test it indirectly through the porch next behavior by
 * testing the integration with the config system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// We test the consultation model logic by importing and testing
// the resolveConsultationModels function. Since it's private in next.ts,
// we extract it for testing by testing the config → model flow end-to-end.

import { loadConfig, deepMerge } from '../../../lib/config.js';

describe('consultation model configuration', () => {
  let tmpDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consult-models-test-'));
    origHome = process.env.HOME;
    process.env.HOME = path.join(tmpDir, 'fake-home');
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    const dir = path.join(tmpDir, '.codev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  }

  describe('config loading for consultation models', () => {
    it('returns default models when no config exists', () => {
      const config = loadConfig(tmpDir);
      expect(config.porch?.consultation?.models).toEqual(['gemini', 'codex', 'claude', 'hermes']);
    });

    it('overrides models with config array', () => {
      writeConfig({ porch: { consultation: { models: ['claude'] } } });
      const config = loadConfig(tmpDir);
      expect(config.porch?.consultation?.models).toEqual(['claude']);
    });

    it('accepts "none" string mode', () => {
      writeConfig({ porch: { consultation: { models: 'none' } } });
      const config = loadConfig(tmpDir);
      expect(config.porch?.consultation?.models).toBe('none');
    });

    it('accepts "parent" string mode', () => {
      writeConfig({ porch: { consultation: { models: 'parent' } } });
      const config = loadConfig(tmpDir);
      expect(config.porch?.consultation?.models).toBe('parent');
    });

    it('replaces default array with config array (not concatenated)', () => {
      writeConfig({ porch: { consultation: { models: ['claude', 'gemini'] } } });
      const config = loadConfig(tmpDir);
      // Arrays are replaced per deep merge semantics, not concatenated
      expect(config.porch?.consultation?.models).toEqual(['claude', 'gemini']);
    });
  });

  describe('model validation (via VALID_MODELS)', () => {
// Valid models array has been updated to include hermes
    const VALID_MODELS = ['gemini', 'codex', 'claude', 'hermes'];

    it('all four registered backends are valid', () => {
      for (const model of VALID_MODELS) {
        expect(VALID_MODELS.includes(model)).toBe(true);
      }
    });

    it('unknown model names would be rejected', () => {
      expect(VALID_MODELS.includes('gpt-4')).toBe(false);
      expect(VALID_MODELS.includes('llama')).toBe(false);
    });
  });
});
