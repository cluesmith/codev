import { useState } from 'react';
import type { ReactNode } from 'react';
import type { OverviewBuilder } from '@cluesmith/codev-types';
import type { WorkViewHost } from '../host.js';
import { BuilderCard } from './BuilderCard.js';
import { NeedsAttentionList } from './NeedsAttentionList.js';
import { BacklogList } from './BacklogList.js';
import { RecentlyClosedList } from './RecentlyClosedList.js';

/** The collapsible file panel's state, which the view keeps for a host's `filePanel` slot. */
export interface FilePanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/**
 * Pieces only one host has, rendered where the dashboard renders them. Each is absent unless the
 * host passes it, so a host without one shows nothing in its place.
 */
export interface WorkViewSlots {
  /** Below the header and any error: the dashboard's tip of the day. */
  tip?: ReactNode;
  /** After the Builders section: the dashboard's Open Files & Shells. */
  openFilesShells?: ReactNode;
  /**
   * The whole collapsible file panel, after the content. The view keeps its open state and marks
   * its root `file-panel-open` while it is open, so the content gives the panel room.
   */
  filePanel?: (state: FilePanelState) => ReactNode;
}

interface WorkViewProps {
  host: WorkViewHost;
  slots?: WorkViewSlots;
  /**
   * How many architects the builder-attribution tag counts (shown above 1). Defaults to the
   * overview's live architects; the dashboard passes its registered ones, as it always has.
   */
  architectCount?: number;
}

export function WorkView({ host, slots = {}, architectCount }: WorkViewProps) {
  const [filePanelOpen, setFilePanelOpen] = useState(false);

  if (!host.overview) {
    return (
      <div className="work-view">
        <p className="work-loading">Loading...</p>
      </div>
    );
  }

  const { data: overview, error: overviewError } = host.overview;
  // Through `host`, not destructured: a host may be a class whose methods use `this`.
  const openBuilder = host.openBuilder && ((builder: OverviewBuilder) => host.openBuilder?.(builder));
  const openArtifact = host.openArtifact && ((path: string) => host.openArtifact?.(path));
  const panelOpen = slots.filePanel !== undefined && filePanelOpen;
  // Spec 823: count once outside the render loop so each BuilderCard receives a stable prop. With
  // no architects counted, `architectCount > 1` is false and no attribution span renders.
  const attributionCount = architectCount ?? overview?.architects?.length ?? 0;

  return (
    <div className={`work-view ${panelOpen ? 'file-panel-open' : ''}`}>
      <div className="work-content">
        <div className="work-header">
          <h2 className="work-title">Work</h2>
          <div className="work-actions">
            {host.newShell && <button className="work-btn" onClick={() => host.newShell?.()}>+ Shell</button>}
            {host.refresh && <button className="work-btn work-btn-secondary" onClick={() => host.refresh?.()}>Refresh</button>}
          </div>
        </div>

        {overviewError && (
          <div className="work-error">Failed to load overview: {overviewError}</div>
        )}

        {slots.tip}

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
                    onOpen={openBuilder}
                    architectCount={attributionCount}
                  />
                ))}
              </tbody>
            </table>
          ) : (
            <p className="work-empty">No active builders</p>
          )}
        </section>

        {slots.openFilesShells}

        {overview?.forgeStatus === 'rate-limited' && (
          <p className="work-unavailable">
            Forge rate limited — PRs, backlog and recently closed may be stale until{' '}
            {overview.forgeResetAt ? new Date(overview.forgeResetAt).toLocaleTimeString() : 'the budget resets'}
          </p>
        )}

        {/* Needs Attention */}
        <section className="work-section">
          <h3 className="work-section-title">Needs Attention</h3>
          {overview?.errors?.prs ? (
            <p className="work-unavailable">{overview.errors.prs}</p>
          ) : (
            <NeedsAttentionList
              prs={overview?.pendingPRs ?? []}
              builders={overview?.builders ?? []}
              architects={overview?.architects ?? []}
            />
          )}
        </section>

        {/* Backlog & Bugs */}
        <section className="work-section">
          <h3 className="work-section-title">Backlog</h3>
          {overview?.errors?.issues ? (
            <p className="work-unavailable">{overview.errors.issues}</p>
          ) : (
            <BacklogList items={overview?.backlog ?? []} onOpenArtifact={openArtifact} />
          )}
        </section>

        {/* Recently Closed */}
        {overview?.recentlyClosed && overview.recentlyClosed.length > 0 && (
          <section className="work-section">
            <h3 className="work-section-title">Recently Closed</h3>
            <RecentlyClosedList items={overview.recentlyClosed} onOpenArtifact={openArtifact} />
          </section>
        )}
      </div>

      {slots.filePanel?.({ open: filePanelOpen, setOpen: setFilePanelOpen })}
    </div>
  );
}
