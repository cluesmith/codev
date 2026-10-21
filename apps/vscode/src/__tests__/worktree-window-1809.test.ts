/**
 * #1809: worktree-window behaviour that is not about the connection itself.
 *
 * - The dev target comes from the window root, so a worktree window still runs
 *   dev for its own builder even though its Tower workspace path is the parent.
 * - Activity hooks are suppressed in a worktree window: every event would carry
 *   the parent root and misreport the main workspace as focused.
 * - Gate / mailbox toasts, status-bar counts and the activity-bar badge are off
 *   there: they summarize (and the gate toast's Approve acts on) the PARENT's
 *   builders, which surfaced as a burst of sibling-lane toasts at the dev gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => true) }));

vi.mock('vscode', () => ({
  window: { showWarningMessage: vi.fn(), showErrorMessage: vi.fn() },
  workspace: { isTrusted: true },
  env: { openExternal },
  Uri: { parse: (url: string) => ({ toString: () => url }) },
}));

const { resolveWorkspaceDevTarget } = await import('../commands/dev-shared.js');
const { fireActivity, setActivityHooks, setActivityHooksSuppressed } = await import('../activity-hooks.js');

describe('resolveWorkspaceDevTarget', () => {
  it('targets the builder for a worktree window root', () => {
    expect(resolveWorkspaceDevTarget('/repo/.builders/pir-1809')).toEqual({
      id: 'pir-1809',
      cwd: '/repo/.builders/pir-1809',
      name: 'pir-1809',
    });
  });

  it('targets main for a workspace root', () => {
    expect(resolveWorkspaceDevTarget('/repo')).toEqual({ id: 'main', cwd: '/repo', name: 'Workspace' });
  });
});

describe('activity hooks in a builder-worktree window', () => {
  beforeEach(() => {
    openExternal.mockClear();
    setActivityHooks([{ on: ['window-focus'], url: 'app://x/focus?workspace={workspace}' }]);
  });

  it('fires nothing while suppressed', () => {
    setActivityHooksSuppressed(true);
    fireActivity('/repo', 'window-focus');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('fires normally in a workspace-root window', () => {
    setActivityHooksSuppressed(false);
    fireActivity('/repo', 'window-focus');
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});

// Parent-scoped surfaces stay off in a builder-worktree window. extension.ts's
// activate() can't be driven in a unit test, so pin the wiring at the source level
// (the convention workspace.test.ts uses).
describe('parent-scoped surfaces in a builder-worktree window', () => {
  const EXT_SRC = readFileSync(resolve(__dirname, '../extension.ts'), 'utf8');

  it('computes the window flag from the shared detector', () => {
    expect(EXT_SRC).toMatch(/const isBuilderWorktreeWindow = detectIsBuilderWorktree\(\);/);
  });

  it('does not start gate or mailbox-escalation toasts there', () => {
    expect(EXT_SRC).toMatch(
      /if \(!isBuilderWorktreeWindow\) \{\s*activateGateToasts\(context, overviewCache\);[\s\S]*?activateMailboxEscalationToasts\(context, connectionManager, overviewCache\);\s*\}/,
    );
    expect(EXT_SRC.match(/activateGateToasts\(/g)).toHaveLength(1);
  });

  it('does not auto-open or toast sibling builder spawns there', () => {
    expect(EXT_SRC).toMatch(
      /if \(!isBuilderWorktreeWindow\) \{\s*const builderSpawnHandler = new BuilderSpawnHandler\(/,
    );
    expect(EXT_SRC.match(/new BuilderSpawnHandler\(/g)).toHaveLength(1);
  });

  it('resolves a dev target by id from the window root first', () => {
    const DEV_SRC = readFileSync(resolve(__dirname, '../commands/dev-shared.ts'), 'utf8');
    expect(DEV_SRC).toMatch(/resolveWorkspaceDevTarget\(connectionManager\.getWindowRoot\(\) \?\? workspacePath\)/);
  });

  it("pins the contextual panel to the worktree's own builder", () => {
    expect(EXT_SRC).toMatch(/if \(windowWorkspace\?\.kind === 'builder-worktree'\) \{\s*pinnedPanelBuilderId = windowWorkspace\.builderId;/);
    expect(EXT_SRC).toMatch(/new ContextualPanelProvider\(\s*context\.extensionUri, terminalManager!, overviewCache, reviewQueueStore, pinnedPanelBuilderId\)/);
  });

  it('shows no parent builder counts in the status bar or the activity-bar badge', () => {
    expect(EXT_SRC).toMatch(/const updateStatusBarCounts = \(\) => \{[\s\S]*?if \(isBuilderWorktreeWindow\) \{ return; \}/);
    expect(EXT_SRC).toMatch(/if \(isBuilderWorktreeWindow \|\| connectionManager\?\.getState\(\) !== 'connected' \|\| !data\) \{\s*buildersView\.badge = undefined;/);
  });
});
