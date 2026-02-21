import type { Tab } from '../hooks/useTabs.js';
import { deleteTab } from '../lib/api.js';

export const TAB_ICONS: Record<Tab['type'], string> = {
  work: '\u25C8',            // ◈
  architect: '\u25B6\uFE0E', // ▶︎ (text presentation)
  builder: '\u2692\uFE0E',   // ⚒︎ (text presentation)
  shell: '$',                 // $
  file: '\u2261',             // ≡
  activity: '\u26A1\uFE0E',  // ⚡︎ (text presentation)
  files: '\u2630',            // ☰
};

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
      // Server expects the full prefixed ID (shell-<id>, builder-<id>, file-<id>)
      await deleteTab(tab.id);
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
          <span className="tab-icon" aria-hidden="true">{TAB_ICONS[tab.type]}</span>
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
