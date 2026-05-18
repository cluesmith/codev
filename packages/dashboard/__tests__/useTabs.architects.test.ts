/**
 * Spec 761: per-architect tabs in useTabs.
 *
 * Verifies:
 *  - Architects emit one tab each; the first uses bare `id: 'architect'`.
 *  - Subsequent architects use `id: 'architect:<name>'`.
 *  - Each architect tab carries `architectName`.
 *  - The fallback `state.architect` scalar populates a one-element tab list
 *    when `state.architects` is absent (deploy-window safety).
 *  - localStorage round-trip restores the persisted active architect on mount.
 *  - The `?tab=architect:<name>` deep-link selects the named architect tab.
 *  - The bare `?tab=architect` deep-link still selects the first architect.
 *  - Unknown architect names fall back to the first architect tab.
 *  - Removed auto-switch skip: newly-added architects auto-focus.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DashboardState } from '@cluesmith/codev-types';

// localStorage mock for jsdom (same pattern as TipBanner.test.tsx)
const storageMap = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => storageMap.set(key, value),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
  get length() { return storageMap.size; },
  key: (index: number) => [...storageMap.keys()][index] ?? null,
};
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

import { useTabs } from '../src/hooks/useTabs.js';

function makeState(overrides: Partial<DashboardState>): DashboardState {
  return {
    architect: null,
    architects: [],
    builders: [],
    utils: [],
    annotations: [],
    ...overrides,
  };
}

function archEntry(name: string, overrides: Partial<{ pid: number; terminalId: string; persistent: boolean }> = {}) {
  return {
    name,
    port: 0,
    pid: overrides.pid ?? 1,
    terminalId: overrides.terminalId ?? `term-${name}`,
    persistent: overrides.persistent ?? false,
  };
}

const STORAGE_KEY = `codev-active-architect:/workspace/Vd29ya3NwYWNl/`;

beforeEach(() => {
  // Ensure clean URL state for each test
  window.history.replaceState({}, '', '/workspace/Vd29ya3NwYWNl/');
  storageMap.clear();
});

afterEach(() => {
  storageMap.clear();
});

describe('useTabs — architect tabs (Spec 761)', () => {
  it('emits no architect tab when state has no architects', () => {
    const { result } = renderHook(() => useTabs(makeState({})));
    expect(result.current.tabs.filter(t => t.type === 'architect')).toHaveLength(0);
  });

  it('emits one architect tab with bare id "architect" when N=1', () => {
    const { result } = renderHook(() => useTabs(makeState({
      architects: [archEntry('main')],
    })));

    const archTabs = result.current.tabs.filter(t => t.type === 'architect');
    expect(archTabs).toHaveLength(1);
    expect(archTabs[0].id).toBe('architect');
    expect(archTabs[0].label).toBe('main');
    expect(archTabs[0].architectName).toBe('main');
  });

  it('emits N architect tabs with the first using bare id "architect" and rest prefixed', () => {
    const { result } = renderHook(() => useTabs(makeState({
      architects: [archEntry('main'), archEntry('sibling'), archEntry('architect-3')],
    })));

    const archTabs = result.current.tabs.filter(t => t.type === 'architect');
    expect(archTabs.map(t => t.id)).toEqual([
      'architect',
      'architect:sibling',
      'architect:architect-3',
    ]);
    expect(archTabs.map(t => t.architectName)).toEqual(['main', 'sibling', 'architect-3']);
  });

  it('falls back to scalar state.architect when state.architects is absent (deploy-window safety)', () => {
    // Simulate older server response shape — only the scalar field is present
    // and architects is undefined. The hook should treat it as a one-arch list.
    const { result } = renderHook(() => useTabs({
      architect: archEntry('main'),
      builders: [],
      utils: [],
      annotations: [],
      // architects intentionally omitted (cast through unknown to satisfy TS)
    } as unknown as DashboardState));

    const archTabs = result.current.tabs.filter(t => t.type === 'architect');
    expect(archTabs).toHaveLength(1);
    expect(archTabs[0].architectName).toBe('main');
    expect(archTabs[0].id).toBe('architect');
  });

  it('does NOT restore active architect from localStorage into activeTabId', () => {
    // Spec 761 (post Claude iter-1 review): useTabs deliberately does not
    // read localStorage. If it did, activeTabId would land on an architect
    // tab on reload, which blanks the desktop right pane (every section
    // checks activeTab?.type === 'work'/'analytics'/'team', all false for
    // an architect tab). Architect restoration is App.tsx's responsibility.
    localStorage.setItem(STORAGE_KEY, 'sibling');

    const { result } = renderHook(() => useTabs(makeState({
      architects: [archEntry('main'), archEntry('sibling')],
    })));

    expect(result.current.activeTabId).toBe('work');
  });

  it('honors ?tab=architect:<name> deep-link', () => {
    window.history.replaceState({}, '', '/workspace/Vd29ya3NwYWNl/?tab=architect:sibling');
    const { result } = renderHook(() => useTabs(makeState({
      architects: [archEntry('main'), archEntry('sibling')],
    })));

    expect(result.current.activeTabId).toBe('architect:sibling');
    // URL parameter is cleaned up to avoid sticky behaviour on refresh
    expect(window.location.search).toBe('');
  });

  it('?tab=architect:<unknown> falls back to first architect tab', () => {
    window.history.replaceState({}, '', '/workspace/Vd29ya3NwYWNl/?tab=architect:ghost');
    const { result } = renderHook(() => useTabs(makeState({
      architects: [archEntry('main'), archEntry('sibling')],
    })));

    expect(result.current.activeTabId).toBe('architect');
  });

  it('?tab=architect still works (matches first architect by type)', () => {
    window.history.replaceState({}, '', '/workspace/Vd29ya3NwYWNl/?tab=architect');
    const { result } = renderHook(() => useTabs(makeState({
      architects: [archEntry('main'), archEntry('sibling')],
    })));

    expect(result.current.activeTabId).toBe('architect');
  });

  it('selectTab does NOT write localStorage from useTabs (App.tsx owns architect persistence)', () => {
    // Spec 761 (post Claude iter-1 review): persistence is App.tsx's
    // responsibility via the strip handler. useTabs.selectTab is symmetric
    // for all tab types: it only updates activeTabId.
    const { result } = renderHook(() => useTabs(makeState({
      architects: [archEntry('main'), archEntry('sibling')],
    })));

    act(() => {
      result.current.selectTab('architect:sibling');
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('auto-switches to a newly-added architect tab (skip removed)', () => {
    let stateRef = makeState({ architects: [archEntry('main')] });
    const { result, rerender } = renderHook(() => useTabs(stateRef));

    // Seed: with N=1 and no URL/localStorage, initial active should be 'work'.
    expect(result.current.activeTabId).toBe('work');

    // Add a second architect post-load — should auto-focus.
    stateRef = makeState({ architects: [archEntry('main'), archEntry('sibling')] });
    rerender();

    expect(result.current.activeTabId).toBe('architect:sibling');
  });
});
