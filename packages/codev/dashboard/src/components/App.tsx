import { useState, useEffect, useRef, useCallback } from 'react';
import { useBuilderStatus } from '../hooks/useBuilderStatus.js';
import { useTabs } from '../hooks/useTabs.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { MOBILE_BREAKPOINT } from '../lib/constants.js';
import { getTerminalWsPath, createFileTab } from '../lib/api.js';
import { SplitPane } from './SplitPane.js';
import { TabBar } from './TabBar.js';
import { Terminal } from './Terminal.js';
import { WorkView } from './WorkView.js';
import { MobileLayout } from './MobileLayout.js';
import { FileViewer } from './FileViewer.js';


export function App() {
  const { state, refresh } = useBuilderStatus();
  const { tabs, activeTab, activeTabId, selectTab } = useTabs(state);
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);

  // Bugfix #205: Track which terminal tabs have been visited at least once.
  // Terminals are only mounted on first visit, then kept alive (hidden via CSS)
  // to avoid WebSocket reconnection and ring-buffer replay on tab switches.
  const [activatedTerminals, setActivatedTerminals] = useState<Set<string>>(new Set());

  // Spec 0092: Store pending initial line numbers for file tabs (not persisted server-side)
  const pendingFileLinesRef = useRef<Map<string, number>>(new Map());

  // Spec 0092 + 0101: Handle file path clicks from terminal output
  const handleFileOpen = useCallback(async (path: string, line?: number, _column?: number, terminalId?: string) => {
    try {
      const result = await createFileTab(path, line, terminalId);
      // Store the line number for when FileViewer renders
      if (line && line > 0) {
        pendingFileLinesRef.current.set(result.id, line);
      }
      refresh();
      // useTabs will auto-select the new tab
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }, [refresh]);

  // Set document title with workspace name (no emoji - favicon provides the icon)
  useEffect(() => {
    if (state?.workspaceName) {
      document.title = `${state.workspaceName} Agent Farm`;
    } else {
      document.title = 'Agent Farm';
    }
  }, [state?.workspaceName]);

  // Check for fullscreen mode from URL — read synchronously to avoid a
  // layout switch (desktop → fullscreen) that unmounts/remounts Terminal
  // components, killing in-flight WebSocket handshakes.
  const [isFullscreen] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('fullscreen') === '1';
  });

  // Bugfix #205: Mark terminal tabs as activated when first selected
  useEffect(() => {
    if (!activeTab) return;
    const isTerminal = activeTab.type === 'architect' || activeTab.type === 'builder' || activeTab.type === 'shell';
    if (isTerminal) {
      setActivatedTerminals(prev => {
        if (prev.has(activeTab.id)) return prev;
        const next = new Set(prev);
        next.add(activeTab.id);
        return next;
      });
    }
  }, [activeTab?.id, activeTab?.type]);

  const renderTerminal = (tab: { type: string; terminalId?: string; persistent?: boolean }) => {
    const wsPath = getTerminalWsPath(tab);
    if (!wsPath) return <div className="no-terminal">No terminal session</div>;
    // Spec 0092: Pass file open handler for clickable file paths in terminal
    // Spec 0104: Pass persistent flag for shellper-backed session indicator
    return <Terminal wsPath={wsPath} onFileOpen={handleFileOpen} persistent={tab.persistent} />;
  };

  const renderAnnotation = (tab: { annotationId?: string; initialLine?: number }) => {
    if (!tab.annotationId || !state) return <div className="no-terminal">No file viewer</div>;
    const ann = state.annotations.find(a => a.id === tab.annotationId);
    if (!ann) return <div className="no-terminal">Annotation not found</div>;
    // Spec 0092: Check for pending line number from terminal file link click
    const pendingLine = pendingFileLinesRef.current.get(tab.annotationId);
    if (pendingLine !== undefined) {
      // Clear after reading (one-time deep link)
      pendingFileLinesRef.current.delete(tab.annotationId);
    }
    return <FileViewer tabId={tab.annotationId} initialLine={pendingLine ?? tab.initialLine} />;
  };

  // Bugfix #205: Render persistent terminal tabs (kept mounted, shown/hidden via CSS)
  // plus the active non-terminal content. terminalTypes specifies which tab types
  // to persist (desktop right panel excludes 'architect' since it's in the left pane).
  const renderPersistentContent = (terminalTypes: string[]) => {
    const persistentTabs = tabs.filter(t =>
      terminalTypes.includes(t.type) && activatedTerminals.has(t.id)
    );

    return (
      <>
        {persistentTabs.map(tab => {
          const wsPath = getTerminalWsPath(tab);
          return (
            <div
              key={tab.id}
              className="terminal-tab-pane"
              style={{ display: activeTabId === tab.id ? undefined : 'none' }}
            >
              {wsPath
                ? <Terminal wsPath={wsPath} onFileOpen={handleFileOpen} persistent={tab.persistent} />
                : <div className="no-terminal">No terminal session</div>
              }
            </div>
          );
        })}
        <div style={{ display: activeTab?.type === 'work' ? undefined : 'none' }}>
          <WorkView state={state} onRefresh={refresh} onSelectTab={selectTab} />
        </div>
        {activeTab?.type === 'file' && renderAnnotation(activeTab)}
      </>
    );
  };

  // Fullscreen mode: show only the active terminal, no chrome.
  // Render nothing until the correct tab is selected to avoid a brief
  // desktop-layout render that mounts a Terminal (creating a WebSocket)
  // only to unmount it one frame later when activeTabId switches,
  // killing the WebSocket before its handshake completes.
  if (isFullscreen) {
    if (activeTab && (activeTab.type === 'architect' || activeTab.type === 'builder' || activeTab.type === 'shell')) {
      return (
        <div className="fullscreen-terminal">
          {renderTerminal(activeTab)}
        </div>
      );
    }
    // Waiting for tab selection — render empty container to avoid layout flash
    return <div className="fullscreen-terminal" />;
  }

  if (isMobile) {
    return (
      <div className="mobile-wrapper">
        <MobileLayout
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={selectTab}
          onRefresh={refresh}
        >
          {renderPersistentContent(['architect', 'builder', 'shell'])}
        </MobileLayout>
      </div>
    );
  }

  // Desktop: architect terminal on left, tabbed content on right
  const architectTab = tabs.find(t => t.type === 'architect');
  const leftPane = architectTab
    ? renderTerminal(architectTab)
    : <div className="no-architect">No architect terminal</div>;

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">Agent Farm</h1>
        <div className="header-meta">
          <span className="builder-count">
            {state?.builders?.length ?? 0} builder(s)
          </span>
        </div>
      </header>
      <div className="app-body">
        <SplitPane
          left={leftPane}
          right={
            <div className="right-panel">
              <TabBar
                tabs={tabs.filter(t => t.type !== 'architect')}
                activeTabId={activeTabId}
                onSelectTab={selectTab}
                onRefresh={refresh}
              />
              <div className="tab-content" role="tabpanel">
                {renderPersistentContent(['builder', 'shell'])}
              </div>
            </div>
          }
        />
      </div>
      <footer className="status-bar">
        <span>{state?.builders?.length ?? 0} builders</span>
        <span>{state?.utils?.length ?? 0} shells</span>
        <span>{state?.annotations?.length ?? 0} files</span>
      </footer>
    </div>
  );
}
