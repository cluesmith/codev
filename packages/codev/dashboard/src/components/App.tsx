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
import { AnalyticsView } from './AnalyticsView.js';


/** Spec 443: Build the overview title string with optional hostname. */
export function buildOverviewTitle(hostname?: string, workspaceName?: string): string {
  const h = hostname?.trim();
  const w = workspaceName?.trim();
  if (h && w && h.toLowerCase() !== w.toLowerCase()) {
    return `${w} on ${h} overview`;
  }
  if (w) {
    return `${w} overview`;
  }
  return 'overview';
}

export function App() {
  const { state, refresh } = useBuilderStatus();
  const { tabs, activeTab, activeTabId, selectTab } = useTabs(state);
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);
  const [collapsedPane, setCollapsedPane] = useState<'left' | 'right' | null>(null);

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

  // Spec 443: Build display title with hostname prefix
  const overviewTitle = buildOverviewTitle(state?.hostname, state?.workspaceName);

  // Set document title with hostname + workspace name (no emoji - favicon provides the icon)
  useEffect(() => {
    document.title = overviewTitle;
  }, [overviewTitle]);

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
        <div style={{ display: activeTab?.type === 'work' ? undefined : 'none', height: '100%' }}>
          <WorkView state={state} onRefresh={refresh} onSelectTab={selectTab} />
        </div>
        <div style={{ display: activeTab?.type === 'analytics' ? undefined : 'none', height: '100%' }}>
          <AnalyticsView isActive={activeTab?.type === 'analytics'} />
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

  // Bugfix #522: Collapse/expand buttons consolidated into architect toolbar.
  // Uses onPointerDown+preventDefault to avoid stealing xterm focus on clicks,
  // with onClick for keyboard activation (Enter/Space). No tabIndex={-1} so
  // buttons remain keyboard-reachable (CMAP review feedback).
  const architectToolbarExtra = (
    <>
      {collapsedPane !== 'left' ? (
        <button
          className="terminal-control-btn"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setCollapsedPane('left')}
          title="Collapse architect panel"
          aria-label="Collapse architect panel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="2" x2="3" y2="14" />
            <path d="M12 5l-4 3 4 3" />
          </svg>
        </button>
      ) : (
        <button
          className="terminal-control-btn"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setCollapsedPane(null)}
          title="Expand architect panel"
          aria-label="Expand architect panel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="2" x2="3" y2="14" />
            <path d="M7 5l4 3-4 3" />
          </svg>
        </button>
      )}
      {collapsedPane !== 'right' ? (
        <button
          className="terminal-control-btn"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setCollapsedPane('right')}
          title="Collapse work panel"
          aria-label="Collapse work panel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="13" y1="2" x2="13" y2="14" />
            <path d="M4 5l4 3-4 3" />
          </svg>
        </button>
      ) : (
        <button
          className="terminal-control-btn"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setCollapsedPane(null)}
          title="Expand work panel"
          aria-label="Expand work panel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="13" y1="2" x2="13" y2="14" />
            <path d="M9 5l-4 3 4 3" />
          </svg>
        </button>
      )}
    </>
  );

  const architectWsPath = architectTab ? getTerminalWsPath(architectTab) : null;
  const leftPane = architectWsPath
    ? <Terminal wsPath={architectWsPath} onFileOpen={handleFileOpen} persistent={architectTab!.persistent} toolbarExtra={architectToolbarExtra} />
    : <div className="no-architect">No architect terminal</div>;

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">
          {overviewTitle}
        </h1>
        <div className="header-controls">
          {/* Bugfix #522: Expand button shown in header only when architect panel is collapsed */}
          {collapsedPane === 'left' && (
            <button
              className="header-btn"
              onClick={() => setCollapsedPane(null)}
              title="Expand architect panel"
              aria-label="Expand architect panel"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="2" x2="3" y2="14" />
                <path d="M7 5l4 3-4 3" />
              </svg>
            </button>
          )}
          {state?.version && <span className="header-version">v{state.version}</span>}
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
          collapsedPane={collapsedPane}
        />
      </div>
    </div>
  );
}
