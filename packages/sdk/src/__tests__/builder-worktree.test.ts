import { describe, it, expect } from 'vitest';
import { parseBuilderWorktreePath, isBuilderWorktreePath } from '../builder-worktree.js';

describe('parseBuilderWorktreePath', () => {
  it('parses a builder worktree root', () => {
    expect(parseBuilderWorktreePath('/repo/.builders/pir-1809')).toEqual({
      workspaceRoot: '/repo',
      builderId: 'pir-1809',
      worktreePath: '/repo/.builders/pir-1809',
    });
  });

  it('tolerates a trailing separator', () => {
    expect(parseBuilderWorktreePath('/repo/.builders/pir-1809/')).toEqual({
      workspaceRoot: '/repo',
      builderId: 'pir-1809',
      worktreePath: '/repo/.builders/pir-1809',
    });
  });

  it('parses a path nested inside a worktree', () => {
    expect(parseBuilderWorktreePath('/repo/.builders/42/codev/plans/x.md')).toEqual({
      workspaceRoot: '/repo',
      builderId: '42',
      worktreePath: '/repo/.builders/42',
    });
  });

  it('accepts Windows separators', () => {
    expect(parseBuilderWorktreePath('C:\\repo\\.builders\\bugfix-7')).toEqual({
      workspaceRoot: 'C:\\repo',
      builderId: 'bugfix-7',
      worktreePath: 'C:\\repo\\.builders\\bugfix-7',
    });
  });

  it('uses the final .builders segment for a nested worktree', () => {
    expect(parseBuilderWorktreePath('/repo/.builders/a/.builders/b')).toEqual({
      workspaceRoot: '/repo/.builders/a',
      builderId: 'b',
      worktreePath: '/repo/.builders/a/.builders/b',
    });
  });

  it('returns null for a plain workspace root', () => {
    expect(parseBuilderWorktreePath('/repo')).toBeNull();
  });

  it('returns null for a .builders directory with no id', () => {
    expect(parseBuilderWorktreePath('/repo/.builders')).toBeNull();
    expect(parseBuilderWorktreePath('/repo/.builders/')).toBeNull();
  });

  it('does not match a segment that merely ends in .builders', () => {
    expect(parseBuilderWorktreePath('/repo/x.builders/y')).toBeNull();
    expect(parseBuilderWorktreePath('/repo/.builders-old/y')).toBeNull();
  });
});

describe('isBuilderWorktreePath', () => {
  it('mirrors parseBuilderWorktreePath', () => {
    expect(isBuilderWorktreePath('/repo/.builders/1')).toBe(true);
    expect(isBuilderWorktreePath('/repo')).toBe(false);
  });
});
