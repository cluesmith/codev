import { useState, useCallback, useEffect, useRef } from 'react';
import type { DashboardState, Builder, UtilTerminal, Annotation } from '../lib/api.js';

export interface Tab {
  id: string;
  type: 'dashboard' | 'files' | 'architect' | 'builder' | 'shell' | 'file' | 'activity';
  label: string;
  closable: boolean;
  terminalId?: string;
  projectId?: string;
  utilId?: string;
  annotationId?: string;
  filePath?: string;
}

function buildTabs(state: DashboardState | null): Tab[] {
  const tabs: Tab[] = [
    { id: 'dashboard', type: 'dashboard', label: 'Dashboard', closable: false },
  ];

  if (state?.architect) {
    tabs.push({ id: 'architect', type: 'architect', label: 'Architect', closable: false, terminalId: state.architect.terminalId });
  }

  for (const builder of state?.builders ?? []) {
    tabs.push({
      id: `builder-${builder.id}`,
      type: 'builder',
      label: builder.name || `Builder ${builder.id}`,
      closable: true,
      projectId: builder.id,
      terminalId: builder.terminalId,
    });
  }

  for (const util of state?.utils ?? []) {
    // Skip stale utils with no running process and no terminal session
    if (!util.terminalId && (!util.pid || util.pid === 0)) continue;
    tabs.push({
      id: `shell-${util.id}`,
      type: 'shell',
      label: util.name || `Shell ${util.id}`,
      closable: true,
      utilId: util.id,
      terminalId: util.terminalId,
    });
  }

  for (const ann of state?.annotations ?? []) {
    const fileName = ann.file.split('/').pop() ?? ann.file;
    tabs.push({
      id: `file-${ann.id}`,
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
  const [activeTabId, setActiveTabId] = useState<string>('dashboard');
  const knownTabIds = useRef<Set<string> | null>(null);
  const urlTabHandled = useRef(false);
  const tabs = buildTabs(state);

  // Handle URL ?tab= parameter on initial load (for deep linking from tower)
  useEffect(() => {
    if (urlTabHandled.current || state === null) return;

    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get('tab');

    if (tabParam) {
      // Find matching tab by id or type
      const matchingTab = tabs.find(t => t.id === tabParam || t.type === tabParam);
      if (matchingTab) {
        setActiveTabId(matchingTab.id);
        urlTabHandled.current = true;
        // Clean up URL to avoid sticky behavior on refresh
        const url = new URL(window.location.href);
        url.searchParams.delete('tab');
        window.history.replaceState({}, '', url.toString());
      }
    } else {
      urlTabHandled.current = true;
    }
  }, [tabs, state]);

  // Auto-switch to genuinely new tabs (created after page load).
  // Wait for real state (non-null) before seeding known tabs — otherwise the
  // empty first render seeds with just ['dashboard'], and the second render
  // (with actual state) treats all existing tabs as "new" and auto-selects them.
  useEffect(() => {
    const currentIds = new Set(tabs.map(t => t.id));
    if (knownTabIds.current === null) {
      // Only seed once we have real tabs (more than just dashboard)
      if (state !== null) {
        knownTabIds.current = currentIds;
      }
      return;
    }
    for (const tab of tabs) {
      if (!knownTabIds.current.has(tab.id) && tab.type !== 'architect') {
        // Genuinely new tab appeared — switch to it
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
