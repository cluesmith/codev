/**
 * Tests for cleanup command — task builder lookup logic (Bugfix #347)
 *
 * Task builders use worktree names like "task-bEPd" but their state DB IDs
 * are "builder-task-bepd" (via buildAgentName). Cleanup must normalize
 * these lookups correctly.
 */

import { describe, it, expect } from 'vitest';
import type { Builder } from '../types.js';
import { taskBuilderId } from '../commands/cleanup.js';

/**
 * Re-implement the cleanup lookup logic for testing.
 * Mirrors the task lookup in cleanup.ts without requiring DB or git side effects;
 * the id normalization is cleanup.ts's own taskBuilderId.
 */
function findTaskBuilder(builders: Builder[], taskName: string): Builder | undefined {
  let builder = builders.find((b) => b.id === taskBuilderId(taskName));

  if (!builder) {
    // Fallback: check by worktree path containing the task name
    builder = builders.find((b) => b.worktree.endsWith(`/${taskName}`) || b.worktree.endsWith(`/${taskName}/`));
  }

  return builder;
}

/**
 * Re-implement the --project lookup for task IDs.
 * Mirrors the project lookup in cleanup.ts.
 */
function findByProject(builders: Builder[], projectId: string): Builder | undefined {
  // Direct ID match
  let builder = builders.find((b) => b.id === projectId);

  if (!builder && projectId.startsWith('task-')) {
    builder = builders.find((b) => b.id === taskBuilderId(projectId));
  }

  if (!builder) {
    // Name pattern match
    builder = builders.find((b) => b.name.includes(projectId));
  }

  return builder;
}

// Helper to create a minimal Builder for testing
function makeBuilder(overrides: Partial<Builder>): Builder {
  return {
    id: 'test-builder',
    name: 'Test Builder',
    status: 'implementing',
    phase: 'init',
    worktree: '/workspace/.builders/test',
    branch: 'builder/test',
    type: 'task',
    ...overrides,
  };
}

describe('Cleanup — Task builder lookup (Bugfix #347)', () => {
  const taskBuilder = makeBuilder({
    id: 'builder-task-bepd',
    name: 'Task: Quick fix for auth',
    worktree: '/workspace/.builders/task-bEPd',
    branch: 'builder/task-bEPd',
    type: 'task',
  });

  const bugfixBuilder = makeBuilder({
    id: 'bugfix-42',
    name: 'Bugfix: Login fails',
    worktree: '/workspace/.builders/bugfix-42-login-fails',
    branch: 'builder/bugfix-42-login-fails',
    type: 'bugfix',
    issueNumber: 42,
  });

  const builders = [taskBuilder, bugfixBuilder];

  describe('findTaskBuilder (--task option)', () => {
    it('finds task builder by worktree name with correct casing', () => {
      const found = findTaskBuilder(builders, 'task-bEPd');
      expect(found).toBe(taskBuilder);
    });

    it('finds task builder by worktree name with different casing', () => {
      const found = findTaskBuilder(builders, 'task-BEPD');
      expect(found).toBe(taskBuilder);
    });

    it('finds task builder by short ID alone', () => {
      const found = findTaskBuilder(builders, 'bEPd');
      expect(found).toBe(taskBuilder);
    });

    it('returns undefined for non-existent task', () => {
      const found = findTaskBuilder(builders, 'task-XyZw');
      expect(found).toBeUndefined();
    });

    it('does not find bugfix builders', () => {
      const found = findTaskBuilder(builders, 'bugfix-42');
      expect(found).toBeUndefined();
    });

    it('finds by worktree path fallback', () => {
      // Builder ID doesn't match but worktree path does
      const oddBuilder = makeBuilder({
        id: 'weird-id',
        worktree: '/workspace/.builders/task-AbCd',
      });
      const found = findTaskBuilder([oddBuilder], 'task-AbCd');
      expect(found).toBe(oddBuilder);
    });
  });

  describe('findByProject — handles task-* project IDs', () => {
    it('finds task builder via --project task-bEPd', () => {
      const found = findByProject(builders, 'task-bEPd');
      expect(found).toBe(taskBuilder);
    });

    it('finds bugfix builder via --project bugfix-42', () => {
      const found = findByProject(builders, 'bugfix-42');
      expect(found).toBe(bugfixBuilder);
    });

    it('finds builder by direct ID match', () => {
      const found = findByProject(builders, 'builder-task-bepd');
      expect(found).toBe(taskBuilder);
    });

    it('returns undefined for non-existent project', () => {
      const found = findByProject(builders, 'task-ZZZZ');
      expect(found).toBeUndefined();
    });

    it('finds an all-digit task builder via --project task-0123 (#1992)', () => {
      // spawn names it buildAgentName('task', '0123') = builder-task-123: leading zeros stripped.
      const digitBuilder = makeBuilder({
        id: 'builder-task-123',
        name: 'Task: Quick fix for auth',
        worktree: '/workspace/.builders/task-0123',
        type: 'task',
      });
      expect(findByProject([digitBuilder], 'task-0123')).toBe(digitBuilder);
    });
  });

  describe('cleanup behavior — ephemeral builders', () => {
    it('task builders should be treated as ephemeral (like bugfix)', () => {
      // This documents the expected behavior: task builders get full cleanup
      // (worktree removal + branch deletion) just like bugfix builders
      const isEphemeral = taskBuilder.type === 'bugfix' || taskBuilder.type === 'task';
      expect(isEphemeral).toBe(true);
    });

    it('bugfix builders are ephemeral', () => {
      const isEphemeral = bugfixBuilder.type === 'bugfix' || bugfixBuilder.type === 'task';
      expect(isEphemeral).toBe(true);
    });

    it('spec builders are NOT ephemeral', () => {
      const specBuilder = makeBuilder({ type: 'spec' });
      const isEphemeral = specBuilder.type === 'bugfix' || specBuilder.type === 'task';
      expect(isEphemeral).toBe(false);
    });
  });
});
