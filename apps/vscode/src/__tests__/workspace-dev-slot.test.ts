/**
 * The dev slot (Spec 1963 Phase 5): one decision, `workspaceDevSlot`, read by the Workspace view's dev
 * row and by the Cockpit's workspace-row menu. One table of cases drives all three, so the two
 * views cannot disagree about whether to offer *Start Dev*, *Stop Dev* or the other-target
 * *Stop Dev*.
 */

import { describe, it, expect, vi } from 'vitest';
import { deriveAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { ResolvedWorktreeConfig } from '../load-worktree-config.js';

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter(l => l !== listener); } };
    };
    fire = (e: T) => { this.listeners.forEach(l => l(e)); };
    dispose = () => {};
  }
  class TreeItem {
    id?: string;
    tooltip?: string;
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    constructor(public label: string, public collapsibleState?: number) {}
  }
  class ThemeIcon { constructor(public id: string, public color?: unknown) {} }
  class ThemeColor { constructor(public id: string) {} }
  return {
    EventEmitter: FakeEventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { parse: (s: string) => ({ toString: () => s }) },
    workspace: { getConfiguration: () => ({ get: (_key: string, def: unknown) => def }) },
  };
});

const { WorkspaceProvider, workspaceDevSlot } = await import('../views/workspace.js');
const { CockpitProvider, cockpitWorkspaceContext } = await import('../views/cockpit.js');

const HERE = '/work/codev';
const WORKTREE = `${HERE}/.builders/spir-7`;
const noEvent = () => ({ dispose() {} });

function config(devCommand: string | null): ResolvedWorktreeConfig {
  return { symlinks: [], postSpawn: [], devCommand, devUrls: [] };
}

interface Case {
  name: string;
  windowRoot: string;
  devs: string[];
  config: ResolvedWorktreeConfig | null;
  slot: 'start' | 'stop' | 'stop-other' | 'none';
}

const CASES: Case[] = [
  { name: 'nothing configured, nothing running', windowRoot: HERE, devs: [], config: null, slot: 'none' },
  { name: 'a blank devCommand is no dev command', windowRoot: HERE, devs: [], config: config('  '), slot: 'none' },
  { name: 'a runnable devCommand, nothing running', windowRoot: HERE, devs: [], config: config('pnpm dev'), slot: 'start' },
  { name: "this window's own dev (main) running", windowRoot: HERE, devs: ['main'], config: config('pnpm dev'), slot: 'stop' },
  { name: 'own dev running after devCommand was cleared', windowRoot: HERE, devs: ['main'], config: null, slot: 'stop' },
  { name: "a builder's dev running (started from its menu)", windowRoot: HERE, devs: ['spir-10'], config: config('pnpm dev'), slot: 'stop-other' },
  { name: 'worktree window, its own dev running', windowRoot: WORKTREE, devs: ['spir-7'], config: null, slot: 'stop' },
  { name: "worktree window, main's dev running", windowRoot: WORKTREE, devs: ['main'], config: config('pnpm dev'), slot: 'stop-other' },
  { name: 'worktree window, nothing running', windowRoot: WORKTREE, devs: [], config: config('pnpm dev'), slot: 'start' },
];

/** The Workspace view's `contextValue` for each slot (`undefined`: no dev row at all). */
const WORKSPACE_ROW: Record<Case['slot'], string | undefined> = {
  start: 'workspace-dev-start',
  stop: 'workspace-dev-stop',
  'stop-other': 'workspace-dev-stop-other',
  none: undefined,
};

function managers(c: Case) {
  const worktree = c.windowRoot === WORKTREE ? { builderId: 'spir-7', worktreePath: WORKTREE } : null;
  const connectionManager = {
    getState: () => 'connected',
    getWorkspacePath: () => HERE,
    getWindowRoot: () => c.windowRoot,
    getBuilderWorktree: () => worktree,
    getClient: () => ({ getWorktreeConfig: async () => c.config, getWorkspaceStatus: async () => null }),
    onStateChange: noEvent,
    onSSEEvent: noEvent,
  };
  const terminalManager = {
    listDevTerminals: () => c.devs.map((builderId, i) => ({ builderId, terminalId: `t${i}` })),
    onDidChangeDevTerminals: noEvent,
  };
  return { connectionManager, terminalManager, worktree };
}

describe('workspaceDevSlot: one decision for the Workspace view and the Cockpit', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { connectionManager, terminalManager, worktree } = managers(c);

      expect(workspaceDevSlot(connectionManager, terminalManager, c.config).kind).toBe(c.slot);

      const workspaceView = new WorkspaceProvider(connectionManager as never, terminalManager as never);
      const rows = await workspaceView.getChildren();
      const devRow = rows.find(r => /^workspace-dev-(start|stop|stop-other)$/.test(r.contextValue ?? ''));
      expect(devRow?.contextValue).toBe(WORKSPACE_ROW[c.slot]);

      const cockpit = new CockpitProvider({
        connectionManager: connectionManager as never,
        terminalManager,
        loadWorktreeConfig: async () => c.config,
        towerCache: {
          getFleet: () => [{ workspace: { path: HERE, name: 'codev', active: true, proxyUrl: '', terminals: 1 }, attention: deriveAttention(null), overview: null }],
          isLoaded: () => true,
          getOverview: () => null,
          onDidChange: noEvent,
        } as never,
        overviewCache: { getData: () => null, onDidChange: noEvent } as never,
        diffCache: {} as never,
        builderWorktreeWindow: worktree !== null,
        connection: 'auto',
      });
      const [root] = await cockpit.getChildren();
      const [own] = await cockpit.getChildren(root);
      const role = worktree ? 'parent' : 'current';
      expect(cockpit.getTreeItem(own).contextValue).toBe(cockpitWorkspaceContext(role, c.slot, false));
    });
  }
});
