import type { Tab } from '../hooks/useTabs.js';

/**
 * Spec 761: a small tab strip shown inside the left pane of the dashboard
 * when more than one architect is registered. Reuses the same `tab` and
 * `tab-active` CSS classes as the right-pane `TabBar` for visual
 * consistency. Architect tabs are not closable.
 */
interface ArchitectTabStripProps {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
}

export function ArchitectTabStrip({ tabs, activeTabId, onSelectTab }: ArchitectTabStripProps) {
  return (
    <div className="architect-tab-strip tab-bar" role="tablist" aria-label="Architect tabs">
      {tabs.map(tab => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeTabId}
          className={`tab ${tab.id === activeTabId ? 'tab-active' : ''}`}
          onClick={() => onSelectTab(tab.id)}
          title={tab.label}
        >
          <span className="tab-label">{tab.label}</span>
        </button>
      ))}
    </div>
  );
}
