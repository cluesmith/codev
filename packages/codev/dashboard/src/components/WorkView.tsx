import { useState, useCallback } from 'react';
import { useOverview } from '../hooks/useOverview.js';
import { createShellTab } from '../lib/api.js';
import type { OverviewBuilder, DashboardState } from '../lib/api.js';
import { BuilderCard } from './BuilderCard.js';
import { NeedsAttentionList } from './NeedsAttentionList.js';
import { BacklogList } from './BacklogList.js';
import { RecentlyClosedList } from './RecentlyClosedList.js';
import { FileTree } from './FileTree.js';
import { TipBanner } from './TipBanner.js';

interface WorkViewProps {
  state: DashboardState | null;
  onRefresh: () => void;
  onSelectTab?: (id: string) => void;
}

export function WorkView({ state, onRefresh, onSelectTab }: WorkViewProps) {
  const { data: overview, error: overviewError, refresh: refreshOverview } = useOverview();
  const [filePanelOpen, setFilePanelOpen] = useState(false);

  const handleNewShell = useCallback(async () => {
    try {
      await createShellTab();
      onRefresh();
    } catch (err) {
      console.error('Failed to create shell:', err);
    }
  }, [onRefresh]);

  const handleOpenBuilder = useCallback((builder: OverviewBuilder) => {
    // Find matching builder terminal tab by issue number or ID
    const builderTab = state?.builders?.find(b => {
      // Match by project ID in the terminal state
      if (builder.issueNumber) {
        return b.name?.includes(String(builder.issueNumber)) || b.id?.includes(String(builder.issueNumber));
      }
      return b.id?.includes(builder.id) || b.name?.includes(builder.id);
    });
    if (builderTab) {
      onSelectTab?.(builderTab.id);
    }
  }, [state?.builders, onSelectTab]);

  if (!state) {
    return (
      <div className="work-view">
        <p className="work-loading">Loading...</p>
      </div>
    );
  }

  return (
    <div className={`work-view ${filePanelOpen ? 'file-panel-open' : ''}`}>
      <div className="work-content">
        <div className="work-header">
          <h2 className="work-title">Work</h2>
          <div className="work-actions">
            <button className="work-btn" onClick={handleNewShell}>+ Shell</button>
            <button className="work-btn work-btn-secondary" onClick={refreshOverview}>Refresh</button>
          </div>
        </div>

        {overviewError && (
          <div className="work-error">Failed to load overview: {overviewError}</div>
        )}

        <TipBanner />

        {/* Active Builders */}
        <section className="work-section">
          <h3 className="work-section-title">Builders</h3>
          {overview?.builders && overview.builders.length > 0 ? (
            <table className="builder-table">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Title</th>
                  <th>State</th>
                  <th>Progress</th>
                  <th>Elapsed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {overview.builders.map(builder => (
                  <BuilderCard
                    key={builder.id}
                    builder={builder}
                    onOpen={handleOpenBuilder}
                  />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="work-empty">No active builders</p>
          )}
        </section>

        {/* Needs Attention */}
        <section className="work-section">
          <h3 className="work-section-title">Needs Attention</h3>
          {overview?.errors?.prs ? (
            <p className="work-unavailable">{overview.errors.prs}</p>
          ) : (
            <NeedsAttentionList
              prs={overview?.pendingPRs ?? []}
              builders={overview?.builders ?? []}
            />
          )}
        </section>

        {/* Backlog & Bugs */}
        <section className="work-section">
          <h3 className="work-section-title">Projects and Bugs</h3>
          {overview?.errors?.issues ? (
            <p className="work-unavailable">{overview.errors.issues}</p>
          ) : (
            <BacklogList items={overview?.backlog ?? []} onRefresh={onRefresh} />
          )}
        </section>

        {/* Recently Closed */}
        {overview?.recentlyClosed && overview.recentlyClosed.length > 0 && (
          <section className="work-section">
            <h3 className="work-section-title">Recently Closed</h3>
            <RecentlyClosedList items={overview.recentlyClosed} onRefresh={onRefresh} />
          </section>
        )}
      </div>

      {/* Collapsible File Panel */}
      <div className={`work-file-panel ${filePanelOpen ? 'expanded' : 'collapsed'}`}>
        <div className="work-file-panel-header">
          <span
            className="work-file-panel-toggle"
            onClick={() => setFilePanelOpen(!filePanelOpen)}
          >
            {filePanelOpen ? '▼' : '▲'}
          </span>
          <span
            className="work-file-panel-label"
            onClick={() => setFilePanelOpen(!filePanelOpen)}
          >
            Files
          </span>
          {!filePanelOpen && (
            <input
              className="work-file-panel-search"
              type="text"
              placeholder="Search files..."
              onFocus={() => setFilePanelOpen(true)}
            />
          )}
        </div>
        {filePanelOpen && (
          <div className="work-file-panel-content">
            <FileTree onRefresh={onRefresh} />
          </div>
        )}
      </div>
    </div>
  );
}
