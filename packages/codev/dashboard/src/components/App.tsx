import { useState, useEffect } from 'react';
import { useBuilderStatus } from '../hooks/useBuilderStatus.js';
import { useTabs } from '../hooks/useTabs.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { MOBILE_BREAKPOINT, getApiBase } from '../lib/constants.js';
import { getTerminalWsPath } from '../lib/api.js';
import { SplitPane } from './SplitPane.js';
import { TabBar } from './TabBar.js';
import { Terminal } from './Terminal.js';
import { StatusPanel } from './StatusPanel.js';
import { MobileLayout } from './MobileLayout.js';

export function App() {
  const { state, refresh } = useBuilderStatus();
  const { tabs, activeTab, activeTabId, selectTab } = useTabs(state);
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);

  // Check for fullscreen mode from URL
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    setIsFullscreen(urlParams.get('fullscreen') === '1');
  }, []);

  const renderTerminal = (tab: { type: string; terminalId?: string }) => {
    const wsPath = getTerminalWsPath(tab);
    if (!wsPath) return <div className="no-terminal">No terminal session</div>;
    return <Terminal wsPath={wsPath} />;
  };

  const renderAnnotation = (tab: { annotationId?: string }) => {
    if (!tab.annotationId || !state) return <div className="no-terminal">No file viewer</div>;
    const ann = state.annotations.find(a => a.id === tab.annotationId);
    if (!ann) return <div className="no-terminal">Annotation not found</div>;
    const src = `${getApiBase()}annotation/${ann.id}/`;
    return (
      <iframe
        src={src}
        className="terminal-iframe"
        style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#1a1a1a' }}
        title={`File: ${ann.file}`}
        allow="clipboard-read; clipboard-write"
      />
    );
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
