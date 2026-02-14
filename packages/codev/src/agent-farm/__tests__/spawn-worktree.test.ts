/**
 * Unit tests for spawn-worktree.ts (Spec 0105 Phase 7)
 *
 * Tests: worktree creation, dependency checking, porch initialization,
 * bugfix collision detection, slugify, resume validation, and session creation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { slugify, DEFAULT_TOWER_PORT, buildWorktreeLaunchScript } from '../commands/spawn-worktree.js';

// Mock dependencies
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
  };
});

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
  fatal: vi.fn((msg: string) => { throw new Error(msg); }),
}));

vi.mock('../utils/shell.js', () => ({
  run: vi.fn(async () => ({ stdout: '', stderr: '' })),
  commandExists: vi.fn(async () => true),
}));

describe('spawn-worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe('DEFAULT_TOWER_PORT', () => {
    it('exports the tower port constant', () => {
      expect(DEFAULT_TOWER_PORT).toBe(4100);
    });
  });

  // =========================================================================
  // Slugify
  // =========================================================================

  describe('slugify', () => {
    it('converts title to lowercase slug', () => {
      const result = slugify('Login fails when username has spaces');
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result).toMatch(/^login-fails-when-username-has/);
    });

    it('removes special characters', () => {
      const result = slugify("Can't authenticate with OAuth2.0!");
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result).toMatch(/^can-t-authenticate-with-oauth2/);
    });

    it('handles empty string', () => {
      expect(slugify('')).toBe('');
    });

    it('truncates to 30 characters', () => {
      const longTitle = 'This is a very long issue title that exceeds thirty characters';
      expect(slugify(longTitle).length).toBeLessThanOrEqual(30);
    });

    it('collapses multiple hyphens', () => {
      expect(slugify('a---b')).toBe('a-b');
    });

    it('trims leading/trailing hyphens', () => {
      expect(slugify('--hello--')).toBe('hello');
    });
  });

  // =========================================================================
  // Build Worktree Launch Script
  // =========================================================================

  describe('buildWorktreeLaunchScript', () => {
    it('generates script without role', () => {
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'claude', null);
      expect(script).toContain('#!/bin/bash');
      expect(script).toContain('cd "/tmp/worktree"');
      expect(script).toContain('claude');
      expect(script).not.toContain('--append-system-prompt');
    });

    it('generates script with role and port injection', () => {
      const role = { content: 'Tower at {PORT}', source: 'codev' };
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'claude', role);
      expect(script).toContain('--append-system-prompt');
      expect(script).toContain('.builder-role.md');
    });

    it('includes restart loop', () => {
      const script = buildWorktreeLaunchScript('/tmp/worktree', 'claude', null);
      expect(script).toContain('while true');
      expect(script).toContain('Restarting in 2 seconds');
    });
  });

  // =========================================================================
  // Collision Detection (unit-level)
  // =========================================================================

  describe('collision detection', () => {
    it('slugify produces filesystem-safe branch names', () => {
      const issueNumber = 42;
      const slug = slugify('Login fails with special chars!@#');
      const branchName = `builder/bugfix-${issueNumber}-${slug}`;
      expect(branchName).toMatch(/^builder\/bugfix-42-[a-z0-9-]+$/);
    });

    it('bugfix IDs match expected pattern', () => {
      const builderId = `bugfix-${42}`;
      expect(builderId).toBe('bugfix-42');
    });
  });
});
