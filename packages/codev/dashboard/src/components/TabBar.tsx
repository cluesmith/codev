import type { Tab } from '../hooks/useTabs.js';
import { deleteTab } from '../lib/api.js';

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onRefresh: () => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onRefresh }: TabBarProps) {
  const handleClose = async (e: React.MouseEvent, tab: Tab) => {
    e.stopPropagation();
    try {
      // Determine the API ID for deletion
      let deleteId: string;
      if (tab.type === 'shell' && tab.utilId) {
        deleteId = tab.utilId;
      } else if (tab.type === 'file' && tab.annotationId) {
        deleteId = tab.annotationId;
      } else if (tab.type === 'builder' && tab.projectId) {
        deleteId = tab.projectId;
      } else {
        return;
      }
      await deleteTab(deleteId);
      onRefresh();
    } catch (err) {
      console.error('Failed to close tab:', err);
    }
  };

  return (
    <div className="tab-bar" role="tablist" aria-label="Content tabs">
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
          {tab.closable && (
            <span
              className="tab-close"
              onClick={(e) => handleClose(e, tab)}
              role="button"
              aria-label={`Close ${tab.label}`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleClose(e as unknown as React.MouseEvent, tab);
                }
              }}
            >
              &times;
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
