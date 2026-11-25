import type { FilePanelState } from '@cluesmith/codev-workspace-views';
import { FileTree } from './FileTree.js';

interface WorkFilePanelProps extends FilePanelState {
  onRefresh: () => void;
}

/**
 * The Work tab's collapsible Files panel: the dashboard's slot in the shared Work view, which keeps
 * its open state. Dashboard only; VS Code's Explorer is the equivalent there.
 */
export function WorkFilePanel({ open, setOpen, onRefresh }: WorkFilePanelProps) {
  return (
    <div className={`work-file-panel ${open ? 'expanded' : 'collapsed'}`}>
      <div className="work-file-panel-header">
        <span
          className="work-file-panel-toggle"
          onClick={() => setOpen(!open)}
        >
          {open ? '▼' : '▲'}
        </span>
        <span
          className="work-file-panel-label"
          onClick={() => setOpen(!open)}
        >
          Files
        </span>
        {!open && (
          <input
            className="work-file-panel-search"
            type="text"
            placeholder="Search files..."
            onFocus={() => setOpen(true)}
          />
        )}
      </div>
      {open && (
        <div className="work-file-panel-content">
          <FileTree onRefresh={onRefresh} />
        </div>
      )}
    </div>
  );
}
