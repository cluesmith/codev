import { useState, useEffect, useRef, useCallback } from 'react';
import { useBuilderStatus } from '../hooks/useBuilderStatus.js';
import { useTabs } from '../hooks/useTabs.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { MOBILE_BREAKPOINT } from '../lib/constants.js';
import { getTerminalWsPath, createFileTab } from '../lib/api.js';
import { SplitPane } from './SplitPane.js';
import { TabBar } from './TabBar.js';
import { Terminal } from './Terminal.js';
import { StatusPanel } from './StatusPanel.js';
import { MobileLayout } from './MobileLayout.js';
import { FileViewer } from './FileViewer.js';

export function App() {
  const { state, refresh } = useBuilderStatus();
  const { tabs, activeTab, activeTabId, selectTab } = useTabs(state);
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);

  // Spec 0092: Store pending initial line numbers for file tabs (not persisted server-side)
  const pendingFileLinesRef = useRef<Map<string, number>>(new Map());

  // Spec 0092: Handle file path clicks from terminal output
  const handleFileOpen = useCallback(async (path: string, line?: number, _column?: number) => {
    try {
      const result = await createFileTab(path, line);
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

  // Set document title with project name (no emoji - favicon provides the icon)
  useEffect(() => {
    if (state?.projectName) {
      document.title = `${state.projectName} Agent Farm`;
    } else {
      document.title = 'Agent Farm';
    }
  }, [state?.projectName]);

  // Check for fullscreen mode from URL
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    setIsFullscreen(urlParams.get('fullscreen') === '1');
  }, []);

  const renderTerminal = (tab: { type: string; terminalId?: string }) => {
    const wsPath = getTerminalWsPath(tab);
    if (!wsPath) return <div className="no-terminal">No terminal session</div>;
    // Spec 0092: Pass file open handler for clickable file paths in terminal
    return <Terminal wsPath={wsPath} onFileOpen={handleFileOpen} />;
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

  const renderContent = () => {
    if (!activeTab) return null;

    switch (activeTab.type) {
      case 'dashboard':
        return <StatusPanel state={state} onRefresh={refresh} onSelectTab={selectTab} />;
      case 'architect':
      case 'builder':
      case 'shell':
        return renderTerminal(activeTab);
      case 'file':
        return renderAnnotation(activeTab);
      default:
        return <div>Unknown tab type</div>;
    }
  };

  // Fullscreen mode: show only the active terminal, no chrome
  if (isFullscreen && activeTab && (activeTab.type === 'architect' || activeTab.type === 'builder' || activeTab.type === 'shell')) {
    return (
      <div className="fullscreen-terminal">
        {renderTerminal(activeTab)}
      </div>
    );
  }

  if (isMobile) {
    return (
      <MobileLayout
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={selectTab}
        onRefresh={refresh}
      >
        {renderContent()}
      </MobileLayout>
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
                {renderContent()}
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
