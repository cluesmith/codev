/**
 * Unit tests for TowerProvider: the cross-workspace tree rendering. Verifies urgency ordering
 * (active workspaces float "needs a human" up), stable label tie-break, current-workspace marking
 * in place (not pinned first), the secondary dormant group, per-workspace attention expansion, and
 * the loading/empty messages. Mocks `vscode` per the established `__tests__` pattern; uses the real
 * SDK helpers and TowerFleetCache shapes.
 */

import { describe, it, expect, vi } from 'vitest';
import type { OverviewData } from '@cluesmith/codev-types';
import type { TowerWorkspace } from '@cluesmith/codev-sdk/tower-client';
import { deriveAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { FleetEntry } from '../views/tower-cache.js';

vi.mock('vscode', () => {
  class FakeEventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void): { dispose: () => void } => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire = (e: T) => { this.listeners.forEach((l) => l(e)); };
  }
  class TreeItem {
    id?: string;
    description?: string;
    tooltip?: string;
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
  };
});

const { TowerProvider, OPEN_WORKSPACE_COMMAND } = await import('../views/tower.js');

function wsRow(path: string, name: string, active: boolean): TowerWorkspace {
  return { path, name, active, proxyUrl: `http://localhost/${name}`, terminals: active ? 1 : 0 };
}

function blocked(since: string): OverviewData {
  return { builders: [{ id: 'b0', issueId: null, issueTitle: null, phase: 'plan', blocked: 'plan review', blockedGate: 'plan-approval', blockedSince: since, prReady: false, lastDataAt: null }], backlog: [], pendingPRs: [], recentlyClosed: [], architects: [], heldCount: 0, mailboxEscalated: false, queuedFeedback: {}, feedbackMode: 'forward' } as unknown as OverviewData;
}
function held(count: number): OverviewData {
  return { builders: [{ id: 'b0', issueId: null, issueTitle: null, phase: 'implement', blocked: null, blockedGate: null, blockedSince: null, prReady: false, lastDataAt: null, heldCount: count }], backlog: [], pendingPRs: [], recentlyClosed: [], architects: [], heldCount: count, mailboxEscalated: false, queuedFeedback: {}, feedbackMode: 'forward' } as unknown as OverviewData;
}
function quiet(): OverviewData {
  return { builders: [], backlog: [], pendingPRs: [], recentlyClosed: [], architects: [], heldCount: 0, mailboxEscalated: false, queuedFeedback: {}, feedbackMode: 'forward' } as unknown as OverviewData;
}

function entry(ws: TowerWorkspace, overview: OverviewData | null): FleetEntry {
  return { workspace: ws, attention: deriveAttention(overview) };
}

function fakeCache(fleet: FleetEntry[], loaded = true) {
  return {
    getFleet: () => fleet,
    isLoaded: () => loaded,
    getAttentionCount: () => fleet.filter((e) => !e.attention.isEmpty).length,
    onDidChange: () => ({ dispose() {} }),
  } as unknown as import('../views/tower-cache.js').TowerFleetCache;
}

function fakeCm(currentPath: string | null) {
  return { getWorkspacePath: () => currentPath } as unknown as import('../connection-manager.js').ConnectionManager;
}

describe('TowerProvider', () => {
  it('shows a connecting message before the first load', () => {
    const provider = new TowerProvider(fakeCache([], false), fakeCm(null));
    const roots = provider.getChildren();
    expect(roots).toHaveLength(1);
    expect(provider.getTreeItem(roots[0]).label).toBe('Connecting to Tower…');
  });

  it('shows an empty message when Tower knows no workspaces', () => {
    const provider = new TowerProvider(fakeCache([], true), fakeCm(null));
    expect(provider.getTreeItem(provider.getChildren()[0]).label).toBe('No workspaces registered');
  });

  it('orders active workspaces by urgency (gate before held before quiet)', () => {
    const fleet = [
      entry(wsRow('/w/quiet', 'quiet', true), quiet()),
      entry(wsRow('/w/held', 'held', true), held(3)),
      entry(wsRow('/w/gate', 'gate', true), blocked('2026-09-01T10:00:00Z')),
    ];
    const provider = new TowerProvider(fakeCache(fleet), fakeCm(null));
    const labels = provider.getChildren().map((n) => provider.getTreeItem(n).label);
    expect(labels).toEqual(['gate', 'held', 'quiet']);
  });

  it('breaks ties by label with a stable sort (two quiet workspaces stay alphabetical)', () => {
    const fleet = [
      entry(wsRow('/w/zeta', 'zeta', true), quiet()),
      entry(wsRow('/w/alpha', 'alpha', true), quiet()),
    ];
    const provider = new TowerProvider(fakeCache(fleet), fakeCm(null));
    expect(provider.getChildren().map((n) => provider.getTreeItem(n).label)).toEqual(['alpha', 'zeta']);
  });

  it('marks the current workspace in place, without pinning it first', () => {
    const fleet = [
      entry(wsRow('/w/current', 'current', true), quiet()),      // this window, but quiet
      entry(wsRow('/w/urgent', 'urgent', true), blocked('2026-09-01T10:00:00Z')),
    ];
    const provider = new TowerProvider(fakeCache(fleet), fakeCm('/w/current'));
    const items = provider.getChildren().map((n) => provider.getTreeItem(n));
    // urgent still outranks the current-but-quiet workspace
    expect(items.map((i) => i.label)).toEqual(['urgent', 'current']);
    const current = items.find((i) => i.label === 'current')!;
    expect(current.description).toContain('current');
    expect(current.contextValue).toBe('tower-workspace-active-current');
  });

  it('puts dormant workspaces in a collapsible secondary group', () => {
    const fleet = [
      entry(wsRow('/w/live', 'live', true), quiet()),
      entry(wsRow('/w/sleepy', 'sleepy', false), null),
    ];
    const provider = new TowerProvider(fakeCache(fleet), fakeCm(null));
    const roots = provider.getChildren();
    const groupNode = roots[roots.length - 1];
    const groupItem = provider.getTreeItem(groupNode);
    expect(groupItem.label).toBe('Dormant (1)');
    const dormantRows = provider.getChildren(groupNode).map((n) => provider.getTreeItem(n));
    expect(dormantRows.map((i) => i.label)).toEqual(['sleepy']);
    expect(dormantRows[0].contextValue).toBe('tower-workspace-dormant');
  });

  it('expands an active workspace into its attention items', () => {
    const fleet = [entry(wsRow('/w/gate', 'gate', true), blocked('2026-09-01T10:00:00Z'))];
    const provider = new TowerProvider(fakeCache(fleet), fakeCm(null));
    const wsNode = provider.getChildren()[0];
    expect(provider.getTreeItem(wsNode).collapsibleState).toBe(1); // Collapsed → has detail
    const children = provider.getChildren(wsNode).map((n) => provider.getTreeItem(n));
    expect(children).toHaveLength(1);
    expect(children[0].description).toContain('plan review');
  });

  it('gives a quiet workspace no expansion and a plain row command', () => {
    const fleet = [entry(wsRow('/w/quiet', 'quiet', true), quiet())];
    const provider = new TowerProvider(fakeCache(fleet), fakeCm(null));
    const node = provider.getChildren()[0];
    const item = provider.getTreeItem(node);
    expect(item.collapsibleState).toBe(0); // None → nothing to expand
    expect((item.command as { command: string }).command).toBe(OPEN_WORKSPACE_COMMAND);
    expect((item.command as { arguments: Array<{ path: string }> }).arguments[0].path).toBe('/w/quiet');
  });
});
