/**
 * Spec 1819 Phase 4: the Decisions tab in useTabs — present with
 * `decisionsEnabled`, absent without it, and sticky for the page session once shown.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DashboardState } from '@cluesmith/codev-types';
import { useTabs } from '../src/hooks/useTabs.js';

function makeState(overrides: Partial<DashboardState>): DashboardState {
  return {
    architect: null,
    architects: [{ name: 'main', port: 0, pid: 1, terminalId: 'term-main', persistent: false }],
    builders: [],
    utils: [],
    annotations: [],
    ...overrides,
  };
}

beforeEach(() => {
  window.history.replaceState({}, '', '/workspace/Vd29ya3NwYWNl/');
});

describe('useTabs — Decisions tab (Spec 1819)', () => {
  it('shows a non-closable Decisions tab when the workspace has the decisions file', () => {
    const { result } = renderHook(() => useTabs(makeState({ decisionsEnabled: true })));
    const tab = result.current.tabs.find(t => t.type === 'decisions');
    expect(tab).toEqual({ id: 'decisions', type: 'decisions', label: 'Decisions', closable: false });
  });

  it('shows no Decisions tab when the flag is false or absent', () => {
    for (const state of [makeState({ decisionsEnabled: false }), makeState({}), null]) {
      const { result } = renderHook(() => useTabs(state));
      expect(result.current.tabs.some(t => t.type === 'decisions')).toBe(false);
    }
  });

  // Issue #1861: Decisions is second, right after Work, ahead of Analytics and Team.
  it.each([
    { decisionsEnabled: true, teamEnabled: true, order: ['work', 'decisions', 'analytics', 'team', 'architect'] },
    { decisionsEnabled: true, teamEnabled: false, order: ['work', 'decisions', 'analytics', 'architect'] },
    { decisionsEnabled: false, teamEnabled: true, order: ['work', 'analytics', 'team', 'architect'] },
    { decisionsEnabled: false, teamEnabled: false, order: ['work', 'analytics', 'architect'] },
  ])('orders the fixed tabs with decisions=$decisionsEnabled, team=$teamEnabled', ({ decisionsEnabled, teamEnabled, order }) => {
    const { result } = renderHook(() => useTabs(makeState({ decisionsEnabled, teamEnabled })));
    expect(result.current.tabs.map(t => t.id)).toEqual(order);
  });

  it('keeps the tab, and the selection, when the flag goes false after it was shown', () => {
    const { result, rerender } = renderHook(({ state }) => useTabs(state), {
      initialProps: { state: makeState({ decisionsEnabled: true }) },
    });
    act(() => result.current.selectTab('decisions'));
    expect(result.current.activeTab.id).toBe('decisions');

    rerender({ state: makeState({ decisionsEnabled: false }) });
    expect(result.current.tabs.some(t => t.type === 'decisions')).toBe(true);
    expect(result.current.activeTab.id).toBe('decisions');
  });

  it('adds the tab when the file appears after page load', () => {
    const { result, rerender } = renderHook(({ state }) => useTabs(state), {
      initialProps: { state: makeState({ decisionsEnabled: false }) },
    });
    expect(result.current.tabs.some(t => t.type === 'decisions')).toBe(false);
    rerender({ state: makeState({ decisionsEnabled: true }) });
    expect(result.current.tabs.some(t => t.type === 'decisions')).toBe(true);
  });

  it('starts without the tab on a fresh mount (a reload) of a workspace without the file', () => {
    const first = renderHook(() => useTabs(makeState({ decisionsEnabled: true })));
    expect(first.result.current.tabs.some(t => t.type === 'decisions')).toBe(true);
    first.unmount();

    const reloaded = renderHook(() => useTabs(makeState({ decisionsEnabled: false })));
    expect(reloaded.result.current.tabs.some(t => t.type === 'decisions')).toBe(false);
  });

  it('selects the tab from a ?tab=decisions deep link', () => {
    window.history.replaceState({}, '', '/workspace/Vd29ya3NwYWNl/?tab=decisions');
    const { result } = renderHook(() => useTabs(makeState({ decisionsEnabled: true })));
    expect(result.current.activeTab.id).toBe('decisions');
  });
});
