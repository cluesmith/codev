import { useState, useCallback, useEffect, useRef } from 'react';
import type { DashboardState, ArchitectState } from '../lib/api.js';

export interface Tab {
  id: string;
  type: 'work' | 'files' | 'architect' | 'builder' | 'shell' | 'file' | 'activity' | 'analytics' | 'team';
  label: string;
  closable: boolean;
  terminalId?: string;
  projectId?: string;
  utilId?: string;
  annotationId?: string;
  filePath?: string;
  persistent?: boolean;
  /**
   * Spec 761: the architect's stable name (when type === 'architect').
   * Carries the architect identity independently of the tab `id`/`label`,
   * so consumers (deep-link parsing, localStorage persistence) don't need
   * to parse it out of the `id` string.
   */
  architectName?: string;
}

/**
 * Spec 761: derive the tab `id` for an architect entry.
 *
 * The first architect (always `architects[0]`, which is `main` when
 * present per Phase 1's ordering) keeps the bare `'architect'` id so the
 * single-architect dashboard DOM is identical to the pre-761 baseline AND
 * `main`'s id is stable across the N=1 ↔ N>1 transition. Subsequent
 * architects use `architect:<name>` ids.
 */
function architectTabId(index: number, name: string): string {
  return index === 0 ? 'architect' : `architect:${name}`;
}

function buildArchitectTabs(state: DashboardState | null): Tab[] {
  // Prefer the new `architects` collection; fall back to the scalar
  // `architect` (wrapped as a one-element array) for any momentary deploy-
  // window where dashboard.js is newer than the server response.
  const architects: ArchitectState[] = state?.architects
    ?? (state?.architect ? [state.architect] : []);
  return architects.map((a, index) => {
    // Deploy-window safety: scalar architect from an older server response
    // may lack `name`. Default to 'main' so the label and architectName are
    // never undefined.
    const name = a.name ?? 'main';
    return {
      id: architectTabId(index, name),
      type: 'architect' as const,
      label: name,
      closable: false,
      terminalId: a.terminalId,
      persistent: a.persistent,
      architectName: name,
    };
  });
}

function buildTabs(state: DashboardState | null): Tab[] {
  const tabs: Tab[] = [
    { id: 'work', type: 'work', label: 'Work', closable: false },
    { id: 'analytics', type: 'analytics', label: 'Analytics', closable: false, persistent: true },
  ];

  if (state?.teamEnabled) {
    tabs.push({ id: 'team', type: 'team', label: 'Team', closable: false });
  }

  tabs.push(...buildArchitectTabs(state));

  for (const builder of state?.builders ?? []) {
    tabs.push({
      id: builder.id,
      type: 'builder',
      label: builder.name || builder.id,
      closable: true,
      projectId: builder.id,
      terminalId: builder.terminalId,
      persistent: builder.persistent,
    });
  }

  for (const util of state?.utils ?? []) {
    // Skip stale utils with no running process and no terminal session
    if (!util.terminalId && (!util.pid || util.pid === 0)) continue;
    tabs.push({
      id: util.id,
      type: 'shell',
      label: util.name || `Shell ${util.id}`,
      closable: true,
      utilId: util.id,
      terminalId: util.terminalId,
      persistent: util.persistent,
    });
  }

  for (const ann of state?.annotations ?? []) {
    const fileName = ann.file.split('/').pop() ?? ann.file;
    tabs.push({
      id: ann.id,
      type: 'file',
      label: fileName,
      closable: true,
      annotationId: ann.id,
      filePath: ann.file,
    });
  }

  return tabs;
}

export function useTabs(state: DashboardState | null) {
  const [activeTabId, setActiveTabId] = useState<string>('work');
  const knownTabIds = useRef<Set<string> | null>(null);
  const urlTabHandled = useRef(false);
  const tabs = buildTabs(state);

  // Handle URL ?tab= parameter on initial load (for deep linking from tower).
  //
  // Spec 761: this hook deliberately does NOT restore the persisted active
  // architect into `activeTabId`. Restoring it would cause the desktop right
  // pane to blank on reload (every right-pane content section checks
  // `activeTab?.type === 'work'`/etc., all of which are false when an
  // architect tab is active). The desktop left-pane architect selection
  // lives in App.tsx, which reads localStorage independently. The mobile
  // tradeoff is small: on reload, the active tab defaults to `'work'`
  // rather than restoring the previously-viewed architect.
  useEffect(() => {
    if (urlTabHandled.current || state === null) return;

    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get('tab');

    if (tabParam) {
      // Spec 761: handle the architect:<name> deep-link form. If the named
      // architect isn't registered, fall back to the first architect tab
      // (matches the bare ?tab=architect behaviour for graceful degradation).
      if (tabParam.startsWith('architect:')) {
        const name = tabParam.slice('architect:'.length);
        const archTab = tabs.find(t => t.type === 'architect' && t.architectName === name)
          ?? tabs.find(t => t.type === 'architect');
        if (archTab) {
          setActiveTabId(archTab.id);
          urlTabHandled.current = true;
          const url = new URL(window.location.href);
          url.searchParams.delete('tab');
          window.history.replaceState({}, '', url.toString());
          return;
        }
      }
      const matchingTab = tabs.find(t => t.id === tabParam || t.type === tabParam);
      if (matchingTab) {
        setActiveTabId(matchingTab.id);
        urlTabHandled.current = true;
        const url = new URL(window.location.href);
        url.searchParams.delete('tab');
        window.history.replaceState({}, '', url.toString());
        return;
      }
    }
    urlTabHandled.current = true;
  }, [tabs, state]);

  // Auto-switch to genuinely new tabs (created after page load).
  // Wait for real state (non-null) before seeding known tabs — otherwise the
  // empty first render seeds with just ['work'], and the second render
  // (with actual state) treats all existing tabs as "new" and auto-selects them.
  //
  // Spec 761: the previous skip condition `tab.type !== 'architect'` was
  // removed so newly-added architects (via `afx workspace add-architect`)
  // auto-focus the same way newly-spawned builders do today. The seed-on-
  // non-null-state pattern below still suppresses focus theft on initial load.
  useEffect(() => {
    const currentIds = new Set(tabs.map(t => t.id));
    if (knownTabIds.current === null) {
      if (state !== null) {
        knownTabIds.current = currentIds;
      }
      return;
    }
    for (const tab of tabs) {
      if (!knownTabIds.current.has(tab.id)) {
        setActiveTabId(tab.id);
      }
    }
    knownTabIds.current = currentIds;
  }, [tabs.map(t => t.id).join(','), state !== null]);

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  return { tabs, activeTab, activeTabId, selectTab };
}
