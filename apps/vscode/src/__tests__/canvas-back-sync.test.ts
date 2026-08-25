/**
 * Canvas focus back-sync (#1410): a focused spec/plan/review canvas resolves its
 * owning builder by worktree-path prefix, so the deck selection follows the
 * canvas the same way it follows a focused diff.
 */

import { describe, it, expect } from 'vitest';
import { builderIdForWorktreeFile } from '../markdown-preview/canvas-owner.js';

const builders = [
  { id: 'pir-1', worktreePath: '/w/alpha/.builders/pir-1' },
  { id: 'pir-2', worktreePath: '/w/alpha/.builders/pir-2' },
];

describe('builderIdForWorktreeFile (#1410)', () => {
  it('resolves the builder whose worktree contains the canvas artifact', () => {
    expect(builderIdForWorktreeFile(builders, '/w/alpha/.builders/pir-2/codev/plans/2-x.md', '/')).toBe('pir-2');
    expect(builderIdForWorktreeFile(builders, '/w/alpha/.builders/pir-1/codev/specs/1-y.md', '/')).toBe('pir-1');
  });

  it('returns undefined for a main-repo artifact (belongs to no builder)', () => {
    expect(builderIdForWorktreeFile(builders, '/w/alpha/codev/plans/2-x.md', '/')).toBeUndefined();
  });

  it('does not false-match a sibling whose path is a string-prefix but not a path-prefix', () => {
    const b = [{ id: 'pir-1', worktreePath: '/w/alpha/.builders/pir-1' }];
    // `/w/alpha/.builders/pir-12/...` starts with `/w/alpha/.builders/pir-1` textually,
    // but is a different worktree — the separator boundary must prevent the match.
    expect(builderIdForWorktreeFile(b, '/w/alpha/.builders/pir-12/codev/plans/12-z.md', '/')).toBeUndefined();
  });

  it('ignores builders without a worktree path', () => {
    expect(builderIdForWorktreeFile([{ id: 'x' }], '/anything.md', '/')).toBeUndefined();
  });
});
