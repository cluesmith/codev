import { useBuilderStatus } from '../hooks/useBuilderStatus.js';
import { useTabs } from '../hooks/useTabs.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { MOBILE_BREAKPOINT } from '../lib/constants.js';
import { getTerminalWsPath } from '../lib/api.js';
import { SplitPane } from './SplitPane.js';
import { TabBar } from './TabBar.js';
import { Terminal } from './Terminal.js';
import { StatusPanel } from './StatusPanel.js';
import { FileTree } from './FileTree.js';
import { MobileLayout } from './MobileLayout.js';

export function App() {
  const { state, refresh } = useBuilderStatus();
  const { tabs, activeTab, activeTabId, selectTab } = useTabs(state);
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);

  const renderTerminal = (tab: { type: string; terminalId?: string }) => {
    const wsPath = getTerminalWsPath(tab);
    if (!wsPath) return <div className="no-terminal">No terminal session</div>;
    return <Terminal wsPath={wsPath} />;
  };

  const renderContent = () => {
    if (!activeTab) return null;

    switch (activeTab.type) {
      case 'dashboard':
        return <StatusPanel state={state} onRefresh={refresh} />;
      case 'files':
        return <FileTree onRefresh={refresh} />;
      case 'architect':
      case 'builder':
      case 'shell':
      case 'file':
        return renderTerminal(activeTab);
      default:
        return <div>Unknown tab type</div>;
    }
  };

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
                tabs={tabs}
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
