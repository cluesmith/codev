import { useCallback } from 'react';
import { WorkView as SharedWorkView } from '@cluesmith/codev-workspace-views';
import type { WorkViewHost } from '@cluesmith/codev-workspace-views';
import { useOverview } from '../hooks/useOverview.js';
import { createFileTab, createShellTab } from '../lib/api.js';
import type { OverviewBuilder, DashboardState } from '../lib/api.js';
import { findBuilderTab } from '../lib/issueIds.js';
import { OpenFilesShellsSection } from './OpenFilesShellsSection.js';
import { TipBanner } from './TipBanner.js';
import { WorkFilePanel } from './WorkFilePanel.js';

interface WorkViewProps {
  state: DashboardState | null;
  onRefresh: () => void;
  onSelectTab?: (id: string) => void;
}

/**
 * The dashboard's Work tab: the shared Work view (Spec 1963, @cluesmith/codev-workspace-views)
 * with the dashboard as its host. Tower is read through lib/api.ts, a builder's *Open* selects its
 * terminal tab, *+ Shell* and the spec / plan / review links open dashboard tabs, and the
 * dashboard-only pieces (the tip of the day, Open Files & Shells, the Files panel) go in as slots.
 */
export function WorkView({ state, onRefresh, onSelectTab }: WorkViewProps) {
  const { data: overview, error: overviewError, refresh: refreshOverview } = useOverview();

  const handleNewShell = useCallback(async () => {
    try {
      await createShellTab();
      onRefresh();
    } catch (err) {
      console.error('Failed to create shell:', err);
    }
  }, [onRefresh]);

  const handleOpenBuilder = useCallback((builder: OverviewBuilder) => {
    // Find the builder's terminal tab: by roleId, else by issue number or ID.
    const builderTab = findBuilderTab(builder, state?.builders);
    if (builderTab) {
      onSelectTab?.(builderTab.id);
    }
  }, [state?.builders, onSelectTab]);

  const handleOpenArtifact = useCallback(async (filePath: string) => {
    await createFileTab(filePath);
    onRefresh();
  }, [onRefresh]);

  const host: WorkViewHost = {
    // The view shows its loading state until the dashboard state is in, as it always has.
    overview: state ? { data: overview, error: overviewError } : null,
    openBuilder: handleOpenBuilder,
    newShell: handleNewShell,
    refresh: refreshOverview,
    openArtifact: handleOpenArtifact,
  };

  return (
    <SharedWorkView
      host={host}
      // Spec 823: the attribution tag counts the workspace's registered architects here.
      architectCount={state?.architects?.length ?? 0}
      slots={{
        tip: <TipBanner />,
        // Spec 467
        openFilesShells: (
          <OpenFilesShellsSection
            utils={state?.utils ?? []}
            annotations={state?.annotations ?? []}
            onSelectTab={id => onSelectTab?.(id)}
          />
        ),
        filePanel: panel => <WorkFilePanel {...panel} onRefresh={onRefresh} />,
      }}
    />
  );
}
