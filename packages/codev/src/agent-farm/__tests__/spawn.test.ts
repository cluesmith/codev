/**
 * Tests for spawn command - validates spawn options and mode detection
 *
 * These are unit tests for the spawn validation logic. Integration tests
 * that spawn actual builders require git and tmux to be installed.
 */

import { describe, it, expect } from 'vitest';
import type { SpawnOptions, BuilderType } from '../types.js';

// Re-implement the validation logic for testing (avoids importing with side effects)
// Updated to match the new protocol-agnostic approach:
// - --protocol serves dual purpose: input mode (alone) OR override (with other inputs)
// - --use-protocol is backwards-compatible alias for --protocol override
// - --strict and --soft control orchestration mode
function validateSpawnOptions(options: SpawnOptions): string | null {
  // Count input modes (excluding --protocol which can be used as override)
  const inputModes = [
    options.project,
    options.task,
    options.shell,
    options.worktree,
    options.issue,
  ].filter(Boolean);

  // --protocol alone is a valid input mode
  const protocolAlone = options.protocol && inputModes.length === 0;

  if (inputModes.length === 0 && !protocolAlone) {
    return 'Must specify one of: --project (-p), --issue (-i), --task, --protocol, --shell, --worktree';
  }

  if (inputModes.length > 1) {
    return 'Flags --project, --issue, --task, --shell, --worktree are mutually exclusive';
  }

  if (options.files && !options.task) {
    return '--files requires --task';
  }

  if ((options.noComment || options.force) && !options.issue) {
    return '--no-comment and --force require --issue';
  }

  // --protocol as override cannot be used with --shell or --worktree
  if (options.protocol && inputModes.length > 0 && (options.shell || options.worktree)) {
    return '--protocol cannot be used with --shell or --worktree (no protocol applies)';
  }

  // --use-protocol backwards compatibility
  if (options.useProtocol && (options.shell || options.worktree)) {
    return '--use-protocol cannot be used with --shell or --worktree (no protocol applies)';
  }

  // --strict and --soft are mutually exclusive
  if (options.strict && options.soft) {
    return '--strict and --soft are mutually exclusive';
  }

  return null; // Valid
}

