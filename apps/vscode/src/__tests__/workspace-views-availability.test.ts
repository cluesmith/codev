/**
 * Spec 1963: the Work and Decisions panels are offered only in a window of a Codev workspace that
 * is not a builder worktree (#1809). Elsewhere their commands explain why instead of acting.
 */

import { describe, it, expect } from 'vitest';
import { workspaceViewUnavailableReason } from '../workspace-views/availability.js';

describe('workspaceViewUnavailableReason', () => {
  it("is null in a Codev workspace's own window", () => {
    expect(workspaceViewUnavailableReason('Decisions', { builderWorktreeWindow: false, workspacePath: '/work/codev' })).toBeNull();
  });

  it("explains a builder-worktree window, pointing to the parent's window", () => {
    const reason = workspaceViewUnavailableReason('Decisions', { builderWorktreeWindow: true, workspacePath: '/work/codev' });
    expect(reason).toBe("Codev: Decisions is not offered in a builder-worktree window. Use it from the parent workspace's window.");
  });

  it('explains a window with no Codev workspace', () => {
    const reason = workspaceViewUnavailableReason('Decisions', { builderWorktreeWindow: false, workspacePath: null });
    expect(reason).toBe('Codev: Decisions needs a Codev workspace, and this window has none. Open a folder containing a Codev project.');
  });
});
