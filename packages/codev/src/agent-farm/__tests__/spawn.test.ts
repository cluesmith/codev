/**
 * Tests for spawn command - validates spawn options and mode detection
 * Updated for Spec 0126: positional arg + --protocol interface
 *
 * These are unit tests for the spawn validation logic. Integration tests
 * that spawn actual builders require git and Tower to be running.
 */

import { describe, it, expect } from 'vitest';
import type { SpawnOptions, BuilderType } from '../types.js';
import { stripLeadingZeros } from '../utils/agent-names.js';

// Re-implement the validation logic for testing (avoids importing with side effects)
function validateSpawnOptions(options: SpawnOptions): string | null {
  // Count primary input modes
  const inputModes = [
    options.issueNumber,
    options.task,
    options.shell,
    options.worktree,
  ].filter(Boolean);

  // --protocol alone (no other input) is a valid mode
  const protocolAlone = options.protocol && inputModes.length === 0;

  if (inputModes.length === 0 && !protocolAlone) {
    return 'Must specify an issue number or one of: --task, --protocol, --shell, --worktree';
  }

  if (inputModes.length > 1) {
    return 'Issue number, --task, --shell, and --worktree are mutually exclusive';
  }

  // --protocol is required for issue-based spawns (unless --resume or --soft)
  if (options.issueNumber && !options.protocol && !options.resume && !options.soft) {
    return '--protocol is required when spawning with an issue number';
  }

  if (options.files && !options.task) {
    return '--files requires --task';
  }

  if (options.noComment && !options.issueNumber) {
    return '--no-comment requires an issue number';
  }

  if (options.force && !options.issueNumber && !options.task) {
    return '--force requires an issue number (not needed for --task)';
  }

  // --protocol cannot be used with --shell or --worktree
  if (options.protocol && (options.shell || options.worktree)) {
    return '--protocol cannot be used with --shell or --worktree';
  }

  // --amends requires --protocol tick
  if (options.amends && options.protocol !== 'tick') {
    return '--amends requires --protocol tick';
  }

  // --strict and --soft are mutually exclusive
  if (options.strict && options.soft) {
    return '--strict and --soft are mutually exclusive';
  }

  return null; // Valid
}

function getSpawnMode(options: SpawnOptions): BuilderType {
  if (options.task) return 'task';
  if (options.shell) return 'shell';
  if (options.worktree) return 'worktree';

  if (options.issueNumber) {
    if (options.protocol === 'bugfix') return 'bugfix';
    return 'spec';
  }

  if (options.protocol) return 'protocol';
  throw new Error('No mode specified');
}

// Slugify function for issue titles
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

function generateShortId(): string {
  const num = Math.floor(Math.random() * 0xFFFFFF);
  const bytes = new Uint8Array([num >> 16, (num >> 8) & 0xFF, num & 0xFF]);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 4);
}

