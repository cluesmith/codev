import type { Tab } from '../hooks/useTabs.js';
import { TabBar } from './TabBar.js';

interface MobileLayoutProps {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onRefresh: () => void;
  children: React.ReactNode;
}

/** Single-pane layout for mobile (<768px). */
export function MobileLayout({ tabs, activeTabId, onSelectTab, onRefresh, children }: MobileLayoutProps) {
  return (
    <div className="mobile-layout">
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={onSelectTab}
        onRefresh={onRefresh}
      />
      <div className="mobile-content">
        {children}
      </div>
    </div>
  );
}
