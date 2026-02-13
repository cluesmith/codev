/**
 * Tests for shared session-naming utilities (Spec 0099 Phase 5)
 */

import { describe, it, expect } from 'vitest';
import { getBuilderSessionName, parseTmuxSessionName } from '../utils/session.js';
import type { Config } from '../types.js';

function makeConfig(projectRoot: string): Config {
  return {
    projectRoot,
    codevDir: `${projectRoot}/codev`,
    stateDir: `${projectRoot}/.agent-farm`,
    buildersDir: `${projectRoot}/.builders`,
  } as Config;
}

describe('getBuilderSessionName', () => {
  it('should return builder-{basename}-{id}', () => {
    const config = makeConfig('/home/user/my-project');
    expect(getBuilderSessionName(config, '0042')).toBe('builder-my-project-0042');
  });

  it('should use only the basename of projectRoot', () => {
    const config = makeConfig('/deeply/nested/path/to/repo');
    expect(getBuilderSessionName(config, 'bugfix-99')).toBe('builder-repo-bugfix-99');
  });

  it('should handle single-segment project paths', () => {
    const config = makeConfig('/project');
    expect(getBuilderSessionName(config, '0001')).toBe('builder-project-0001');
  });
});

describe('parseTmuxSessionName', () => {
  describe('architect sessions', () => {
    it('should parse architect-{basename}', () => {
      expect(parseTmuxSessionName('architect-codev-public')).toEqual({
        type: 'architect', projectBasename: 'codev-public', roleId: null,
      });
    });

    it('should handle project names with underscores (sanitized dots)', () => {
      expect(parseTmuxSessionName('architect-codevos_ai')).toEqual({
        type: 'architect', projectBasename: 'codevos_ai', roleId: null,
      });
    });
  });

  describe('SPIR builder sessions (digit IDs)', () => {
    it('should parse 4-digit spec IDs', () => {
      expect(parseTmuxSessionName('builder-codev-public-0001')).toEqual({
        type: 'builder', projectBasename: 'codev-public', roleId: '0001',
      });
    });

    it('should parse short spec IDs (< 4 digits)', () => {
      expect(parseTmuxSessionName('builder-my-project-42')).toEqual({
        type: 'builder', projectBasename: 'my-project', roleId: '42',
      });
    });

    it('should parse single-digit spec IDs', () => {
      expect(parseTmuxSessionName('builder-repo-1')).toEqual({
        type: 'builder', projectBasename: 'repo', roleId: '1',
      });
    });
  });

  describe('bugfix builder sessions', () => {
    it('should parse bugfix-{N} with short issue numbers', () => {
      expect(parseTmuxSessionName('builder-codev-public-bugfix-42')).toEqual({
        type: 'builder', projectBasename: 'codev-public', roleId: 'bugfix-42',
      });
    });

    it('should parse bugfix-{N} with 3-digit issue numbers', () => {
      expect(parseTmuxSessionName('builder-codev-public-bugfix-242')).toEqual({
        type: 'builder', projectBasename: 'codev-public', roleId: 'bugfix-242',
      });
    });

    it('should parse bugfix-{N} with long issue numbers', () => {
      expect(parseTmuxSessionName('builder-my-app-bugfix-12345')).toEqual({
        type: 'builder', projectBasename: 'my-app', roleId: 'bugfix-12345',
      });
    });

    it('should handle project names with underscores', () => {
      expect(parseTmuxSessionName('builder-codevos_ai-bugfix-99')).toEqual({
        type: 'builder', projectBasename: 'codevos_ai', roleId: 'bugfix-99',
      });
    });
  });

  describe('task builder sessions', () => {
    it('should parse task-{shortId}', () => {
      expect(parseTmuxSessionName('builder-codev-public-task-AbCd')).toEqual({
        type: 'builder', projectBasename: 'codev-public', roleId: 'task-AbCd',
      });
    });

    it('should parse task IDs with underscores and hyphens (URL-safe base64)', () => {
      expect(parseTmuxSessionName('builder-codev-public-task-A_-d')).toEqual({
        type: 'builder', projectBasename: 'codev-public', roleId: 'task-A_-d',
      });
    });
  });

  describe('worktree builder sessions', () => {
    it('should parse worktree-{shortId}', () => {
      expect(parseTmuxSessionName('builder-codev-public-worktree-QwEr')).toEqual({
        type: 'builder', projectBasename: 'codev-public', roleId: 'worktree-QwEr',
      });
    });

    it('should parse worktree IDs with underscores and hyphens (URL-safe base64)', () => {
      expect(parseTmuxSessionName('builder-my-app-worktree-x_Y3')).toEqual({
        type: 'builder', projectBasename: 'my-app', roleId: 'worktree-x_Y3',
      });
    });
  });

  describe('shell sessions', () => {
    it('should parse shell-{basename}-shell-{N}', () => {
      expect(parseTmuxSessionName('shell-codev-public-shell-1')).toEqual({
        type: 'shell', projectBasename: 'codev-public', roleId: 'shell-1',
      });
    });

    it('should parse multi-digit shell IDs', () => {
      expect(parseTmuxSessionName('shell-my-project-shell-42')).toEqual({
        type: 'shell', projectBasename: 'my-project', roleId: 'shell-42',
      });
    });
  });

  describe('unrecognized names', () => {
    it('should return null for non-codev sessions', () => {
      expect(parseTmuxSessionName('my-random-session')).toBeNull();
    });

    it('should return null for bare prefix without content', () => {
      expect(parseTmuxSessionName('builder')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(parseTmuxSessionName('')).toBeNull();
    });
  });
});
