/**
 * Issue #891: behavioral tests for BuildersProvider's interaction with
 * SearchState. Mirrors `backlog-search.test.ts` but for the builders tree.
 *
 * Filter scope covers issueId, issueTitle, area, labels, spawnedByArchitect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OverviewBuilder, OverviewData } from '@cluesmith/codev-types';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (l: (e: T) => void) => {
      this.listeners.push(l);
      return { dispose: () => { this.listeners = this.listeners.filter(x => x !== l); } };
    };
    fire(e: T): void { this.listeners.forEach(l => l(e)); }
  }
  class TreeItem {
    label: string | undefined;
    id?: string;
    tooltip?: string;
    description?: string;
    contextValue?: string;
    iconPath?: unknown;
    command?: unknown;
    collapsibleState?: number;
    constructor(label?: string, state?: number) {
      this.label = label;
      this.collapsibleState = state;
    }
  }
  return {
    EventEmitter,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(public id: string) {} },
    ThemeColor: class { constructor(public id: string) {} },
    workspace: { getConfiguration: () => ({ get: (_: string, d: unknown) => d }) },
  };
});

import { SearchState } from '../views/search-state.js';
import { BuildersProvider } from '../views/builders.js';
import { BuilderGroupTreeItem, BuilderTreeItem } from '../views/builder-tree-item.js';

function builder(overrides: Partial<OverviewBuilder>): OverviewBuilder {
  return {
    id: 'builder-pir-1',
    issueId: '1',
    issueTitle: 'Test',
    phase: 'implement',
    mode: 'strict',
    gates: {},
    worktreePath: '/tmp/.builders/builder-pir-1',
    roleId: 'builder-pir-1',
    protocol: 'pir',
    planPhases: [],
    progress: 50,
    blocked: null,
    blockedGate: null,
    blockedSince: null,
    startedAt: '2026-05-01T00:00:00Z',
    idleMs: 0,
    lastDataAt: null,
    spawnedByArchitect: null,
    area: 'vscode',
    labels: ['area/vscode'],
    prReady: false,
    ...overrides,
  };
}

function makeCache(builders: OverviewBuilder[]) {
  let data: OverviewData = {
    builders,
    pendingPRs: [],
    backlog: [],
    recentlyClosed: [],
  };
  const listeners: Array<() => void> = [];
  return {
    getData: () => data,
    onDidChange: (l: () => void) => {
      listeners.push(l);
      return { dispose: () => {} };
    },
    setBuilders: (b: OverviewBuilder[]) => {
      data = { ...data, builders: b };
      listeners.forEach(l => l());
    },
  };
}

function makeWorkspaceState() {
  const store = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
    update: async (k: string, v: unknown) => { store.set(k, v); },
    keys: () => Array.from(store.keys()),
  };
}

const fakeDiffCache = { getDiff: async () => ({ files: [], baseRef: 'main' }), dispose: () => {} };

describe('BuildersProvider × SearchState', () => {
  let cache: ReturnType<typeof makeCache>;
  let state: SearchState;
  let provider: BuildersProvider;

  beforeEach(() => {
    cache = makeCache([
      builder({ id: 'builder-pir-101', issueId: '101', issueTitle: 'Terminal cleanup', area: 'tower', labels: ['area/tower'] }),
      builder({ id: 'builder-pir-102', issueId: '102', issueTitle: 'Reader View', area: 'vscode', labels: ['area/vscode'] }),
      builder({ id: 'builder-pir-103', issueId: '103', issueTitle: 'Auth refactor', area: 'auth', labels: ['area/auth'], spawnedByArchitect: 'ob-refine' }),
    ]);
    state = new SearchState();
     
    provider = new BuildersProvider(cache as any, fakeDiffCache as any, makeWorkspaceState() as any, state);
  });

  describe('empty filter', () => {
    it('renders all builders grouped by area', async () => {
      const root = (await provider.getChildren()) as Array<BuilderGroupTreeItem | BuilderTreeItem>;
      const groupRows = root.filter(r => r instanceof BuilderGroupTreeItem);
      expect(groupRows).toHaveLength(3);
    });

    it('reports total = shown when filter is empty', () => {
      expect(provider.getCounts()).toEqual({ total: 3, shown: 3 });
    });
  });

  describe('filter by issue title', () => {
    it('matches case-insensitive substring', () => {
      state.setQuery('Terminal');
      expect(provider.getCounts()).toEqual({ total: 3, shown: 1 });
    });
  });

  describe('filter by issue id', () => {
    it('matches the issue number', () => {
      state.setQuery('102');
      expect(provider.getCounts()).toEqual({ total: 3, shown: 1 });
    });
  });

  describe('filter by label', () => {
    it('matches labels carried from the issue', async () => {
      state.setQuery('area/auth');
      const root = (await provider.getChildren()) as BuilderGroupTreeItem[];
      expect(root).toHaveLength(1);
      expect((root[0] as BuilderGroupTreeItem).areaName).toBe('auth');
    });
  });

  describe('filter by architect', () => {
    it('matches against spawnedByArchitect — useful for multi-architect workspaces', () => {
      state.setQuery('ob-refine');
      expect(provider.getCounts()).toEqual({ total: 3, shown: 1 });
    });
  });

  describe('refresh wiring', () => {
    it('fires the tree-data change emitter when SearchState changes', () => {
      const listener = vi.fn();
      provider.onDidChangeTreeData(listener);
      state.setQuery('foo');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('empty results', () => {
    it('returns no groups when nothing matches', async () => {
      state.setQuery('xyzzyx');
      expect(await provider.getChildren()).toEqual([]);
      expect(provider.getCounts()).toEqual({ total: 3, shown: 0 });
    });
  });

  describe('wire-mismatch defensiveness', () => {
    // Regression: a stale Tower built before this PR's wire-format change
    // serves OverviewBuilder objects without `labels`. The type says
    // `labels: string[]` is required, but trusting that at the consumer
    // crashed `getChildren` with "e.labels is not iterable" in production
    // (architect-reported, dev-approval). Guard with Array.isArray.
    it('does not crash when a builder is missing the labels field entirely', async () => {
      const b = builder({ id: 'builder-pir-999', issueId: '999', issueTitle: 'No labels' });
       
      delete (b as any).labels;
      cache = makeCache([b]);
       
      provider = new BuildersProvider(cache as any, fakeDiffCache as any, makeWorkspaceState() as any, state);
      state.setQuery('No');
      await expect(provider.getChildren()).resolves.not.toThrow();
      expect(provider.getCounts()).toEqual({ total: 1, shown: 1 });
    });

    it('does not crash when labels is null', async () => {
      const b = builder({ id: 'builder-pir-999', issueId: '999', issueTitle: 'Null labels' });
       
      (b as any).labels = null;
      cache = makeCache([b]);
       
      provider = new BuildersProvider(cache as any, fakeDiffCache as any, makeWorkspaceState() as any, state);
      state.setQuery('Null');
      await expect(provider.getChildren()).resolves.not.toThrow();
      expect(provider.getCounts()).toEqual({ total: 1, shown: 1 });
    });
  });
});
