/**
 * Issue #891: behavioral tests for BacklogProvider's interaction with
 * SearchState. Asserts that:
 *   - filter changes trigger a tree refresh
 *   - the filter scope covers id, title, area, labels, assignees, author
 *   - getCounts reports total + post-filter shown
 *   - empty groups disappear naturally when the filter excludes them
 *
 * Mocks `vscode` (EventEmitter + TreeItem stubs) but uses the real
 * SearchState and the real BacklogProvider — the test is exercising the
 * wiring between them, not their internals in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OverviewBacklogItem, OverviewData } from '@cluesmith/codev-types';

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
  };
});

import { SearchState } from '../views/search-state.js';
import { BacklogProvider } from '../views/backlog.js';
import { BacklogGroupTreeItem, BacklogTreeItem } from '../views/backlog-tree-item.js';

function backlogItem(overrides: Partial<OverviewBacklogItem>): OverviewBacklogItem {
  return {
    id: '1',
    title: 'Test',
    url: 'https://github.com/org/repo/issues/1',
    type: 'feature',
    priority: 'medium',
    area: 'vscode',
    labels: [],
    hasSpec: false,
    hasPlan: false,
    hasReview: false,
    hasBuilder: false,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Build a fake OverviewCache the providers can consume. */
function makeCache(backlog: OverviewBacklogItem[]) {
  let data: OverviewData = {
    builders: [],
    pendingPRs: [],
    backlog,
    recentlyClosed: [],
  };
  const listeners: Array<() => void> = [];
  return {
    getData: () => data,
    onDidChange: (l: () => void) => {
      listeners.push(l);
      return { dispose: () => {} };
    },
    setBacklog: (b: OverviewBacklogItem[]) => {
      data = { ...data, backlog: b };
      listeners.forEach(l => l());
    },
  };
}

/** Fake workspaceState — only the methods AreaGroupExpansionStore reads/writes. */
function makeWorkspaceState() {
  const store = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
    update: async (k: string, v: unknown) => { store.set(k, v); },
    keys: () => Array.from(store.keys()),
  };
}

describe('BacklogProvider × SearchState', () => {
  let cache: ReturnType<typeof makeCache>;
  let state: SearchState;
  let provider: BacklogProvider;

  beforeEach(() => {
    cache = makeCache([
      backlogItem({ id: '101', title: 'Terminal cleanup regression', area: 'tower', labels: ['area/tower'] }),
      backlogItem({ id: '102', title: 'Reader View', area: 'vscode', labels: ['area/vscode'] }),
      backlogItem({ id: '103', title: 'Auth flow', area: 'auth', labels: ['area/auth', 'priority:high'], assignees: ['amrmelsayed'] }),
      backlogItem({ id: '104', title: 'Misc cleanup', area: 'vscode', labels: ['area/vscode'], author: 'someone-else' }),
    ]);
    state = new SearchState();
     
    provider = new BacklogProvider(cache as any, makeWorkspaceState() as any, state);
  });

  describe('empty filter', () => {
    it('renders all items as area groups when filter is empty', () => {
      const root = provider.getChildren() as Array<BacklogGroupTreeItem | BacklogTreeItem>;
      // 3 distinct areas: tower (1), vscode (2), auth (1)
      const groupRows = root.filter(r => r instanceof BacklogGroupTreeItem);
      expect(groupRows).toHaveLength(3);
    });

    it('reports total = shown when filter is empty', () => {
      const c = provider.getCounts();
      expect(c.total).toBe(4);
      expect(c.shown).toBe(4);
    });
  });

  describe('filter by title substring', () => {
    beforeEach(() => state.setQuery('terminal'));

    it('drops non-matching groups entirely', () => {
      const root = provider.getChildren() as BacklogGroupTreeItem[];
      // only 'tower' group survives (the terminal-cleanup issue)
      expect(root).toHaveLength(1);
      expect((root[0] as BacklogGroupTreeItem).areaName).toBe('tower');
    });

    it('reports counts under filter', () => {
      expect(provider.getCounts()).toEqual({ total: 4, shown: 1 });
    });
  });

  describe('filter by label', () => {
    it('matches against the full label list including non-area labels', () => {
      state.setQuery('priority:high');
      expect(provider.getCounts()).toEqual({ total: 4, shown: 1 });
      const root = provider.getChildren() as BacklogGroupTreeItem[];
      expect(root).toHaveLength(1);
      expect((root[0] as BacklogGroupTreeItem).areaName).toBe('auth');
    });

    it('matches area/<x> when typed with the slash prefix (labels carry the full name)', () => {
      state.setQuery('area/vscode');
      expect(provider.getCounts()).toEqual({ total: 4, shown: 2 });
    });
  });

  describe('filter by assignee', () => {
    it('matches case-insensitively against assignee logins', () => {
      state.setQuery('AMRMEL');
      expect(provider.getCounts()).toEqual({ total: 4, shown: 1 });
    });
  });

  describe('filter by author', () => {
    it('matches against the author login', () => {
      state.setQuery('someone-else');
      expect(provider.getCounts()).toEqual({ total: 4, shown: 1 });
    });
  });

  describe('filter by id', () => {
    it('matches against the issue number', () => {
      state.setQuery('102');
      expect(provider.getCounts()).toEqual({ total: 4, shown: 1 });
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
    it('returns no groups when nothing matches', () => {
      state.setQuery('xyzzyx');
      expect(provider.getChildren()).toEqual([]);
      expect(provider.getCounts()).toEqual({ total: 4, shown: 0 });
    });
  });
});
