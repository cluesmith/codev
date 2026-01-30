import type { DashboardState } from '../lib/api.js';
import { BuilderCard } from './BuilderCard.js';
import { createShellTab } from '../lib/api.js';

interface StatusPanelProps {
  state: DashboardState | null;
  onRefresh: () => void;
}

export function StatusPanel({ state, onRefresh }: StatusPanelProps) {
  if (!state) {
    return <div className="status-panel">Loading...</div>;
  }

  const handleNewShell = async () => {
    try {
      await createShellTab();
      onRefresh();
    } catch (err) {
      console.error('Failed to create shell:', err);
    }
  };

  const builders = state.builders ?? [];
  const shells = state.utils ?? [];
  const files = state.annotations ?? [];

  return (
    <div className="status-panel">
      <div className="status-section">
        <h3 className="section-header">
          Builders ({builders.length})
        </h3>
        {builders.length === 0 ? (
          <p className="empty-message">No builders spawned</p>
        ) : (
          <div className="builder-list">
            {builders.map(b => (
              <BuilderCard key={b.id} builder={b} />
            ))}
          </div>
        )}
      </div>

      <div className="status-section">
        <h3 className="section-header">
          Shells ({shells.length})
          <button className="btn-small" onClick={handleNewShell}>+ New Shell</button>
        </h3>
        {shells.length === 0 ? (
          <p className="empty-message">No shell tabs open</p>
        ) : (
          <ul className="item-list">
            {shells.map(s => (
              <li key={s.id} className="item-entry">{s.name}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="status-section">
        <h3 className="section-header">
          Files ({files.length})
        </h3>
        {files.length === 0 ? (
          <p className="empty-message">No file tabs open</p>
        ) : (
          <ul className="item-list">
            {files.map(f => (
              <li key={f.id} className="item-entry">{f.file.split('/').pop()}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
