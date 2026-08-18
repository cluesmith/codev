import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { useBuilderStatus } from '../hooks/useBuilderStatus.js';
import { useTabs, type Tab } from '../hooks/useTabs.js';
import { useMediaQuery } from '../hooks/useMediaQuery.js';
import { useOverview } from '../hooks/useOverview.js';
import { MOBILE_BREAKPOINT } from '../lib/constants.js';
import { getTerminalWsPath, createFileTab, fetchInbox, removeArchitect as removeArchitectApi } from '../lib/api.js';
import { readActiveArchitect, writeActiveArchitect } from '../lib/architectPersistence.js';
import { SplitPane } from './SplitPane.js';
import { TabBar } from './TabBar.js';
import { ArchitectTabStrip } from './ArchitectTabStrip.js';
import { Terminal } from './Terminal.js';
import { WorkView } from './WorkView.js';
import { HeldCountBadge } from './HeldCountBadge.js';
import { MobileLayout } from './MobileLayout.js';
import { FileViewer } from './FileViewer.js';
import { AnalyticsView } from './AnalyticsView.js';
import { TeamView } from './TeamView.js';


/** Spec 443: Build the overview title string with optional hostname. */
export function buildOverviewTitle(hostname?: string, workspaceName?: string): string {
  const h = hostname?.trim();
  const w = workspaceName?.trim();
  if (h && w && h.toLowerCase() !== w.toLowerCase()) {
    return `${w} on ${h} overview`;
  }
  if (w) {
    return `${w} overview`;
  }
  return 'overview';
}