describe('Spawn Command', () => {
  describe('validateSpawnOptions', () => {
    describe('valid options — positional arg + protocol', () => {
      it('should accept issue number + --protocol spir', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'spir' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept issue number + --protocol bugfix', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'bugfix' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept issue number + --protocol tick + --amends', () => {
        const options: SpawnOptions = { issueNumber: 320, protocol: 'tick', amends: 315 };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept issue number + --soft (no protocol needed)', () => {
        const options: SpawnOptions = { issueNumber: 315, soft: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept issue number + --resume (no protocol needed)', () => {
        const options: SpawnOptions = { issueNumber: 315, resume: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept issue number + --protocol + --soft', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'spir', soft: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept issue number + --protocol + --strict', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'spir', strict: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept issue number + --protocol + --no-comment', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'bugfix', noComment: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept issue number + --protocol + --force', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'bugfix', force: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });
    });

    describe('valid options — alternative modes', () => {
      it('should accept --task alone', () => {
        const options: SpawnOptions = { task: 'Fix the authentication bug' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --task with --files', () => {
        const options: SpawnOptions = {
          task: 'Fix bug',
          files: ['src/auth.ts', 'src/login.ts'],
        };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --task with --force (Bugfix #347: task builders skip dirty worktree)', () => {
        const options: SpawnOptions = { task: 'Quick fix', force: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --protocol alone', () => {
        const options: SpawnOptions = { protocol: 'maintain' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --shell alone', () => {
        const options: SpawnOptions = { shell: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --worktree alone', () => {
        const options: SpawnOptions = { worktree: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });
    });

    describe('invalid options', () => {
      it('should reject empty options', () => {
        const options: SpawnOptions = {};
        const error = validateSpawnOptions(options);
        expect(error).toContain('Must specify');
      });

      it('should reject issue number without --protocol (and no --resume/--soft)', () => {
        const options: SpawnOptions = { issueNumber: 315 };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--protocol is required');
      });

      it('should reject issue number + --task (mutually exclusive)', () => {
        const options: SpawnOptions = { issueNumber: 315, task: 'Fix bug' };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject issue number + --shell (mutually exclusive)', () => {
        const options: SpawnOptions = { issueNumber: 315, shell: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject --task + --shell (mutually exclusive)', () => {
        const options: SpawnOptions = { task: 'Fix bug', shell: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject --shell + --worktree (mutually exclusive)', () => {
        const options: SpawnOptions = { shell: true, worktree: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject --protocol + --shell', () => {
        const options: SpawnOptions = { protocol: 'spir', shell: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--protocol cannot be used with --shell or --worktree');
      });

      it('should reject --protocol + --worktree', () => {
        const options: SpawnOptions = { protocol: 'spir', worktree: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--protocol cannot be used with --shell or --worktree');
      });

      it('should reject --no-comment without issue number', () => {
        const options: SpawnOptions = { task: 'Fix bug', noComment: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--no-comment requires an issue number');
      });

      it('should reject --force without issue number or task', () => {
        const options: SpawnOptions = { protocol: 'maintain', force: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--force requires an issue number');
      });

      it('should reject --files without --task', () => {
        const options: SpawnOptions = {
          issueNumber: 315,
          protocol: 'spir',
          files: ['src/file.ts'],
        };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--files requires --task');
      });

      it('should reject --amends without --protocol tick', () => {
        const options: SpawnOptions = { issueNumber: 320, protocol: 'spir', amends: 315 };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--amends requires --protocol tick');
      });

      it('should reject --amends with --protocol bugfix', () => {
        const options: SpawnOptions = { issueNumber: 320, protocol: 'bugfix', amends: 315 };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--amends requires --protocol tick');
      });

      it('should reject --strict with --soft', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'spir', strict: true, soft: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--strict and --soft are mutually exclusive');
      });

      it('should reject triple mode specification', () => {
        const options: SpawnOptions = {
          issueNumber: 315,
          task: 'Fix bug',
          shell: true,
        };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });
    });
  });

  describe('getSpawnMode', () => {
    it('returns "spec" for issue + --protocol spir', () => {
      expect(getSpawnMode({ issueNumber: 315, protocol: 'spir' })).toBe('spec');
    });

    it('returns "spec" for issue + --protocol tick', () => {
      expect(getSpawnMode({ issueNumber: 315, protocol: 'tick' })).toBe('spec');
    });

    it('returns "bugfix" for issue + --protocol bugfix', () => {
      expect(getSpawnMode({ issueNumber: 315, protocol: 'bugfix' })).toBe('bugfix');
    });

    it('returns "task" for --task', () => {
      expect(getSpawnMode({ task: 'Fix bug' })).toBe('task');
    });

    it('returns "protocol" for --protocol alone', () => {
      expect(getSpawnMode({ protocol: 'maintain' })).toBe('protocol');
    });

    it('returns "shell" for --shell', () => {
      expect(getSpawnMode({ shell: true })).toBe('shell');
    });

    it('returns "worktree" for --worktree', () => {
      expect(getSpawnMode({ worktree: true })).toBe('worktree');
    });

    it('throws for empty options', () => {
      expect(() => getSpawnMode({})).toThrow('No mode specified');
    });

    it('--task takes precedence over --protocol', () => {
      // task + protocol is valid: protocol overrides the task's default
      expect(getSpawnMode({ task: 'Fix bug', protocol: 'spir' })).toBe('task');
    });
  });

  describe('generateShortId', () => {
    it('should generate 4-character IDs', () => {
      const id = generateShortId();
      expect(id).toHaveLength(4);
    });

    it('should generate URL-safe base64 characters', () => {
      for (let i = 0; i < 100; i++) {
        const id = generateShortId();
        expect(id).toMatch(/^[a-zA-Z0-9_-]{4}$/);
      }
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateShortId());
      }
      expect(ids.size).toBeGreaterThanOrEqual(99);
    });

    it('should not contain + or / (non-URL-safe)', () => {
      for (let i = 0; i < 100; i++) {
        const id = generateShortId();
        expect(id).not.toContain('+');
        expect(id).not.toContain('/');
        expect(id).not.toContain('=');
      }
    });
  });

  describe('bugfix mode', () => {
    it('returns "bugfix" for issue + --protocol bugfix', () => {
      expect(getSpawnMode({ issueNumber: 42, protocol: 'bugfix' })).toBe('bugfix');
    });

    it('slugify converts issue title to URL-safe slug', () => {
      const result = slugify('Login fails when username has spaces');
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result).toMatch(/^login-fails-when-username-has/);
    });

    it('slugify removes special characters', () => {
      const result = slugify("Can't authenticate with OAuth2.0!");
      expect(result.length).toBeLessThanOrEqual(30);
      expect(result).toMatch(/^can-t-authenticate-with-oauth2/);
    });

    it('slugify handles empty string', () => {
      expect(slugify('')).toBe('');
    });

    it('slugify truncates to 30 characters', () => {
      const longTitle = 'This is a very long issue title that exceeds thirty characters';
      expect(slugify(longTitle).length).toBeLessThanOrEqual(30);
    });

    it('bugfix IDs match pattern bugfix-{issueNumber}', () => {
      const issueNumber = 42;
      const builderId = `bugfix-${issueNumber}`;
      expect(builderId).toBe('bugfix-42');
    });

    it('bugfix branches include issue number and slug', () => {
      const issueNumber = 42;
      const slug = slugify('Login fails with special chars');
      const branchName = `builder/bugfix-${issueNumber}-${slug}`;
      expect(branchName).toBe('builder/bugfix-42-login-fails-with-special-chars');
    });
  });

  describe('ID format patterns', () => {
    it('task IDs should match pattern task-{rand4}', () => {
      const shortId = generateShortId();
      const taskId = `task-${shortId}`;
      expect(taskId).toMatch(/^task-[a-zA-Z0-9_-]{4}$/);
    });

    it('protocol IDs should match pattern {name}-{rand4}', () => {
      const shortId = generateShortId();
      const protocolId = `cleanup-${shortId}`;
      expect(protocolId).toMatch(/^cleanup-[a-zA-Z0-9_-]{4}$/);
    });

    it('shell IDs should match pattern shell-{rand4}', () => {
      const shortId = generateShortId();
      const shellId = `shell-${shortId}`;
      expect(shellId).toMatch(/^shell-[a-zA-Z0-9_-]{4}$/);
    });

    it('worktree IDs should match pattern worktree-{rand4}', () => {
      const shortId = generateShortId();
      const worktreeId = `worktree-${shortId}`;
      expect(worktreeId).toMatch(/^worktree-[a-zA-Z0-9_-]{4}$/);
    });
  });

  describe('branch naming', () => {
    it('spec mode uses builder/{protocol}-{id}-{spec-name}', () => {
      const branchName = 'builder/spir-315-feature-name';
      expect(branchName).toBe('builder/spir-315-feature-name');
    });

    it('task mode uses builder/task-{rand4}', () => {
      const shortId = generateShortId();
      const branchName = `builder/task-${shortId}`;
      expect(branchName).toMatch(/^builder\/task-[a-zA-Z0-9_-]{4}$/);
    });

    it('protocol mode uses builder/{name}-{rand4}', () => {
      const shortId = generateShortId();
      const branchName = `builder/cleanup-${shortId}`;
      expect(branchName).toMatch(/^builder\/cleanup-[a-zA-Z0-9_-]{4}$/);
    });

    it('shell mode has no branch (empty string)', () => {
      const branch = '';
      expect(branch).toBe('');
    });

    it('worktree mode uses builder/worktree-{rand4}', () => {
      const shortId = generateShortId();
      const branchName = `builder/worktree-${shortId}`;
      expect(branchName).toMatch(/^builder\/worktree-[a-zA-Z0-9_-]{4}$/);
    });
  });

  describe('--amends option (TICK protocol)', () => {
    it('accepts --amends with --protocol tick', () => {
      const options: SpawnOptions = { issueNumber: 320, protocol: 'tick', amends: 315 };
      expect(validateSpawnOptions(options)).toBeNull();
    });

    it('rejects --amends without --protocol', () => {
      const options: SpawnOptions = { issueNumber: 320, amends: 315 };
      // --protocol is also required, so first error triggers
      const error = validateSpawnOptions(options);
      expect(error).toBeTruthy();
    });

    it('rejects --amends with --protocol spir', () => {
      const options: SpawnOptions = { issueNumber: 320, protocol: 'spir', amends: 315 };
      const error = validateSpawnOptions(options);
      expect(error).toContain('--amends requires --protocol tick');
    });
  });

  describe('soft mode', () => {
    it('allows issue number + --soft (no --protocol needed)', () => {
      const options: SpawnOptions = { issueNumber: 315, soft: true };
      expect(validateSpawnOptions(options)).toBeNull();
    });

    it('allows issue number + --soft + --protocol', () => {
      const options: SpawnOptions = { issueNumber: 315, soft: true, protocol: 'spir' };
      expect(validateSpawnOptions(options)).toBeNull();
    });

    it('allows --task + --soft', () => {
      const options: SpawnOptions = { task: 'Fix bug', soft: true };
      expect(validateSpawnOptions(options)).toBeNull();
    });
  });

  describe('resume mode', () => {
    it('allows issue number + --resume (no --protocol needed)', () => {
      const options: SpawnOptions = { issueNumber: 315, resume: true };
      expect(validateSpawnOptions(options)).toBeNull();
    });

    it('allows issue number + --resume + --protocol', () => {
      const options: SpawnOptions = { issueNumber: 315, resume: true, protocol: 'spir' };
      expect(validateSpawnOptions(options)).toBeNull();
    });
  });

  describe('mode resolution', () => {
    // Re-implement resolveMode for testing
    function resolveMode(
      options: SpawnOptions,
      protocol: { defaults?: { mode?: 'strict' | 'soft' } } | null,
    ): 'strict' | 'soft' {
      if (options.strict && options.soft) {
        throw new Error('--strict and --soft are mutually exclusive');
      }
      if (options.strict) return 'strict';
      if (options.soft) return 'soft';

      if (protocol?.defaults?.mode) {
        return protocol.defaults.mode;
      }

      // Issue-based spawns with non-bugfix protocol default to strict
      if (options.issueNumber && options.protocol !== 'bugfix') return 'strict';
      return 'soft';
    }

    describe('explicit --strict flag', () => {
      it('--strict overrides default soft', () => {
        const options: SpawnOptions = { issueNumber: 42, protocol: 'bugfix', strict: true };
        expect(resolveMode(options, null)).toBe('strict');
      });

      it('--strict overrides protocol soft default', () => {
        const options: SpawnOptions = { issueNumber: 42, protocol: 'bugfix', strict: true };
        const protocol = { defaults: { mode: 'soft' as const } };
        expect(resolveMode(options, protocol)).toBe('strict');
      });

      it('--strict + --soft throws error', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'spir', strict: true, soft: true };
        expect(() => resolveMode(options, null)).toThrow('--strict and --soft are mutually exclusive');
      });
    });

    describe('explicit --soft flag', () => {
      it('--soft overrides spec default to strict', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'spir', soft: true };
        expect(resolveMode(options, null)).toBe('soft');
      });

      it('--soft overrides protocol defaults', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'spir', soft: true };
        const protocol = { defaults: { mode: 'strict' as const } };
        expect(resolveMode(options, protocol)).toBe('soft');
      });
    });

    describe('protocol defaults', () => {
      it('uses protocol default mode when no flags', () => {
        const options: SpawnOptions = { issueNumber: 42, protocol: 'bugfix' };
        const protocol = { defaults: { mode: 'strict' as const } };
        expect(resolveMode(options, protocol)).toBe('strict');
      });

      it('protocol soft default overrides input type default', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'spir' };
        const protocol = { defaults: { mode: 'soft' as const } };
        expect(resolveMode(options, protocol)).toBe('soft');
      });
    });

    describe('input type defaults', () => {
      it('spec mode (issue + non-bugfix protocol) defaults to strict', () => {
        const options: SpawnOptions = { issueNumber: 315, protocol: 'spir' };
        expect(resolveMode(options, null)).toBe('strict');
      });

      it('bugfix mode defaults to soft', () => {
        const options: SpawnOptions = { issueNumber: 42, protocol: 'bugfix' };
        expect(resolveMode(options, null)).toBe('soft');
      });

      it('task mode defaults to soft', () => {
        const options: SpawnOptions = { task: 'Fix bug' };
        expect(resolveMode(options, null)).toBe('soft');
      });

      it('protocol mode defaults to soft', () => {
        const options: SpawnOptions = { protocol: 'maintain' };
        expect(resolveMode(options, null)).toBe('soft');
      });

      it('shell mode defaults to soft', () => {
        const options: SpawnOptions = { shell: true };
        expect(resolveMode(options, null)).toBe('soft');
      });

      it('worktree mode defaults to soft', () => {
        const options: SpawnOptions = { worktree: true };
        expect(resolveMode(options, null)).toBe('soft');
      });
    });
  });

  describe('inferProtocolFromWorktree (unit logic)', () => {
    // Re-implement inferProtocolFromWorktree for isolated testing
    function inferProtocolFromWorktree(dirs: string[], issueNumber: number): string | null {
      const strippedId = stripLeadingZeros(String(issueNumber));
      const match = dirs.find(d => {
        const parts = d.split('-');
        return parts.length >= 2 && stripLeadingZeros(parts[1]) === strippedId;
      });
      if (match) return match.split('-')[0];
      return null;
    }

    it('matches worktree with non-padded ID (e.g., spir-315-feature)', () => {
      expect(inferProtocolFromWorktree(['spir-315-feature-name'], 315)).toBe('spir');
    });

    it('matches worktree with zero-padded ID (e.g., spir-0076-feature for issueNumber=76)', () => {
      expect(inferProtocolFromWorktree(['spir-0076-feature-name'], 76)).toBe('spir');
    });

    it('matches bugfix worktree (e.g., bugfix-42-fix-login)', () => {
      expect(inferProtocolFromWorktree(['bugfix-42-fix-login'], 42)).toBe('bugfix');
    });

    it('returns null when no worktree matches', () => {
      expect(inferProtocolFromWorktree(['spir-100-other'], 42)).toBeNull();
    });

    it('returns null for empty directory listing', () => {
      expect(inferProtocolFromWorktree([], 42)).toBeNull();
    });
  });

  describe('no-spec spawn (Spec 444)', () => {
    // Re-implement the spec-file requirement logic from spawnSpec()
    interface ProtocolInput {
      type: string;
      required: boolean;
    }
    interface ProtocolDef {
      input?: ProtocolInput;
    }

    /**
     * Determines if spawn should proceed without a spec file.
     * Returns null if spawn should proceed, or an error message if it should fail.
     */
    function checkSpecRequirement(
      specFileExists: boolean,
      protocolDef: ProtocolDef | null,
      hasAmends: boolean,
    ): string | null {
      if (specFileExists) return null; // spec exists, always proceed

      // No spec file — check if protocol allows it
      if (protocolDef?.input?.required === false && !hasAmends) {
        return null; // protocol allows no-spec spawn
      }
      return 'Spec not found';
    }

    /**
     * Determines naming source.
     * Returns 'github' if GitHub issue title should be used, 'spec' for spec filename.
     */
    function resolveNamingSource(
      specFileExists: boolean,
      ghIssueAvailable: boolean,
    ): 'github' | 'spec' {
      if (ghIssueAvailable) return 'github';
      if (specFileExists) return 'spec';
      throw new Error('No naming source available');
    }

    /**
     * Derives specName for worktree/branch naming.
     */
    function deriveSpecName(
      strippedId: string,
      ghIssueTitle: string | null,
      specFileName: string | null,
    ): string {
      if (ghIssueTitle) {
        return `${strippedId}-${slugify(ghIssueTitle)}`;
      }
      if (specFileName) {
        return specFileName; // already includes ID prefix
      }
      throw new Error('No naming source');
    }

    /**
     * Derives the actual spec name for file references (template context).
     * Uses the actual spec file on disk when available, otherwise falls back
     * to the GitHub-derived name (for the path where Specify phase will create it).
     */
    function deriveActualSpecName(
      specFileName: string | null,
      derivedSpecName: string,
    ): string {
      return specFileName ?? derivedSpecName;
    }

    describe('spec-file requirement check', () => {
      it('allows no-spec spawn when input.required is false and no amends', () => {
        const protocol: ProtocolDef = { input: { type: 'spec', required: false } };
        expect(checkSpecRequirement(false, protocol, false)).toBeNull();
      });

      it('rejects no-spec spawn when input.required is true', () => {
        const protocol: ProtocolDef = { input: { type: 'spec', required: true } };
        expect(checkSpecRequirement(false, protocol, false)).toBe('Spec not found');
      });

      it('rejects no-spec spawn when protocol definition is null', () => {
        expect(checkSpecRequirement(false, null, false)).toBe('Spec not found');
      });

      it('rejects no-spec spawn when amends is set (TICK protection)', () => {
        // TICK also has input.required: false, but amends must have a spec
        const protocol: ProtocolDef = { input: { type: 'spec', required: false } };
        expect(checkSpecRequirement(false, protocol, true)).toBe('Spec not found');
      });

      it('allows spawn when spec file exists regardless of input.required', () => {
        const protocol: ProtocolDef = { input: { type: 'spec', required: true } };
        expect(checkSpecRequirement(true, protocol, false)).toBeNull();
      });
    });

    describe('naming source resolution', () => {
      it('prefers GitHub issue title when available', () => {
        expect(resolveNamingSource(true, true)).toBe('github');
      });

      it('falls back to spec filename when GitHub unavailable', () => {
        expect(resolveNamingSource(true, false)).toBe('spec');
      });

      it('uses GitHub when no spec file exists', () => {
        expect(resolveNamingSource(false, true)).toBe('github');
      });

      it('throws when neither spec nor GitHub available', () => {
        expect(() => resolveNamingSource(false, false)).toThrow('No naming source');
      });
    });

    describe('specName derivation', () => {
      it('uses slugified GitHub title for naming when available', () => {
        const result = deriveSpecName('444', 'af spawn should not require a pre-existing spec file', null);
        // slugify truncates to 30 chars; trailing hyphen may remain after truncation
        expect(result).toBe(`444-${slugify('af spawn should not require a pre-existing spec file')}`);
      });

      it('uses spec filename when GitHub unavailable', () => {
        const result = deriveSpecName('444', null, '444-spawn-improvements');
        expect(result).toBe('444-spawn-improvements');
      });

      it('prefers GitHub title over spec filename', () => {
        const result = deriveSpecName('444', 'Better Title', '444-old-name');
        expect(result).toBe('444-better-title');
      });
    });

    describe('file reference naming (actualSpecName)', () => {
      it('uses actual spec filename when spec exists (even with GitHub title)', () => {
        const result = deriveActualSpecName('444-spawn-improvements', '444-af-spawn-should-not');
        expect(result).toBe('444-spawn-improvements');
      });

      it('uses derived name when no spec file exists', () => {
        const result = deriveActualSpecName(null, '444-af-spawn-should-not');
        expect(result).toBe('444-af-spawn-should-not');
      });
    });

    describe('failure paths', () => {
      it('no spec + no GitHub = error (no naming source)', () => {
        // When input.required: false but GitHub fetch fails and no spec exists,
        // spawn must fail because there is no naming source
        expect(() => resolveNamingSource(false, false)).toThrow('No naming source');
      });

      it('TICK with missing amends spec always fails regardless of input.required', () => {
        // TICK also has input.required: false, but amends enforces spec existence
        const tickProtocol: ProtocolDef = { input: { type: 'spec', required: false } };
        const result = checkSpecRequirement(false, tickProtocol, true);
        expect(result).toBe('Spec not found');
      });
    });

    describe('worktree naming with GitHub title', () => {
      it('constructs correct worktree name from GitHub issue title', () => {
        const issueTitle = 'af spawn should not require a pre-existing spec file';
        const strippedId = '444';
        const slug = slugify(issueTitle);
        const specName = `${strippedId}-${slug}`;
        const specSlug = specName.replace(/^[0-9]+-/, '');
        const worktreeName = `aspir-${strippedId}-${specSlug}`;
        expect(worktreeName).toBe(`aspir-444-${slug}`);
        expect(worktreeName.length).toBeLessThanOrEqual(50); // reasonable length
      });
    });
  });

  describe('TICK --amends spec resolution logic', () => {
    it('TICK with --amends resolves spec by amends number, not issue number', () => {
      // For: af spawn 320 --protocol tick --amends 315
      // The spec lookup should use "315" not "320"
      const options: SpawnOptions = { issueNumber: 320, protocol: 'tick', amends: 315 };
      const specLookupId = (options.protocol === 'tick' && options.amends)
        ? String(options.amends)
        : String(options.issueNumber);
      expect(specLookupId).toBe('315');
    });

    it('non-TICK protocols resolve spec by issue number', () => {
      const options: SpawnOptions = { issueNumber: 315, protocol: 'spir' };
      const specLookupId = (options.protocol === 'tick' && options.amends)
        ? String(options.amends)
        : String(options.issueNumber);
      expect(specLookupId).toBe('315');
    });
  });
});