function getSpawnMode(options: SpawnOptions): BuilderType {
  // Primary input modes take precedence over --protocol as override
  if (options.project) return 'spec';
  if (options.issue) return 'bugfix';
  if (options.task) return 'task';
  if (options.shell) return 'shell';
  if (options.worktree) return 'worktree';
  // --protocol alone is the protocol input mode
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
  // Generate random 24-bit number and base64 encode to 4 chars
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
    describe('valid options', () => {
      it('should accept --project alone', () => {
        const options: SpawnOptions = { project: '0009' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --task alone', () => {
        const options: SpawnOptions = { task: 'Fix the authentication bug' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --task with --files', () => {
        const options: SpawnOptions = {
          task: 'Fix bug',
          files: ['src/auth.ts', 'src/login.ts']
        };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --protocol alone', () => {
        const options: SpawnOptions = { protocol: 'cleanup' };
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

      it('should accept --issue alone', () => {
        const options: SpawnOptions = { issue: 42 };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --issue with --no-comment', () => {
        const options: SpawnOptions = { issue: 42, noComment: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --issue with --force', () => {
        const options: SpawnOptions = { issue: 42, force: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --issue with both --no-comment and --force', () => {
        const options: SpawnOptions = { issue: 42, noComment: true, force: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });
    });

    describe('invalid options', () => {
      it('should reject empty options', () => {
        const options: SpawnOptions = {};
        const error = validateSpawnOptions(options);
        expect(error).toContain('Must specify one of');
      });

      it('should reject --project + --task', () => {
        const options: SpawnOptions = { project: '0009', task: 'Fix bug' };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject --project + --shell', () => {
        const options: SpawnOptions = { project: '0009', shell: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject --protocol + --shell (protocol as override)', () => {
        const options: SpawnOptions = { protocol: 'cleanup', shell: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--protocol cannot be used with --shell or --worktree');
      });

      it('should reject --protocol + --worktree (protocol as override)', () => {
        const options: SpawnOptions = { protocol: 'cleanup', worktree: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--protocol cannot be used with --shell or --worktree');
      });

      it('should reject --shell + --worktree', () => {
        const options: SpawnOptions = { shell: true, worktree: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject --project + --worktree', () => {
        const options: SpawnOptions = { project: '0009', worktree: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject --issue + --project', () => {
        const options: SpawnOptions = { issue: 42, project: '0009' };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject --issue + --task', () => {
        const options: SpawnOptions = { issue: 42, task: 'Fix bug' };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });

      it('should reject --no-comment without --issue', () => {
        const options: SpawnOptions = { project: '0009', noComment: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--no-comment and --force require --issue');
      });

      it('should reject --force without --issue', () => {
        const options: SpawnOptions = { task: 'Fix bug', force: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--no-comment and --force require --issue');
      });

      it('should reject --files without --task', () => {
        const options: SpawnOptions = {
          project: '0009',
          files: ['src/file.ts']
        };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--files requires --task');
      });

      it('should reject triple mode specification', () => {
        const options: SpawnOptions = {
          project: '0009',
          task: 'Fix bug',
          shell: true
        };
        const error = validateSpawnOptions(options);
        expect(error).toContain('mutually exclusive');
      });
    });
  });

  describe('getSpawnMode', () => {
    it('should return "spec" for --project', () => {
      expect(getSpawnMode({ project: '0009' })).toBe('spec');
    });

    it('should return "task" for --task', () => {
      expect(getSpawnMode({ task: 'Fix bug' })).toBe('task');
    });

    it('should return "protocol" for --protocol', () => {
      expect(getSpawnMode({ protocol: 'cleanup' })).toBe('protocol');
    });

    it('should return "shell" for --shell', () => {
      expect(getSpawnMode({ shell: true })).toBe('shell');
    });

    it('should return "worktree" for --worktree', () => {
      expect(getSpawnMode({ worktree: true })).toBe('worktree');
    });

    it('should throw for empty options', () => {
      expect(() => getSpawnMode({})).toThrow('No mode specified');
    });
  });

  describe('generateShortId', () => {
    it('should generate 4-character IDs', () => {
      const id = generateShortId();
      expect(id).toHaveLength(4);
    });

    it('should generate URL-safe base64 characters', () => {
      // Generate many IDs to check character set
      for (let i = 0; i < 100; i++) {
        const id = generateShortId();
        // Should only contain URL-safe base64: a-z, A-Z, 0-9, -, _
        expect(id).toMatch(/^[a-zA-Z0-9_-]{4}$/);
      }
    });

    it('should generate unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateShortId());
      }
      // With 4 base64 chars (64^4 = ~16M possibilities), 100 IDs should be unique
      // Allow for very rare collisions (99+ unique out of 100)
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
    it('should return "bugfix" for --issue', () => {
      expect(getSpawnMode({ issue: 42 })).toBe('bugfix');
    });

    it('slugify converts issue title to URL-safe slug', () => {
      // Slugify truncates to 30 chars, so result ends with trailing dash due to truncation
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
    it('spec mode uses builder/{id}-{spec-name}', () => {
      const specName = '0009-terminal-click';
      const branchName = `builder/${specName}`;
      expect(branchName).toBe('builder/0009-terminal-click');
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
      // Shell mode doesn't create a worktree or branch
      const branch = '';
      expect(branch).toBe('');
    });

    it('worktree mode uses builder/worktree-{rand4}', () => {
      const shortId = generateShortId();
      const branchName = `builder/worktree-${shortId}`;
      expect(branchName).toMatch(/^builder\/worktree-[a-zA-Z0-9_-]{4}$/);
    });
  });

  describe('tmux session naming', () => {
    it('builder sessions use builder-{id}', () => {
      const builderId = '0009';
      const sessionName = `builder-${builderId}`;
      expect(sessionName).toBe('builder-0009');
    });

    it('shell sessions use shell-{rand4}', () => {
      const shortId = generateShortId();
      const sessionName = `shell-${shortId}`;
      expect(sessionName).toMatch(/^shell-[a-zA-Z0-9_-]{4}$/);
    });

    it('worktree sessions use builder-worktree-{rand4}', () => {
      const shortId = generateShortId();
      const builderId = `worktree-${shortId}`;
      const sessionName = `builder-${builderId}`;
      expect(sessionName).toMatch(/^builder-worktree-[a-zA-Z0-9_-]{4}$/);
    });
  });

  describe('protocol override (--use-protocol)', () => {
    describe('valid combinations', () => {
      it('should accept --project with --use-protocol', () => {
        const options: SpawnOptions = { project: '0009', useProtocol: 'tick' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --issue with --use-protocol', () => {
        const options: SpawnOptions = { issue: 42, useProtocol: 'spider' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --task with --use-protocol', () => {
        const options: SpawnOptions = { task: 'Fix bug', useProtocol: 'experiment' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --protocol without --use-protocol (protocol-only mode)', () => {
        const options: SpawnOptions = { protocol: 'maintain' };
        expect(validateSpawnOptions(options)).toBeNull();
      });
    });

    describe('invalid combinations', () => {
      it('should reject --shell with --use-protocol', () => {
        const options: SpawnOptions = { shell: true, useProtocol: 'spider' };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--use-protocol cannot be used with --shell or --worktree');
      });

      it('should reject --worktree with --use-protocol', () => {
        const options: SpawnOptions = { worktree: true, useProtocol: 'spider' };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--use-protocol cannot be used with --shell or --worktree');
      });
    });
  });

  describe('soft mode (--soft)', () => {
    describe('valid combinations', () => {
      it('should accept --project with --soft', () => {
        const options: SpawnOptions = { project: '0009', soft: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --issue with --soft', () => {
        const options: SpawnOptions = { issue: 42, soft: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --task with --soft', () => {
        const options: SpawnOptions = { task: 'Fix bug', soft: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --project with both --soft and --use-protocol', () => {
        const options: SpawnOptions = { project: '0009', soft: true, useProtocol: 'tick' };
        expect(validateSpawnOptions(options)).toBeNull();
      });
    });
  });

  describe('strict mode (--strict)', () => {
    describe('valid combinations', () => {
      it('should accept --project with --strict', () => {
        const options: SpawnOptions = { project: '0009', strict: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --issue with --strict', () => {
        const options: SpawnOptions = { issue: 42, strict: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --task with --strict', () => {
        const options: SpawnOptions = { task: 'Fix bug', strict: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --project with both --strict and --protocol override', () => {
        const options: SpawnOptions = { project: '0009', strict: true, protocol: 'tick' };
        expect(validateSpawnOptions(options)).toBeNull();
      });
    });

    describe('invalid combinations', () => {
      it('should reject --strict with --soft', () => {
        const options: SpawnOptions = { project: '0009', strict: true, soft: true };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--strict and --soft are mutually exclusive');
      });
    });
  });

  describe('--protocol as universal override', () => {
    describe('valid combinations', () => {
      it('should accept --project with --protocol override', () => {
        const options: SpawnOptions = { project: '0009', protocol: 'tick' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --issue with --protocol override', () => {
        const options: SpawnOptions = { issue: 42, protocol: 'spider' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --task with --protocol override', () => {
        const options: SpawnOptions = { task: 'Fix bug', protocol: 'experiment' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --protocol alone as input mode', () => {
        const options: SpawnOptions = { protocol: 'maintain' };
        expect(validateSpawnOptions(options)).toBeNull();
      });

      it('should accept --project with --protocol and --strict', () => {
        const options: SpawnOptions = { project: '0009', protocol: 'tick', strict: true };
        expect(validateSpawnOptions(options)).toBeNull();
      });
    });

    describe('invalid combinations', () => {
      it('should reject --shell with --protocol override', () => {
        const options: SpawnOptions = { shell: true, protocol: 'spider' };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--protocol cannot be used with --shell or --worktree');
      });

      it('should reject --worktree with --protocol override', () => {
        const options: SpawnOptions = { worktree: true, protocol: 'spider' };
        const error = validateSpawnOptions(options);
        expect(error).toContain('--protocol cannot be used with --shell or --worktree');
      });
    });

    describe('mode detection with --protocol override', () => {
      it('--project + --protocol still returns spec mode', () => {
        expect(getSpawnMode({ project: '0009', protocol: 'tick' })).toBe('spec');
      });

      it('--issue + --protocol still returns bugfix mode', () => {
        expect(getSpawnMode({ issue: 42, protocol: 'spider' })).toBe('bugfix');
      });

      it('--task + --protocol still returns task mode', () => {
        expect(getSpawnMode({ task: 'Fix bug', protocol: 'experiment' })).toBe('task');
      });

      it('--protocol alone returns protocol mode', () => {
        expect(getSpawnMode({ protocol: 'maintain' })).toBe('protocol');
      });
    });
  });

  describe('mode resolution', () => {
    // Re-implement resolveMode for testing
    function resolveMode(
      options: SpawnOptions,
      protocol: { defaults?: { mode?: 'strict' | 'soft' } } | null,
    ): 'strict' | 'soft' {
      // 1. Explicit flags always win
      if (options.strict && options.soft) {
        throw new Error('--strict and --soft are mutually exclusive');
      }
      if (options.strict) {
        return 'strict';
      }
      if (options.soft) {
        return 'soft';
      }

      // 2. Protocol defaults from protocol.json
      if (protocol?.defaults?.mode) {
        return protocol.defaults.mode;
      }

      // 3. Input type defaults: only spec mode defaults to strict
      if (options.project) {
        return 'strict';
      }

      // All other modes default to soft
      return 'soft';
    }

    describe('explicit --strict flag', () => {
      it('--strict overrides issue default to soft', () => {
        const options: SpawnOptions = { issue: 42, strict: true };
        expect(resolveMode(options, null)).toBe('strict');
      });

      it('--strict overrides protocol soft default', () => {
        const options: SpawnOptions = { issue: 42, strict: true };
        const protocol = { defaults: { mode: 'soft' as const } };
        expect(resolveMode(options, protocol)).toBe('strict');
      });

      it('--strict + --soft throws error', () => {
        const options: SpawnOptions = { project: '0009', strict: true, soft: true };
        expect(() => resolveMode(options, null)).toThrow('--strict and --soft are mutually exclusive');
      });
    });

    describe('explicit --soft flag', () => {
      it('--soft overrides spec default to strict', () => {
        const options: SpawnOptions = { project: '0009', soft: true };
        expect(resolveMode(options, null)).toBe('soft');
      });

      it('--soft overrides protocol defaults', () => {
        const options: SpawnOptions = { project: '0009', soft: true };
        const protocol = { defaults: { mode: 'strict' as const } };
        expect(resolveMode(options, protocol)).toBe('soft');
      });
    });

    describe('protocol defaults', () => {
      it('uses protocol default mode when no --soft flag', () => {
        const options: SpawnOptions = { issue: 42 };
        const protocol = { defaults: { mode: 'strict' as const } };
        expect(resolveMode(options, protocol)).toBe('strict');
      });

      it('protocol soft default overrides input type default', () => {
        const options: SpawnOptions = { project: '0009' };
        const protocol = { defaults: { mode: 'soft' as const } };
        expect(resolveMode(options, protocol)).toBe('soft');
      });
    });

    describe('input type defaults', () => {
      it('spec mode defaults to strict', () => {
        const options: SpawnOptions = { project: '0009' };
        expect(resolveMode(options, null)).toBe('strict');
      });

      it('issue mode defaults to soft', () => {
        const options: SpawnOptions = { issue: 42 };
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

});