export function App() {
  const { state, refresh } = useBuilderStatus();
  // Spec 1313 Phase 8: workspace held-mail count for the header indicator. useOverview
  // is a self-contained SSE hook (shared EventSource) that refetches on overview-changed,
  // so heldCount / mailboxEscalated stay live without extra wiring.
  const { data: overview } = useOverview();
  const { tabs, activeTab, activeTabId, selectTab } = useTabs(state);
  const isMobile = useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);
  const [collapsedPane, setCollapsedPane] = useState<'left' | 'right' | null>(null);
  // Spec 761: desktop left-pane architect selection is independent of the
  // global activeTabId so the right pane keeps its own content while the
  // user flips between architect terminals on the left. Persisted by name
  // across reloads via localStorage.
  const [activeArchitectName, setActiveArchitectName] = useState<string | null>(
    () => readActiveArchitect(),
  );

  // Spec 786 Phase 4: confirmation-modal state for the remove-architect flow.
  // ArchitectTabStrip's close button fires `onRequestRemove(name)`; App.tsx
  // opens this modal with the target name. Confirm → call removeArchitect RPC.
  // Cancel → close modal without action.
  const [pendingRemoveArchitect, setPendingRemoveArchitect] = useState<string | null>(null);
  const [removingArchitect, setRemovingArchitect] = useState(false);
  const [removeArchitectError, setRemoveArchitectError] = useState<string | null>(null);

  // Spec 761: when activeTabId (driven by useTabs) lands on an architect —
  // via deep link (?tab=architect:<name>) or the post-load auto-switch for
  // a newly-added architect — sync that into the independent left-pane
  // state so the left pane reflects the selection. (Strip clicks set
  // activeArchitectName directly without touching activeTabId.)
  useEffect(() => {
    if (activeTab?.type === 'architect' && activeTab.architectName) {
      setActiveArchitectName(activeTab.architectName);
    }
  }, [activeTab?.id, activeTab?.type, activeTab?.architectName]);

  // Bugfix #205: Track which terminal tabs have been visited at least once.
  // Terminals are only mounted on first visit, then kept alive (hidden via CSS)
  // to avoid WebSocket reconnection and ring-buffer replay on tab switches.
  const [activatedTerminals, setActivatedTerminals] = useState<Set<string>>(new Set());

  // Spec 0092: Store pending initial line numbers for file tabs (not persisted server-side)
  const pendingFileLinesRef = useRef<Map<string, number>>(new Map());

  // Spec 0092 + 0101: Handle file path clicks from terminal output
  const handleFileOpen = useCallback(async (path: string, line?: number, _column?: number, terminalId?: string) => {
    try {
      const result = await createFileTab(path, line, terminalId);
      // Store the line number for when FileViewer renders
      if (line && line > 0) {
        pendingFileLinesRef.current.set(result.id, line);
      }
      refresh();
      // useTabs will auto-select the new tab
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }, [refresh]);

  // Spec 443: Build display title with hostname prefix
  const overviewTitle = buildOverviewTitle(state?.hostname, state?.workspaceName);

  // Set document title with hostname + workspace name (no emoji - favicon provides the icon)
  useEffect(() => {
    document.title = overviewTitle;
  }, [overviewTitle]);

  // Check for fullscreen mode from URL — read synchronously to avoid a
  // layout switch (desktop → fullscreen) that unmounts/remounts Terminal
  // components, killing in-flight WebSocket handshakes.
  const [isFullscreen] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('fullscreen') === '1';
  });

  // Bugfix #205: Mark terminal tabs as activated when first selected
  useEffect(() => {
    if (!activeTab) return;
    const isTerminal = activeTab.type === 'architect' || activeTab.type === 'builder' || activeTab.type === 'shell';
    if (isTerminal) {
      setActivatedTerminals(prev => {
        if (prev.has(activeTab.id)) return prev;
        const next = new Set(prev);
        next.add(activeTab.id);
        return next;
      });
    }
  }, [activeTab?.id, activeTab?.type]);

  const renderTerminal = (tab: { type: string; terminalId?: string; persistent?: boolean }) => {
    const wsPath = getTerminalWsPath(tab);
    if (!wsPath) return <div className="no-terminal">No terminal session</div>;
    // Spec 0092: Pass file open handler for clickable file paths in terminal
    // Spec 0104: Pass persistent flag for shellper-backed session indicator
    return <Terminal wsPath={wsPath} onFileOpen={handleFileOpen} persistent={tab.persistent} onPermanentClose={refresh} />;
  };

  const renderAnnotation = (tab: { annotationId?: string; initialLine?: number }) => {
    if (!tab.annotationId || !state) return <div className="no-terminal">No file viewer</div>;
    const ann = state.annotations.find(a => a.id === tab.annotationId);
    if (!ann) return <div className="no-terminal">Annotation not found</div>;
    // Spec 0092: Check for pending line number from terminal file link click
    const pendingLine = pendingFileLinesRef.current.get(tab.annotationId);
    if (pendingLine !== undefined) {
      // Clear after reading (one-time deep link)
      pendingFileLinesRef.current.delete(tab.annotationId);
    }
    return <FileViewer tabId={tab.annotationId} initialLine={pendingLine ?? tab.initialLine} />;
  };

  // Bugfix #205: Render persistent terminal tabs (kept mounted, shown/hidden via CSS).
  //
  // Spec 761: this is the extracted helper that drives both panes. The left
  // pane uses it for architect tabs when N > 1, the right pane uses it for
  // builder+shell tabs as today. The caller passes the `activeId` so the
  // left pane (architect strip) can drive visibility independently of the
  // global `activeTabId`. `toolbarExtra` is threaded onto the active terminal
  // only — passing it to all would render multiple copies of the collapse
  // buttons.
  const renderPersistentTerminals = useCallback((
    tabsToRender: Tab[],
    activeId: string | null,
    toolbarExtra?: ReactNode,
  ) => {
    return tabsToRender.map(tab => {
      const wsPath = getTerminalWsPath(tab);
      const isActive = activeId === tab.id;
      return (
        <div
          key={tab.id}
          className="terminal-tab-pane"
          style={{ display: isActive ? undefined : 'none' }}
        >
          {wsPath
            ? <Terminal
                wsPath={wsPath}
                onFileOpen={handleFileOpen}
                persistent={tab.persistent}
                toolbarExtra={isActive ? toolbarExtra : undefined}
                onPermanentClose={refresh}
              />
            : <div className="no-terminal">No terminal session</div>
          }
        </div>
      );
    });
  }, [handleFileOpen, refresh]);

  const renderPersistentContent = (terminalTypes: string[]) => {
    const persistentTabs = tabs.filter(t =>
      terminalTypes.includes(t.type) && activatedTerminals.has(t.id)
    );

    return (
      <>
        {renderPersistentTerminals(persistentTabs, activeTabId)}
        <div style={{ display: activeTab?.type === 'work' ? undefined : 'none', height: '100%' }}>
          <WorkView state={state} onRefresh={refresh} onSelectTab={selectTab} />
        </div>
        <div style={{ display: activeTab?.type === 'analytics' ? undefined : 'none', height: '100%' }}>
          <AnalyticsView isActive={activeTab?.type === 'analytics'} />
        </div>
        {state?.teamEnabled && (
          <div style={{ display: activeTab?.type === 'team' ? undefined : 'none', height: '100%' }}>
            <TeamView isActive={activeTab?.type === 'team'} />
          </div>
        )}
        {activeTab?.type === 'file' && renderAnnotation(activeTab)}
      </>
    );
  };

  // Fullscreen mode: show only the active terminal, no chrome.
  // Render nothing until the correct tab is selected to avoid a brief
  // desktop-layout render that mounts a Terminal (creating a WebSocket)
  // only to unmount it one frame later when activeTabId switches,
  // killing the WebSocket before its handshake completes.
  if (isFullscreen) {
    if (activeTab && (activeTab.type === 'architect' || activeTab.type === 'builder' || activeTab.type === 'shell')) {
      return (
        <div className="fullscreen-terminal">
          {renderTerminal(activeTab)}
        </div>
      );
    }
    // Waiting for tab selection — render empty container to avoid layout flash
    return <div className="fullscreen-terminal" />;
  }

  if (isMobile) {
    return (
      <div className="mobile-wrapper">
        <MobileLayout
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={selectTab}
          onRefresh={refresh}
        >
          {renderPersistentContent(['architect', 'builder', 'shell'])}
        </MobileLayout>
      </div>
    );
  }

  // Desktop: architect terminal(s) on left, tabbed content on right.
  // Spec 761: multiple architects render as a tab strip inside the left
  // pane. When N == 1 the strip is omitted and the bare Terminal renders
  // exactly as before (DOM-snapshot-identical to pre-761).
  const architectTabs = tabs.filter(t => t.type === 'architect');
  const architectTab = architectTabs[0];

  // Bugfix #524: Tri-state collapse buttons — one button per side that cycles
  // through full-width → 50/50 → collapsed. Uses onPointerDown+preventDefault
  // to avoid stealing xterm focus, with onClick for keyboard activation.
  const handleLeftCollapse = () => {
    // If architect is full-width (work collapsed), reduce to 50/50
    // If 50/50, collapse architect
    setCollapsedPane(collapsedPane === 'right' ? null : 'left');
  };
  const handleRightCollapse = () => {
    // If work is full-width (architect collapsed), reduce to 50/50
    // If 50/50, collapse work
    setCollapsedPane(collapsedPane === 'left' ? null : 'right');
  };

  // Left button: visible when architect is visible (not collapsed)
  // Right button: visible when work is not collapsed
  const architectToolbarExtra = (
    <>
      {collapsedPane !== 'left' && (
        <button
          className="terminal-control-btn"
          onPointerDown={(e) => e.preventDefault()}
          onClick={handleLeftCollapse}
          title={collapsedPane === 'right' ? 'Restore split layout' : 'Collapse architect panel'}
          aria-label={collapsedPane === 'right' ? 'Restore split layout' : 'Collapse architect panel'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="2" x2="3" y2="14" />
            <path d="M12 5l-4 3 4 3" />
          </svg>
        </button>
      )}
      {collapsedPane !== 'right' && (
        <button
          className="terminal-control-btn"
          onPointerDown={(e) => e.preventDefault()}
          onClick={handleRightCollapse}
          title="Collapse work panel"
          aria-label="Collapse work panel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="13" y1="2" x2="13" y2="14" />
            <path d="M4 5l4 3-4 3" />
          </svg>
        </button>
      )}
    </>
  );

  // Spec 761:
  //   - N == 0: existing empty-state.
  //   - N == 1: existing bare Terminal render (DOM-snapshot-identical).
  //   - N > 1: tab strip + persistent terminals via renderPersistentTerminals,
  //     so switching tabs flips visibility instead of unmounting WebSockets.
  //
  // The "active architect" for the left pane is tracked in `activeArchitectName`
  // (independent of `activeTabId`), so flipping a builder/work tab on the
  // right doesn't blank the architect on the left. Defaults to the first
  // architect (architects[0] === 'main' when present per Phase 1 ordering).
  let leftPane: ReactNode;
  if (architectTabs.length === 0) {
    leftPane = <div className="no-architect">No architect terminal</div>;
  } else if (architectTabs.length === 1) {
    const wsPath = getTerminalWsPath(architectTab!);
    leftPane = wsPath
      ? <Terminal
          wsPath={wsPath}
          onFileOpen={handleFileOpen}
          persistent={architectTab!.persistent}
          toolbarExtra={architectToolbarExtra}
          onPermanentClose={refresh}
        />
      : <div className="no-architect">No architect terminal</div>;
  } else {
    // Resolve which architect is active on the left pane. Prefer the
    // persisted name (if it matches an existing architect), else fall back
    // to architects[0].
    const activeArchTab =
      architectTabs.find(t => t.architectName === activeArchitectName)
      ?? architectTabs[0];
    const activeArchitectTabId = activeArchTab?.id ?? '';
    leftPane = (
      <div className="architect-pane">
        <ArchitectTabStrip
          tabs={architectTabs}
          activeTabId={activeArchitectTabId}
          onSelectTab={(id) => {
            const picked = architectTabs.find(t => t.id === id);
            if (picked?.architectName) {
              setActiveArchitectName(picked.architectName);
              writeActiveArchitect(picked.architectName);
            }
          }}
          onRequestRemove={(name) => {
            // Spec 786 Phase 4: open the confirmation modal. The modal
            // shows in-flight builders count (informational, non-blocking
            // per OQ-A). User can Confirm (calls the API) or Cancel.
            setPendingRemoveArchitect(name);
            setRemoveArchitectError(null);
          }}
        />
        <div className="architect-pane-body">
          {renderPersistentTerminals(architectTabs, activeArchitectTabId, architectToolbarExtra)}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">
          {overviewTitle}
        </h1>
        <div className="header-controls">
          <HeldCountBadge
            count={overview?.heldCount ?? 0}
            escalated={overview?.mailboxEscalated ?? false}
            loadMessages={fetchInbox}
          />
          {state?.version && <span className="header-version">v{state.version}</span>}
        </div>
      </header>
      <div className="app-body">
        <SplitPane
          left={leftPane}
          right={
            <div className="right-panel">
              <TabBar
                tabs={tabs.filter(t => t.type !== 'architect')}
                activeTabId={activeTabId}
                onSelectTab={selectTab}
                onRefresh={refresh}
              />
              <div className="tab-content" role="tabpanel">
                {renderPersistentContent(['builder', 'shell'])}
              </div>
            </div>
          }
          collapsedPane={collapsedPane}
          onExpandLeft={() => setCollapsedPane(null)}
          onExpandRight={() => setCollapsedPane(null)}
        />
      </div>
      {pendingRemoveArchitect && (
        <RemoveArchitectModal
          name={pendingRemoveArchitect}
          inFlightBuilders={(state?.builders ?? []).filter(b => b.spawnedByArchitect === pendingRemoveArchitect)}
          submitting={removingArchitect}
          error={removeArchitectError}
          onCancel={() => {
            if (removingArchitect) return;
            setPendingRemoveArchitect(null);
            setRemoveArchitectError(null);
          }}
          onConfirm={async () => {
            if (removingArchitect) return;
            setRemovingArchitect(true);
            setRemoveArchitectError(null);
            try {
              const result = await removeArchitectApi(pendingRemoveArchitect);
              if (result.success) {
                setPendingRemoveArchitect(null);
                // Refresh state so the removed sibling's tab disappears.
                refresh();
              } else {
                setRemoveArchitectError(result.error ?? 'Failed to remove architect.');
              }
            } catch (err) {
              setRemoveArchitectError(err instanceof Error ? err.message : String(err));
            } finally {
              setRemovingArchitect(false);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Spec 786 Phase 4: confirmation modal for `remove-architect`.
 *
 * Shows the architect name and any in-flight builders that were spawned by
 * this architect (informational only — removal proceeds anyway per OQ-A;
 * builders fall back to `main` routing afterwards).
 */
interface RemoveArchitectModalProps {
  name: string;
  inFlightBuilders: Array<{ id?: string; name?: string }>;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function RemoveArchitectModal({ name, inFlightBuilders, submitting, error, onCancel, onConfirm }: RemoveArchitectModalProps) {
  return (
    <div className="remove-architect-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="remove-arch-title">
      <div className="remove-architect-modal">
        <h2 id="remove-arch-title">Remove architect <code>{name}</code>?</h2>
        {inFlightBuilders.length > 0 ? (
          <p>
            <strong>{inFlightBuilders.length} in-flight builder{inFlightBuilders.length === 1 ? '' : 's'}</strong>{' '}
            spawned by <code>{name}</code>:
            {' '}{inFlightBuilders.map(b => b.name || b.id).filter(Boolean).join(', ')}.
            {' '}They&rsquo;ll continue running and fall back to <code>main</code> for routing.
          </p>
        ) : (
          <p>This architect has no in-flight builders.</p>
        )}
        {error && <p className="remove-architect-error" role="alert">{error}</p>}
        <div className="remove-architect-modal-actions">
          <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={submitting} className="primary">
            {submitting ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}
