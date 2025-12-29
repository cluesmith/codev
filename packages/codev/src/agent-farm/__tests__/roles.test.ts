/**
 * Tests for role prompt utilities
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { findRolePromptPath, loadRolePrompt, type RoleConfig } from '../utils/roles.js';

describe('Role Utilities', () => {
  let tempDir: string;
  let config: RoleConfig;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-test-'));
    config = {
      codevDir: path.join(tempDir, 'codev'),
      bundledRolesDir: path.join(tempDir, 'bundled'),
    };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('findRolePromptPath', () => {
    it('should return null when role not found', () => {
      const result = findRolePromptPath(config, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should find local role first', () => {
      // Create both local and bundled
      fs.mkdirSync(path.join(config.codevDir, 'roles'), { recursive: true });
      fs.mkdirSync(config.bundledRolesDir, { recursive: true });
      fs.writeFileSync(path.join(config.codevDir, 'roles', 'architect.md'), 'local content');
      fs.writeFileSync(path.join(config.bundledRolesDir, 'architect.md'), 'bundled content');

      const result = findRolePromptPath(config, 'architect');
      expect(result).not.toBeNull();
      expect(result!.source).toBe('local');
      expect(result!.path).toContain('codev/roles/architect.md');
    });

    it('should fall back to bundled when local not found', () => {
      fs.mkdirSync(config.bundledRolesDir, { recursive: true });
      fs.writeFileSync(path.join(config.bundledRolesDir, 'builder.md'), 'bundled content');

      const result = findRolePromptPath(config, 'builder');
      expect(result).not.toBeNull();
      expect(result!.source).toBe('bundled');
      expect(result!.path).toContain('bundled/builder.md');
    });
  });

  describe('loadRolePrompt', () => {
    it('should return null when role not found', () => {
      const result = loadRolePrompt(config, 'nonexistent');
      expect(result).toBeNull();
    });

    it('should load local role content', () => {
      fs.mkdirSync(path.join(config.codevDir, 'roles'), { recursive: true });
      fs.writeFileSync(path.join(config.codevDir, 'roles', 'architect.md'), '# Architect Role\n\nYou are an architect.');

      const result = loadRolePrompt(config, 'architect');
      expect(result).not.toBeNull();
      expect(result!.source).toBe('local');
      expect(result!.content).toBe('# Architect Role\n\nYou are an architect.');
    });

    it('should load bundled role content when local not found', () => {
      fs.mkdirSync(config.bundledRolesDir, { recursive: true });
      fs.writeFileSync(path.join(config.bundledRolesDir, 'builder.md'), '# Builder Role\n\nYou are a builder.');

      const result = loadRolePrompt(config, 'builder');
      expect(result).not.toBeNull();
      expect(result!.source).toBe('bundled');
      expect(result!.content).toBe('# Builder Role\n\nYou are a builder.');
    });

    it('should prefer local over bundled', () => {
      fs.mkdirSync(path.join(config.codevDir, 'roles'), { recursive: true });
      fs.mkdirSync(config.bundledRolesDir, { recursive: true });
      fs.writeFileSync(path.join(config.codevDir, 'roles', 'custom.md'), 'local custom');
      fs.writeFileSync(path.join(config.bundledRolesDir, 'custom.md'), 'bundled custom');

      const result = loadRolePrompt(config, 'custom');
      expect(result).not.toBeNull();
      expect(result!.source).toBe('local');
      expect(result!.content).toBe('local custom');
    });
  });
});
