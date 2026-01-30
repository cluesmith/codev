import { useState, useCallback, useEffect, useRef } from 'react';
import type { DashboardState, Builder, UtilTerminal, Annotation } from '../lib/api.js';

export interface Tab {
  id: string;
  type: 'dashboard' | 'files' | 'architect' | 'builder' | 'shell' | 'file' | 'activity';
  label: string;
  closable: boolean;
  projectId?: string;
  utilId?: string;
  annotationId?: string;
  filePath?: string;
}

function buildTabs(state: DashboardState | null): Tab[] {
  const tabs: Tab[] = [
    { id: 'dashboard', type: 'dashboard', label: 'Dashboard', closable: false },
    { id: 'files', type: 'files', label: 'Files', closable: false },
  ];

  if (state?.architect) {
    tabs.push({ id: 'architect', type: 'architect', label: 'Architect', closable: false });
  }

  for (const builder of state?.builders ?? []) {
    tabs.push({
      id: `builder-${builder.id}`,
      type: 'builder',
      label: builder.name || `Builder ${builder.id}`,
      closable: true,
      projectId: builder.id,
    });
  }

  for (const util of state?.utils ?? []) {
    tabs.push({
      id: `shell-${util.id}`,
      type: 'shell',
      label: util.name || `Shell ${util.id}`,
      closable: true,
      utilId: util.id,
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
  const knownTabIds = useRef<Set<string>>(new Set());
  const tabs = buildTabs(state);

  // Auto-switch to new tabs
  useEffect(() => {
    const currentIds = new Set(tabs.map(t => t.id));
    for (const tab of tabs) {
      if (!knownTabIds.current.has(tab.id)) {
        // New tab appeared — switch to it
        setActiveTabId(tab.id);
      }
    }
    knownTabIds.current = currentIds;
  }, [tabs.map(t => t.id).join(',')]);

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];

  return { tabs, activeTab, activeTabId, selectTab };
}
