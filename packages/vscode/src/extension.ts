import * as vscode from 'vscode';
import { ConnectionManager } from './connection-manager.js';
import { TerminalManager } from './terminal-manager.js';
import { OverviewCache } from './views/overview-data.js';
import { spawnBuilder } from './commands/spawn.js';
import { sendMessage } from './commands/send.js';
import { approveGate } from './commands/approve.js';
import { cleanupBuilder } from './commands/cleanup.js';
import { openWorktreeWindow } from './commands/open-worktree-window.js';
import { viewDiff, activateDiffView, openBuilderFileDiff } from './commands/view-diff.js';
import { navigateDiff } from './commands/diff-nav.js';
import { activateDiffInjectCodeLens, getDiffInjectEntry } from './diff-inject-codelens.js';
import { buildBuilderRangeRef } from './diff-inject-ref.js';
import { runWorktreeDev } from './commands/run-worktree-dev.js';
import { stopWorktreeDev } from './commands/stop-worktree-dev.js';
import { runWorkspaceDev, stopWorkspaceDev } from './commands/run-workspace-dev.js';
import { stopDevServer, restartDevServer, switchDevTarget, showCodevSidebar, hideCodevSidebar } from './commands/dev-server-actions.js';
import { openDevUrl } from './commands/open-dev-url.js';
import { pasteImage } from './commands/paste-image.js';
import { openWorktreeFolder } from './commands/open-worktree-folder.js';
import { runWorktreeSetup } from './commands/run-worktree-setup.js';
import { viewPlanFile, viewSpecFile, viewReviewFile } from './commands/view-artifact.js';
import { activateIssueView, viewBacklogIssue } from './commands/view-issue.js';
import { BacklogSearchPanel } from './webviews/backlog-search-panel.js';
import { searchBacklog } from './commands/search-backlog.js';
import { connectTunnel, disconnectTunnel } from './commands/tunnel.js';
import { listCronTasks } from './commands/cron.js';
import { addReviewComment } from './commands/review.js';
import { activateGateToasts } from './notifications/gate-toast.js';
import { activateReviewDecorations } from './review-decorations.js';
import { activateReviewComments } from './comments/plan-review.js';
import { MarkdownPreviewProvider } from './markdown-preview/preview-provider.js';
import { BuilderSpawnHandler } from './builder-spawn-handler.js';
import { BuilderTerminalLinkProvider, ReconnectTerminalLinkProvider } from './terminal-link-provider.js';
import { computeBuildersToClose, roleIdsFromBuilders } from './prune-builder-terminals.js';
import { buildBuilderPickRows } from './builder-pick-rows.js';
import { isIdleWaiting } from '@cluesmith/codev-core/builder-helpers';
import { BuildersProvider, AccordionGate } from './views/builders.js';
import { PullRequestsProvider, PullRequestTreeItem } from './views/pull-requests.js';
import { BacklogProvider } from './views/backlog.js';
import { visibleBacklogCount, formatBacklogTitle } from './views/backlog-filter.js';
import { RecentlyClosedProvider } from './views/recently-closed.js';
import { TeamProvider } from './views/team.js';
import { StatusProvider } from './views/status.js';
import { PanelPlaceholderProvider } from './views/panel-placeholder.js';
import { DevServerTreeProvider } from './views/dev-server.js';
import { formatTargetName } from './views/dev-server-format.js';
import { WorkspaceProvider } from './views/workspace.js';
import { BuilderTreeItem } from './views/builder-tree-item.js';
import { BuilderFileTreeItem } from './views/builder-file-tree-item.js';
import { BuilderDiffCache } from './views/builder-diff-cache.js';
import { BuilderFileDecorationProvider } from './views/builder-file-decoration.js';
import { BacklogGroupTreeItem, BacklogTreeItem } from './views/backlog-tree-item.js';
import { persistAreaGroupExpansion } from './views/area-group-expansion.js';
import { buildArchitectReferenceInjection } from './architect-reference-injection.js';
import { runPreflight, recheckCli, isCliReady, showPreflightFeedback, probeTowerVersion } from './preflight/preflight.js';
import { detectWorkspacePath } from './workspace-detector.js';
import { loadWorktreeConfig, hasRunnableDevCommand } from './load-worktree-config.js';

let connectionManager: ConnectionManager | null = null;
let terminalManager: TerminalManager | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;
// Always-visible chip shown only while an `afx dev` PTY is running (#921).
// Created lazily on dev start, disposed on stop — distinct from the connection
// status item above.
let devChipItem: vscode.StatusBarItem | null = null;

/**
 * Resolve a builder id from a command argument.
 *
 * Tree-item context-menu invocations pass a BuilderTreeItem; command-palette
 * invocations pass nothing; programmatic invocations may pass a string id.
 * Anything else → undefined → the command falls back to its quick-pick.
 */
function extractBuilderId(arg: vscode.TreeItem | string | undefined): string | undefined {
	if (typeof arg === 'string') { return arg; }
	if (arg instanceof BuilderTreeItem) { return arg.builderId; }
	return undefined;
}

/**
 * Resolve an issue number from a command argument.
 *
 * Backlog row-click passes the issue id as a string via
 * `item.command.arguments`; right-click context-menu invocations pass the
 * BacklogTreeItem itself; command-palette invocations pass nothing →
 * undefined → spawnBuilder falls back to its full quick-pick flow.
 */
/**
 * Argument shape accepted by the backlog issue commands. Beyond the sidebar's
 * `TreeItem` and the row-click `string`, the Search Backlog webview (#920)
 * passes a plain `{ issueId, issueTitle }` object so its inline "reference in
 * architect" action can carry the title (which a bare id string can't).
 */
type IssueCommandArg =
	| vscode.TreeItem
	| string
	| { issueId: string; issueTitle?: string }
	| undefined;

function extractIssueId(arg: IssueCommandArg): string | undefined {
	if (typeof arg === 'string') { return arg; }
	if (arg instanceof BacklogTreeItem) { return arg.issueId; }
	if (arg && typeof arg === 'object' && 'issueId' in arg) { return arg.issueId; }
	return undefined;
}

/**
 * Resolve an issue title from a command argument.
 *
 * Only `BacklogTreeItem` carries the title; string args (used by row-click
 * which only passes the id) and undefined return undefined so callers can
 * fall back. An empty title is normalised to undefined so the fallback
 * branch handles it identically to a missing title.
 */
function extractIssueTitle(arg: IssueCommandArg): string | undefined {
	if (arg instanceof BacklogTreeItem) {
		return arg.issueTitle || undefined;
	}
	if (arg && typeof arg === 'object' && 'issueId' in arg) {
		return arg.issueTitle || undefined;
	}
	return undefined;
}

export async function activate(context: vscode.ExtensionContext) {
	// Output Channel for diagnostics
	outputChannel = vscode.window.createOutputChannel('Codev');
	context.subscriptions.push(outputChannel);

	// Connection Manager
	connectionManager = new ConnectionManager(context, outputChannel);
	context.subscriptions.push({ dispose: () => connectionManager?.dispose() });

	// Status bar
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBarItem.text = '$(circle-slash) Codev: Offline';
	statusBarItem.command = 'codev.reconnect';
	statusBarItem.tooltip = 'Click to reconnect to Tower';
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);

	connectionManager.onStateChange((state) => {
		if (!statusBarItem) { return; }
		switch (state) {
			case 'connected':
				statusBarItem.text = '$(server) Codev: Connected';
				statusBarItem.color = undefined;
				// #983: probe the running Tower's version now that we're connected.
				// Covers activation and every reconnect (incl. after a Tower restart);
				// the in-memory version only changes across a restart, which always
				// severs and re-establishes this connection.
				{
					const client = connectionManager?.getClient();
					if (client) { probeTowerVersion(client); }
				}
				break;
			case 'connecting':
				statusBarItem.text = '$(sync~spin) Codev: Connecting...';
				statusBarItem.color = undefined;
				break;
			case 'reconnecting':
				statusBarItem.text = '$(sync~spin) Codev: Reconnecting...';
				statusBarItem.color = new vscode.ThemeColor('statusBarItem.warningForeground');
				break;
			case 'disconnected':
				statusBarItem.text = '$(circle-slash) Codev: Offline';
				statusBarItem.color = new vscode.ThemeColor('statusBarItem.errorForeground');
				break;
		}
	});

	// OverviewCache is created before TerminalManager so it can be injected —
	// TerminalManager uses it for friendly builder tab titles (`Codev: #<id> <title>`).
	const overviewCache = new OverviewCache(connectionManager);

	// Terminal Manager
	terminalManager = new TerminalManager(connectionManager, outputChannel, context.extensionUri, overviewCache);
	context.subscriptions.push({ dispose: () => terminalManager?.dispose() });

	// Drive the `codev.terminalFocused` context key so the Cmd/Ctrl+V image
	// paste binding (#736) only applies when a Codev terminal is focused —
	// it must never shadow Cmd+V anywhere else.
	const syncTerminalFocusContext = () =>
		vscode.commands.executeCommand(
			'setContext', 'codev.terminalFocused',
			terminalManager?.isCodevTerminalActive() ?? false);
	context.subscriptions.push(
		vscode.window.onDidChangeActiveTerminal(syncTerminalFocusContext));
	syncTerminalFocusContext(); // seed initial state

	// Opt-in: force a terminal repaint when the VSCode window regains focus
	// (#1052). The initial-render fix (replay buffer-and-flush) already makes
	// terminals render correctly on open, so this is OFF by default — testing
	// showed no observable refocus corruption it was needed for. It remains as an
	// escape hatch for setups that still see stale/misplaced content after
	// switching back: enabling `codev.terminal.repaintOnRefocus` sends a SIGWINCH
	// redraw (the manual-resize lever) to the terminals on refocus. Read at event
	// time so flipping the setting takes effect on the next focus change with no
	// reload; fired only on the rising edge (unfocused → focused).
	let windowFocused = vscode.window.state.focused;
	context.subscriptions.push(
		vscode.window.onDidChangeWindowState((state) => {
			if (state.focused && !windowFocused) {
				const enabled = vscode.workspace
					.getConfiguration('codev')
					.get<boolean>('terminal.repaintOnRefocus', false);
				if (enabled) {
					terminalManager?.repaintAllOnRefocus();
				}
			}
			windowFocused = state.focused;
		}));

	// Drive the `codev.hasDevCommand` context key so the builder-row Run/Stop
	// Dev Server menu entries, the dev keybindings, and the workspace-dev palette
	// entries only surface when a runnable `worktree.devCommand` is configured
	// (#975). These surfaces are global (the keybindings/palette are invokable
	// regardless of whether the Builders tree has rendered), so the key is
	// refreshed by global signals — mirroring the Workspace view's own gate:
	// `onStateChange` for the initial value once Tower is reachable, plus the
	// `worktree-config-updated` SSE envelope (fired by Tower's config-file
	// watcher) so the key stays live on `.codev/config(.local).json` edits
	// without a window reload. The config is the Tower-merged 5-layer view
	// (shared + project-local). Fail-safe: a disconnected/error state resolves
	// to `false` — hide, never falsely offer.
	const syncHasDevCommandContext = async () => {
		const config = await loadWorktreeConfig(connectionManager!);
		await vscode.commands.executeCommand(
			'setContext', 'codev.hasDevCommand', hasRunnableDevCommand(config));
	};
	context.subscriptions.push(
		connectionManager.onStateChange(() => { syncHasDevCommandContext(); }));
	context.subscriptions.push(
		connectionManager.onSSEEvent(({ data }) => {
			try {
				if ((JSON.parse(data) as { type?: unknown }).type === 'worktree-config-updated') {
					syncHasDevCommandContext();
				}
			} catch {
				// benign — malformed envelope
			}
		}));
	syncHasDevCommandContext(); // seed initial state

	// Update status bar with builder + needs-attention counts.
	// Two "needs me" signals: blocked (formal gate) and idle-waiting
	// (PTY silent past threshold, likely paused at a non-gate question
	// — see isIdleWaiting in @cluesmith/codev-core/builder-helpers).
	// Each is shown only when > 0, with its own icon.
	const updateStatusBarCounts = () => {
		if (!statusBarItem || connectionManager?.getState() !== 'connected') { return; }
		const data = overviewCache.getData();
		if (!data) { return; }
		const builderCount = data.builders.length;
		const now = Date.now();
		const blockedCount = data.builders.filter(b => b.blocked).length;
		const idleCount = data.builders.filter(b => isIdleWaiting(b, now)).length;
		let text = `$(server) Codev: ${builderCount} builders`;
		if (blockedCount > 0) { text += ` · $(bell) ${blockedCount} blocked`; }
		if (idleCount > 0) { text += ` · $(comment-discussion) ${idleCount} waiting`; }
		statusBarItem.text = text;
	};

	// List views show their item count in the title: "Builders (3)".
	// createTreeView (not registerTreeDataProvider) is required to get a
	// settable .title. When there's no data yet (disconnected/loading) the
	// title falls back to the plain base name — no misleading "(0)".
	let buildersView: vscode.TreeView<vscode.TreeItem> | undefined;
	let pullRequestsView: vscode.TreeView<vscode.TreeItem> | undefined;
	let backlogView: vscode.TreeView<vscode.TreeItem> | undefined;
	let recentlyClosedView: vscode.TreeView<vscode.TreeItem> | undefined;
	const readBacklogShowAll = () =>
		vscode.workspace.getConfiguration('codev').get<boolean>('backlogShowAll', false);
	const updateListViewTitles = () => {
		const data = overviewCache.getData();
		const withCount = (base: string, n: number | undefined) =>
			typeof n === 'number' ? `${base} (${n})` : base;
		if (buildersView) { buildersView.title = withCount('Builders', data?.builders.length); }
		if (pullRequestsView) { pullRequestsView.title = withCount('Pull Requests', data?.pendingPRs.length); }
		if (backlogView) {
			// Backlog title reflects the *visible* row count (mine-only vs show-all),
			// not the unfiltered spawnable total. `formatBacklogTitle` renders
			// `Backlog (V of T)` when the mine-only filter is hiding rows, so the
			// "of T" affordance signals "click the eye icon to see all".
			const { visible, total } = data
				? visibleBacklogCount(data, readBacklogShowAll())
				: { visible: undefined, total: undefined };
			backlogView.title = formatBacklogTitle(visible, total);
		}
		if (recentlyClosedView) { recentlyClosedView.title = withCount('Recently Closed', data?.recentlyClosed.length); }
	};

	// Activity-bar badge — paint the "needs me" count on the Codev icon.
	// Combines both signals: blocked (formal gate) + idle-waiting (PTY
	// silent past threshold). VSCode has no container-level badge API;
	// per-view `TreeView.badge` bubbles up to the activity-bar icon
	// when the sidebar is hidden, so badging `buildersView` is how
	// we paint the icon. Badge only set when there's at least one
	// item needing the user.
	const updateActivityBadge = () => {
		if (!buildersView) { return; }
		const data = overviewCache.getData();
		if (connectionManager?.getState() !== 'connected' || !data) {
			buildersView.badge = undefined;
			return;
		}
		const now = Date.now();
		const blockedCount = data.builders.filter(b => b.blocked).length;
		const idleCount = data.builders.filter(b => isIdleWaiting(b, now)).length;
		const total = blockedCount + idleCount;
		if (total === 0) {
			buildersView.badge = undefined;
			return;
		}
		const tooltip = (blockedCount > 0 && idleCount > 0)
			? `${blockedCount} blocked, ${idleCount} waiting on input`
			: blockedCount > 0
				? (blockedCount === 1 ? '1 builder blocked at a human-approval gate' : `${blockedCount} builders blocked at human-approval gates`)
				: (idleCount === 1 ? '1 builder waiting on input' : `${idleCount} builders waiting on input`);
		buildersView.badge = { value: total, tooltip };
	};

	// Close builder/dev terminal tabs when their builder disappears from the
	// overview data. Covers cleanup triggered from the VSCode "Cleanup Builder"
	// command, `afx cleanup` on the CLI, or any other removal path — otherwise
	// Tower kills the PTY but the VSCode tab lingers as a dead "Process exited"
	// entry. Uses a present→absent diff so freshly-spawned builders whose first
	// state refresh hasn't landed aren't pre-emptively closed.
	//
	// Reads from `overviewCache.getData()` — i.e. `/api/overview.builders`,
	// which is sourced from `discoverBuilders`' `readdirSync(.builders/)` scan
	// (see #883). The previous `getWorkspaceState` source was rebuilt from
	// SQLite `terminal_sessions` and got pinned open by surviving shellper
	// processes after `afx cleanup`, so the diff never saw the absence.
	let prevRoleIds: Set<string> | null = null;
	const pruneClosedBuilderTerminals = (): void => {
		const data = overviewCache.getData();
		if (!data?.builders) { return; }
		const currRoleIds = roleIdsFromBuilders(data.builders);
		for (const roleId of computeBuildersToClose(prevRoleIds, currRoleIds)) {
			terminalManager?.closeBuilderTerminal(roleId);
		}
		prevRoleIds = currRoleIds;
	};

	// Sidebar TreeViews (overviewCache created above, before TerminalManager)
	context.subscriptions.push({ dispose: () => overviewCache.dispose() });
	overviewCache.onDidChange(() => {
		updateStatusBarCounts();
		pruneClosedBuilderTerminals();
		updateListViewTitles();
		updateActivityBadge();
	});

	// Shared across the Builders tree (second-level changed files) and the
	// SCM-style file decorations so both read one TTL-guarded git result.
	const builderDiffCache = new BuilderDiffCache();
	context.subscriptions.push(
		{ dispose: () => builderDiffCache.dispose() },
		vscode.window.registerFileDecorationProvider(new BuilderFileDecorationProvider(builderDiffCache)),
	);

	// #913: the Builders view no longer persists per-group expansion (groups are
	// ephemeral nav state — default expanded each session). Delete any value left
	// by a prior install so the dead state doesn't linger; updating to `undefined`
	// removes the key and is idempotent across activations. Both axis keys are
	// cleared (#952 added the stage axis after #913 was filed).
	context.workspaceState.update('codev.buildersGroupExpansion', undefined);
	context.workspaceState.update('codev.buildersStageGroupExpansion', undefined);

	// List views use createTreeView so their title can carry a live item
	// count; the rest stay on registerTreeDataProvider.
	const buildersProvider = new BuildersProvider(overviewCache, builderDiffCache);
	buildersView = vscode.window.createTreeView('codev.builders', { treeDataProvider: buildersProvider });
	pullRequestsView = vscode.window.createTreeView('codev.pullRequests', { treeDataProvider: new PullRequestsProvider(overviewCache) });
	const backlogProvider = new BacklogProvider(overviewCache, context.workspaceState);
	backlogView = vscode.window.createTreeView('codev.backlog', { treeDataProvider: backlogProvider });
	context.subscriptions.push(...persistAreaGroupExpansion(
		backlogView, BacklogGroupTreeItem, backlogProvider.expansion,
	));
	recentlyClosedView = vscode.window.createTreeView('codev.recentlyClosed', { treeDataProvider: new RecentlyClosedProvider(overviewCache) });
	// Seed the badge so it's correct immediately if overview data is already
	// cached, instead of waiting for the next onDidChange tick.
	updateActivityBadge();
	const teamProvider = new TeamProvider(connectionManager);
	// Spec 786 Phase 6: hold the WorkspaceProvider so commands like
	// `codev.removeArchitect` can call `.refresh()` after mutating Tower
	// state (architects added/removed don't otherwise fire an event the
	// sidebar listens for).
	const workspaceProvider = new WorkspaceProvider(connectionManager, terminalManager!);
	// Holds the CLI preflight row (#791); it self-refreshes on `onPreflightChange`.
	const statusProvider = new StatusProvider(connectionManager);
	// Codev Dev panel tab (#921) — the first real view in #812's codevPanel.
	// createTreeView (not registerTreeDataProvider) so we hold the handle and can
	// set TreeView.badge — the activity dot the plan calls for while a dev runs.
	const devServerProvider = new DevServerTreeProvider(connectionManager, terminalManager!);
	const devServerView = vscode.window.createTreeView('codev.devServer', { treeDataProvider: devServerProvider });
	context.subscriptions.push(
		buildersView,
		pullRequestsView,
		backlogView,
		recentlyClosedView,
		vscode.window.registerTreeDataProvider('codev.workspace', workspaceProvider),
		vscode.window.registerTreeDataProvider('codev.team', teamProvider),
		vscode.window.registerTreeDataProvider('codev.status', statusProvider),
		vscode.window.registerTreeDataProvider('codev.placeholder', new PanelPlaceholderProvider()),
		devServerView,
		{ dispose: () => devServerProvider.dispose() },
	);

	// Panel container (#812) ships a placeholder signpost gated by
	// `codev.panelContainerEmpty`. codev.devServer (#921) is a real, always-present
	// panel view, so the container is never empty — flip the key false to hide the
	// signpost. (Sibling tabs #813/#814/#815 set the same key; idempotent.)
	vscode.commands.executeCommand('setContext', 'codev.panelContainerEmpty', false);

	// Status-bar chip + title-bar gating for the dev surface (#921). Both derive
	// from the single dev-terminal source of truth, so the chip, the Codev Dev
	// tab, and the title-bar Stop/Restart actions stay in lockstep on every
	// start/stop/swap. One subscription, named handler (no duplicate listeners).
	const updateDevChip = (target: string | null): void => {
		if (target) {
			if (!devChipItem) {
				devChipItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
				devChipItem.command = 'codev.devServer.focus'; // VSCode's auto view-focus command
			}
			// server-process (a running dev server), not zap — $(zap) reads as AI/sparkle in VSCode.
			devChipItem.text = `$(server-process) Dev: ${target}`;
			// StatusBarItem.backgroundColor only honors error/warning backgrounds
			// (VSCode API constraint), so the "prominent, not alarming" look
			// (#921 design call #4) is applied via the foreground instead.
			devChipItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
			devChipItem.tooltip = `Codev dev server running for ${target}. Click to focus Codev Dev panel`;
			devChipItem.show();
		} else if (devChipItem) {
			devChipItem.dispose();
			devChipItem = null;
		}
	};
	const refreshDevSurface = (): void => {
		const builderId = terminalManager?.listDevTerminals()[0]?.builderId ?? null;
		const target = builderId ? formatTargetName(builderId) : null;
		updateDevChip(target);
		vscode.commands.executeCommand('setContext', 'codev.devServerRunning', target !== null);
		// Activity dot on the Codev Dev tab while a dev runs — visible when the
		// user is on another codevPanel tab (plan's tab-badge requirement).
		devServerView.badge = target
			? { value: 1, tooltip: `Dev server running for ${target}` }
			: undefined;
	};
	context.subscriptions.push(
		terminalManager.onDidChangeDevTerminals(refreshDevSurface),
		{ dispose: () => { devChipItem?.dispose(); devChipItem = null; } },
	);
	refreshDevSurface(); // seed from any dev already running at activation

	// VSCode gives no control over a panel tab's position, so a freshly
	// contributed container lands last and spills into the `...` overflow.
	// Reveal it exactly once (per profile) so the user discovers the tab; the
	// globalState flag makes this a one-time nudge, not an every-launch
	// interruption. After the reveal VSCode persists the tab as shown.
	const PANEL_REVEALED_KEY = 'codev.panelRevealedOnce';
	if (!context.globalState.get(PANEL_REVEALED_KEY)) {
		vscode.commands.executeCommand('workbench.view.extension.codevPanel');
		context.globalState.update(PANEL_REVEALED_KEY, true);
	}

	// Builders accordion: expanding one builder auto-collapses the OTHER builder
	// rows so a reviewer can't have diffs from unrelated worktrees open at once.
	// It deliberately leaves group headers alone (#913) — `collapseBuildersExcept`
	// only re-ids builder rows, never the group rows. Toggle via the header
	// button / `codev.buildersAutoCollapse`.
	const readAccordion = () =>
		vscode.workspace.getConfiguration('codev').get<boolean>('buildersAutoCollapse', true);
	const accordion = new AccordionGate(readAccordion());
	vscode.commands.executeCommand('setContext', 'codev.buildersAutoCollapse', readAccordion());
	context.subscriptions.push(
		buildersView.onDidExpandElement((e) => {
			if (!(e.element instanceof BuilderTreeItem)) { return; }
			if (accordion.shouldCollapseOthers(e.element.builderId)) {
				buildersProvider.collapseBuildersExcept(e.element);
			}
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('codev.buildersAutoCollapse')) { return; }
			const on = readAccordion();
			accordion.setEnabled(on);
			vscode.commands.executeCommand('setContext', 'codev.buildersAutoCollapse', on);
		}),
	);

	// Builders file-view-as-tree: each builder's changed-files list renders
	// as a folder tree (with single-child folder chains compacted, like
	// VSCode SCM) when on, or as a flat list when off. Toggle via the
	// header button / `codev.buildersFileViewAsTree`. Same mechanics as
	// accordion above — read setting, mirror to context key, refresh
	// provider on change so the tree redraws in the new mode.
	const readFileViewAsTree = () =>
		vscode.workspace.getConfiguration('codev').get<boolean>('buildersFileViewAsTree', true);
	vscode.commands.executeCommand('setContext', 'codev.buildersFileViewAsTree', readFileViewAsTree());
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('codev.buildersFileViewAsTree')) { return; }
			vscode.commands.executeCommand('setContext', 'codev.buildersFileViewAsTree', readFileViewAsTree());
			buildersProvider.refresh();
		}),
	);

	// Builders grouping axis: stage (action axis, default) vs area (domain axis).
	// Same mechanics as the file-tree toggle — read the `codev.buildersGroupBy`
	// setting, mirror to a context key so the paired title-bar commands swap
	// correctly, refresh the provider on change so the tree re-groups immediately.
	const readBuildersGroupBy = () =>
		vscode.workspace.getConfiguration('codev').get<string>('buildersGroupBy', 'stage');
	vscode.commands.executeCommand('setContext', 'codev.buildersGroupBy', readBuildersGroupBy());
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('codev.buildersGroupBy')) { return; }
			vscode.commands.executeCommand('setContext', 'codev.buildersGroupBy', readBuildersGroupBy());
			buildersProvider.refresh();
		}),
	);

	// Backlog mine-only / show-all toggle. Default is `false` (mine-only)
	// so a fresh install opens to "what's on my plate". Same mechanics as
	// the two toggles above: read setting, mirror to context key so the
	// paired view-title commands swap correctly, refresh the provider on
	// change so the filter takes effect immediately. `readBacklogShowAll`
	// is hoisted above `updateListViewTitles` so the title-count helper
	// can read it on every refresh.
	vscode.commands.executeCommand('setContext', 'codev.backlogShowAll', readBacklogShowAll());
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('codev.backlogShowAll')) { return; }
			vscode.commands.executeCommand('setContext', 'codev.backlogShowAll', readBacklogShowAll());
			backlogProvider.refresh();
			// Title-count depends on the showAll flag too — refresh it in lockstep
			// with the tree, otherwise the title stays stale until the next overview
			// tick rebroadcasts.
			updateListViewTitles();
		}),
	);

	// Periodic overview refresh. VSCode has no timer-based refresh (event-only),
	// so an idle workspace never sees externally-merged PRs / new issues. Mirror
	// the dashboard's poll idiom: refresh on a cadence while the Codev sidebar is
	// visible, paused when it isn't. The shared Tower-side 30s cache throttles gh
	// cost across windows; refresh() is last-write-wins so periodic + event-driven
	// refreshes coexist without flicker.
	const setupPeriodicOverviewRefresh = () => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const readIntervalSeconds = (): number => {
			const s = vscode.workspace.getConfiguration('codev').get<number>('overviewRefreshSeconds', 60);
			return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 0;
		};
		const anyVisible = (): boolean =>
			!!buildersView?.visible || !!pullRequestsView?.visible
			|| !!backlogView?.visible || !!recentlyClosedView?.visible;
		const stop = () => {
			if (timer) { clearInterval(timer); timer = undefined; }
		};
		const reconcile = () => {
			const seconds = readIntervalSeconds();
			if (seconds === 0 || !anyVisible()) { stop(); return; }
			if (!timer) {
				timer = setInterval(() => {
					if (connectionManager?.getState() === 'connected') { void overviewCache.refresh(); }
				}, seconds * 1000);
				void overviewCache.refresh(); // resume → immediate refresh
			}
		};

		context.subscriptions.push(
			buildersView!.onDidChangeVisibility(reconcile),
			pullRequestsView!.onDidChangeVisibility(reconcile),
			backlogView!.onDidChangeVisibility(reconcile),
			recentlyClosedView!.onDidChangeVisibility(reconcile),
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('codev.overviewRefreshSeconds')) { stop(); reconcile(); }
			}),
			{ dispose: stop },
		);
		reconcile();
	};
	setupPeriodicOverviewRefresh();

	// Refresh overview on connect + set team visibility
	connectionManager.onStateChange(async (state) => {
		if (state === 'connected') {
			overviewCache.refresh();
			// Check if team is enabled for this workspace
			const client = connectionManager?.getClient();
			const workspacePath = connectionManager?.getWorkspacePath();
			if (client && workspacePath) {
				const wsState = await client.getWorkspaceState(workspacePath);
				vscode.commands.executeCommand('setContext', 'codev.teamEnabled', wsState?.teamEnabled ?? false);
			}
		}
	});

	// Command registration helpers (#791). Two registrars; the one you call IS
	// the guard decision, so there's no separate list or per-call flag to keep
	// in sync:
	//   - `regCli`  — the command needs the codev CLI / Tower. When the CLI is
	//                 missing or outdated it no-ops with point-of-action feedback
	//                 (via `guard` → `showPreflightFeedback`: a modal "run setup"
	//                 toast on the first click, an ephemeral status-bar message on
	//                 later clicks) instead of failing with a misleading "not
	//                 connected to Tower" error.
	//   - `reg`     — CLI-independent command (recovery paths like reconnect /
	//                 recheck, config toggles, read-only viewers); registered
	//                 with no guard.
	// `isCliReady` is optimistic during the brief startup preflight window
	// (treats the not-yet-resolved `pending` state as ready) so healthy installs
	// are never blocked.
	const guard = <A extends unknown[], R>(handler: (...args: A) => R) =>
		(...args: A): R | undefined => {
			if (isCliReady()) { return handler(...args); }
			showPreflightFeedback();
			return undefined;
		};
	const reg = <A extends unknown[]>(id: string, handler: (...args: A) => unknown) =>
		// eslint-disable-next-line no-restricted-syntax -- this IS the reg helper (#791)
		vscode.commands.registerCommand(id, handler);
	const regCli = <A extends unknown[]>(id: string, handler: (...args: A) => unknown) =>
		// eslint-disable-next-line no-restricted-syntax -- this IS the regCli helper (#791)
		vscode.commands.registerCommand(id, guard(handler));

	// Commands
	context.subscriptions.push(
		reg('codev.helloWorld', () => {
			const state = connectionManager?.getState() ?? 'unknown';
			const workspace = connectionManager?.getWorkspacePath() ?? 'none';
			vscode.window.showInformationMessage(`Codev: ${state} | Workspace: ${workspace}`);
		}),
		reg('codev.openArchitectTerminal', async (architectName?: string) => {
			// Spec 786 Phase 6: the command accepts an optional architect name.
			// Sidebar children pass their architect name via `command.arguments`.
			// Existing palette / no-arg invocations default to `main`.
			const client = connectionManager?.getClient();
			const workspacePath = connectionManager?.getWorkspacePath();
			if (!client || !workspacePath || connectionManager?.getState() !== 'connected') {
				vscode.window.showErrorMessage('Codev: Not connected to Tower');
				return;
			}
			const targetName = architectName ?? 'main';
			try {
				const state = await client.getWorkspaceState(workspacePath);
				// Resolve the terminal id for the requested architect. Prefer
				// the new `architects` collection (Spec 786 Phase 5); fall back
				// to the scalar `architect` for older Tower versions.
				const architects = state?.architects ?? (state?.architect ? [state.architect] : []);
				const match = architects.find(a => a.name === targetName);
				const fallback = targetName === 'main' ? architects[0] : undefined;
				const target = match ?? fallback;
				if (target?.terminalId) {
					await terminalManager?.openArchitect(target.terminalId, targetName, true);
				} else {
					vscode.window.showWarningMessage(`Codev: No '${targetName}' architect found — is the workspace activated?`);
				}
			} catch {
				vscode.window.showErrorMessage('Codev: Failed to get workspace state');
			}
		}),
		// Spec 786 Phase 6: remove a sibling architect via the REST endpoint
		// from Phase 4. Wired to the right-click context menu on sibling
		// entries (`viewItem == workspace-architect-sibling`) — see
		// package.json's menus contribution. Refuses to remove `main`.
		regCli('codev.removeArchitect', async (arg: vscode.TreeItem | string | undefined) => {
				let name: string | undefined;
			if (typeof arg === 'string') {
				name = arg;
			} else if (arg instanceof vscode.TreeItem && typeof arg.label === 'string') {
				name = arg.label;
			}
			if (!name) {
				vscode.window.showErrorMessage('Codev: Could not determine which architect to remove.');
				return;
			}
			if (name === 'main') {
				vscode.window.showErrorMessage("Codev: Cannot remove the default 'main' architect.");
				return;
			}
			const client = connectionManager?.getClient();
			const workspacePath = connectionManager?.getWorkspacePath();
			if (!client || !workspacePath || connectionManager?.getState() !== 'connected') {
				vscode.window.showErrorMessage('Codev: Not connected to Tower');
				return;
			}
			const confirm = await vscode.window.showInformationMessage(
				`Remove architect '${name}'?`,
				{ modal: true, detail: `The terminal will be closed and the architect will be deregistered. Any in-flight builders spawned by '${name}' will fall back to 'main' for messaging.` },
				'Remove',
			);
			if (confirm !== 'Remove') { return; }
			try {
				const result = await client.removeArchitect(workspacePath, name);
				if (result.ok) {
					vscode.window.showInformationMessage(`Codev: Removed architect '${name}'.`);
					// Spec 786 Phase 6: refresh the sidebar so the removed
					// sibling disappears from the Architects tree immediately.
					// Without this, the expanded section would stay stale
					// until another SSE event happened to fire.
					workspaceProvider.refresh();
				} else {
					vscode.window.showErrorMessage(`Codev: ${result.error ?? `Failed to remove architect '${name}'.`}`);
				}
			} catch (err) {
				vscode.window.showErrorMessage(`Codev: Failed to remove architect '${name}': ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
		reg('codev.openBuilderTerminal', async () => {
			const client = connectionManager?.getClient();
			const workspacePath = connectionManager?.getWorkspacePath();
			if (!client || !workspacePath || connectionManager?.getState() !== 'connected') {
				vscode.window.showErrorMessage('Codev: Not connected to Tower');
				return;
			}
			try {
				const [overview, state] = await Promise.all([
					client.getOverview(workspacePath),
					client.getWorkspaceState(workspacePath),
				]);
				const rows = buildBuilderPickRows(overview?.builders ?? [], state?.builders ?? []);
				if (rows.length === 0) {
					vscode.window.showWarningMessage('Codev: No builder terminals available');
					return;
				}
				const picked = await vscode.window.showQuickPick(rows, { placeHolder: 'Select a builder' });
				if (picked) {
					await terminalManager?.openBuilder(picked.terminalId!, picked.id, `Codev: ${picked.name}`, true);
				}
			} catch {
				vscode.window.showErrorMessage('Codev: Failed to get builders');
			}
		}),
		reg('codev.newShell', async () => {
			const client = connectionManager?.getClient();
			const workspacePath = connectionManager?.getWorkspacePath();
			if (!client || !workspacePath || connectionManager?.getState() !== 'connected') {
				vscode.window.showErrorMessage('Codev: Not connected to Tower');
				return;
			}
			try {
				const result = await client.createShellTab(workspacePath);
				if (result?.terminalId) {
					const shellNum = (terminalManager?.getTerminalCount() ?? 0) + 1;
					await terminalManager?.openShell(result.terminalId, shellNum);
				}
			} catch {
				vscode.window.showErrorMessage('Codev: Failed to create shell');
			}
		}),
		reg('codev.openBuilderById', async (arg: vscode.TreeItem | string | undefined) => {
			// Left-click on a tree item passes b.id (string) via item.command.arguments;
			// right-click context-menu invocations pass the BuilderTreeItem itself.
			const roleOrId = extractBuilderId(arg);
			if (!roleOrId) { return; }
			await terminalManager?.openBuilderByRoleOrId(roleOrId, true);
		}),
		reg('codev.openBuilderRow', async (item: unknown) => {
			// Builder-row single-click does BOTH: opens the terminal and expands
			// the row (the file list). Expansion is via reveal(expand:true) which
			// fires onDidExpandElement — the accordion handler picks that up and
			// collapses peers when the setting is on. focus:false keeps the
			// terminal focused, not the tree.
			if (!(item instanceof BuilderTreeItem)) { return; }
			await terminalManager?.openBuilderByRoleOrId(item.builderId, true);
			try {
				await buildersView!.reveal(item, { expand: true, select: false, focus: false });
			} catch {
				// Benign if the row is no longer present (e.g. mid-cleanup).
			}
		}),
		regCli('codev.spawnBuilder', (arg: vscode.TreeItem | string | undefined) =>
			spawnBuilder(extractIssueId(arg))),
		reg('codev.openBacklogIssue', (arg: vscode.TreeItem | undefined) => {
			if (arg instanceof BacklogTreeItem) {
				void vscode.env.openExternal(vscode.Uri.parse(arg.issueUrl));
			}
		}),
		reg('codev.copyBacklogIssueNumber', async (arg: vscode.TreeItem | undefined) => {
			if (arg instanceof BacklogTreeItem) {
				await vscode.env.clipboard.writeText(`#${arg.issueId}`);
				vscode.window.showInformationMessage(`Codev: Copied #${arg.issueId}`);
			}
		}),
		reg('codev.viewBacklogIssue', (arg: vscode.TreeItem | string | undefined) =>
			viewBacklogIssue(connectionManager!, extractIssueId(arg))),
		reg('codev.openBacklogSearch', () =>
			BacklogSearchPanel.createOrShow(connectionManager!, overviewCache, context.extensionUri)),
		reg('codev.searchBacklog', () => searchBacklog(overviewCache)),
		reg('codev.openMarkdownPreview', async () => {
			const uri = vscode.window.activeTextEditor?.document.uri;
			if (!uri) {
				vscode.window.showInformationMessage(
					'Codev: open a spec/plan/review markdown file first, then run Open Markdown Preview.',
				);
				return;
			}
			await vscode.commands.executeCommand(
				'vscode.openWith', uri, MarkdownPreviewProvider.viewType, vscode.ViewColumn.Beside,
			);
		}),
		regCli('codev.referenceIssueInArchitect', async (arg: IssueCommandArg) => {
			// Inline-button action on a backlog row: open + focus the architect
			// terminal, then type `#<id> "<title>" ` into its prompt without
			// submitting, so the user can keep typing their context before
			// hitting Enter. Falls back to `#<id> ` when the title isn't
			// available (e.g. row-click path that passes only the id string).
			const issueId = extractIssueId(arg);
			if (!issueId) { return; }
			const title = extractIssueTitle(arg);
			await vscode.commands.executeCommand('codev.openArchitectTerminal');
			const ok = terminalManager?.injectArchitectText(buildArchitectReferenceInjection(issueId, title));
			if (!ok) {
				vscode.window.showWarningMessage('Codev: Architect terminal not available');
			}
		}),
		regCli('codev.referencePRInArchitect', async (arg: vscode.TreeItem | undefined) => {
			// Inline-button action on a PR row in the Pull Requests sidebar:
			// mirror of codev.referenceIssueInArchitect for PR rows (#1043).
			if (!(arg instanceof PullRequestTreeItem)) { return; }
			await vscode.commands.executeCommand('codev.openArchitectTerminal');
			const ok = terminalManager?.injectArchitectText(buildArchitectReferenceInjection(arg.prId, arg.prTitle));
			if (!ok) {
				vscode.window.showWarningMessage('Codev: Architect terminal not available');
			}
		}),
		regCli('codev.sendMessage', () => sendMessage(connectionManager!)),
		regCli('codev.approveGate', (arg: vscode.TreeItem | string | undefined, options?: { skipConfirmation?: boolean }) =>
			approveGate(connectionManager!, overviewCache, extractBuilderId(arg), options)),
		regCli('codev.cleanupBuilder', () => cleanupBuilder(connectionManager!, overviewCache)),
		regCli('codev.openWorktreeWindow', (arg: vscode.TreeItem | string | undefined) =>
			openWorktreeWindow(connectionManager!, extractBuilderId(arg))),
		reg('codev.viewDiff', (arg: vscode.TreeItem | string | undefined) =>
			viewDiff(connectionManager!, extractBuilderId(arg))),
		// CodeLens-only inject (#789): open + focus the builder terminal, then
		// type the file/hunk reference into its prompt without submitting, so
		// the reviewer keeps typing feedback before hitting Enter. Mirrors
		// `codev.referenceIssueInArchitect`. Not declared in
		// `contributes.commands` → never appears in the Command Palette.
		reg('codev.forwardToBuilder', async (builderId: string, text: string) => {
			// openBuilderByRoleOrId resolves to the canonical id and runs the
			// no-terminal recovery flow on a miss; inject against that id so the
			// terminal lookup hits the same key that was just opened.
			const resolvedId = await terminalManager?.openBuilderByRoleOrId(builderId, true);
			if (resolvedId && !terminalManager?.injectBuilderText(resolvedId, text)) {
				vscode.window.showWarningMessage('Codev: Builder terminal not available');
			}
		}),
		// Right-click "Forward Selection to Builder" (#789): forward an arbitrary
		// selected range when symbol/file lenses aren't granular enough. Unlike
		// the CodeLens, a context-menu action works inside the multi-file View
		// Diff editor too. Scoped via the `codev.activeEditorIsBuilderFile`
		// context key + the built-in `editorHasSelection` in its `when` clause.
		reg('codev.forwardSelectionToBuilder', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return; }
			const entry = getDiffInjectEntry(editor.document.uri.fsPath);
			if (!entry) { return; }
			const sel = editor.selection;
			if (sel.isEmpty) { return; }
			const start = sel.start.line + 1;
			// A selection ending at column 0 of a line doesn't include that line.
			const end = sel.end.character === 0 && sel.end.line > sel.start.line
				? sel.end.line
				: sel.end.line + 1;
			const text = buildBuilderRangeRef(entry.relPath, start, end);
			const resolvedId = await terminalManager?.openBuilderByRoleOrId(entry.builderId, true);
			if (resolvedId && !terminalManager?.injectBuilderText(resolvedId, text)) {
				vscode.window.showWarningMessage('Codev: Builder terminal not available');
			}
		}),
		reg('codev.openBuilderFileDiff', async (arg: unknown) => {
			if (!(arg instanceof BuilderFileTreeItem)) { return; }
			await openBuilderFileDiff(context, {
				worktreePath: arg.worktreePath,
				baseRef: arg.baseRef,
				builderId: arg.builderId,
				plan: arg.plan,
			});
		}),
		// Cross-file navigation in a builder diff review (#1060): walk the
		// builder's changed-file list top-to-bottom (next) / bottom-to-top (prev),
		// opening each file's per-file diff. CLI-independent — operates on editor
		// state + the shared diff cache, not Tower.
		reg('codev.diffNextFile', () =>
			navigateDiff(1, { context, overviewCache, diffCache: builderDiffCache })),
		reg('codev.diffPreviousFile', () =>
			navigateDiff(-1, { context, overviewCache, diffCache: builderDiffCache })),
		regCli('codev.runWorktreeDev', (arg: vscode.TreeItem | string | undefined) =>
			runWorktreeDev(connectionManager!, terminalManager!, extractBuilderId(arg))),
		regCli('codev.stopWorktreeDev', () =>
			stopWorktreeDev(connectionManager!, terminalManager!)),
		regCli('codev.runWorkspaceDev', () =>
			runWorkspaceDev(connectionManager!, terminalManager!)),
		regCli('codev.stopWorkspaceDev', () =>
			stopWorkspaceDev(connectionManager!, terminalManager!)),
		regCli('codev.devServer.stop', () =>
			stopDevServer(connectionManager!, terminalManager!)),
		regCli('codev.devServer.restart', () =>
			restartDevServer(connectionManager!, terminalManager!)),
		regCli('codev.devServer.switchTarget', () =>
			switchDevTarget(connectionManager!, terminalManager!)),
		reg('codev.devServer.showSidebar', () =>
			showCodevSidebar()),
		reg('codev.devServer.hideSidebar', () =>
			hideCodevSidebar()),
		reg('codev.openDevUrl', (urlArg?: unknown) =>
			openDevUrl(connectionManager!, typeof urlArg === 'string' ? urlArg : undefined)),
		reg('codev.pasteImage', () =>
			pasteImage(connectionManager!, terminalManager!)),
		reg('codev.refreshTeam', () => teamProvider.refresh()),
		reg('codev.openWorktreeFolder', (arg: vscode.TreeItem | string | undefined) =>
			openWorktreeFolder(connectionManager!, extractBuilderId(arg))),
		regCli('codev.runWorktreeSetup', (arg: vscode.TreeItem | string | undefined) =>
			runWorktreeSetup(connectionManager!, extractBuilderId(arg))),
		reg('codev.viewPlanFile', (arg: vscode.TreeItem | string | undefined) =>
			viewPlanFile(connectionManager!, extractBuilderId(arg))),
		reg('codev.viewSpecFile', (arg: vscode.TreeItem | string | undefined) =>
			viewSpecFile(connectionManager!, extractBuilderId(arg))),
		reg('codev.viewReviewFile', (arg: vscode.TreeItem | string | undefined) =>
			viewReviewFile(connectionManager!, extractBuilderId(arg))),
		reg('codev.refreshOverview', () => overviewCache.refresh()),
		reg('codev.enableBuildersAutoCollapse', () =>
			vscode.workspace.getConfiguration('codev').update('buildersAutoCollapse', true, vscode.ConfigurationTarget.Global)),
		reg('codev.disableBuildersAutoCollapse', () =>
			vscode.workspace.getConfiguration('codev').update('buildersAutoCollapse', false, vscode.ConfigurationTarget.Global)),
		reg('codev.enableBuildersFileTreeMode', () =>
			vscode.workspace.getConfiguration('codev').update('buildersFileViewAsTree', true, vscode.ConfigurationTarget.Global)),
		reg('codev.disableBuildersFileTreeMode', () =>
			vscode.workspace.getConfiguration('codev').update('buildersFileViewAsTree', false, vscode.ConfigurationTarget.Global)),
		reg('codev.showBacklogAll', () =>
			vscode.workspace.getConfiguration('codev').update('backlogShowAll', true, vscode.ConfigurationTarget.Global)),
		reg('codev.showBacklogMineOnly', () =>
			vscode.workspace.getConfiguration('codev').update('backlogShowAll', false, vscode.ConfigurationTarget.Global)),
		reg('codev.groupBuildersByArea', () =>
			vscode.workspace.getConfiguration('codev').update('buildersGroupBy', 'area', vscode.ConfigurationTarget.Global)),
		reg('codev.groupBuildersByPhase', () =>
			vscode.workspace.getConfiguration('codev').update('buildersGroupBy', 'stage', vscode.ConfigurationTarget.Global)),
		reg('codev.reconnect', () => connectionManager?.reconnect()),
		regCli('codev.connectTunnel', () => connectTunnel(connectionManager!)),
		regCli('codev.disconnectTunnel', () => disconnectTunnel(connectionManager!)),
		regCli('codev.cronTasks', () => listCronTasks(connectionManager!)),
		reg('codev.addReviewComment', () => addReviewComment(overviewCache)),
			// #791: re-verify the codev CLI after the user installs / upgrades it.
			// Unguarded — it's the recovery path. The Status-view row refreshes via
			// the preflight `onPreflightChange` event that `recheckCli` fires.
			reg('codev.recheckCli', () => recheckCli()),
	);

	// Read-only `codev-issue:` content provider backing the "View Issue"
	// backlog action — renders issue body + comments as markdown preview.
	// Reuses overviewCache's existing 60s + SSE heartbeat to passively
	// refresh open previews; no new timer.
	activateIssueView(context, connectionManager, overviewCache);

	// Read-only `codev-diff:` content provider backing the "View Diff"
	// builder action — serves base-branch blob content for the diff editor
	// without relying on the Git extension's worktree discovery.
	activateDiffView(context);

	// CodeLens "Forward to Builder" actions inside the View Diff editor (#789).
	// The backing command `codev.forwardToBuilder` is registered below and
	// deliberately NOT declared in `contributes.commands`, so it stays out of
	// the Command Palette (codelens-only entry point).
	activateDiffInjectCodeLens(context);

	// Review comment decorations
	activateReviewDecorations(context);

	// Inline plan-review comments via VSCode Comments API. Gutter "+" on
	// any line in codev/plans|specs|reviews/*.md; submit writes
	// `<!-- REVIEW(@<currentUser>): ... -->` inline (author from
	// OverviewData.currentUser, falling back to "architect"), matching the
	// format produced by `codev.addReviewComment` and review.json snippet.
	activateReviewComments(context, overviewCache);

	// Codev Markdown Preview (#859): a read-only custom editor that renders a
	// spec/plan/review in the shared artifact-canvas and adds review comments
	// from the rendered surface. Opt-in via "Reopen With…" or
	// `codev.openMarkdownPreview`; `priority: "option"` keeps the default `.md`
	// editor and built-in preview untouched.
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(
			MarkdownPreviewProvider.viewType,
			new MarkdownPreviewProvider(context.extensionUri, overviewCache),
			{
				webviewOptions: { retainContextWhenHidden: true },
				supportsMultipleEditorsPerDocument: false,
			},
		),
	);

	// Toast on new gate-pending — surfaces blocked builders without forcing the
	// user to watch the Builders tree. Respects `codev.gateToasts.enabled`.
	activateGateToasts(context, overviewCache);

	// Auto-open builder terminals on Tower spawn events
	const builderSpawnHandler = new BuilderSpawnHandler(connectionManager, terminalManager, outputChannel);
	context.subscriptions.push(
		connectionManager.onSSEEvent(({ type, data }) => builderSpawnHandler.handle(type, data)),
	);

	// Make builder names clickable in any terminal output
	context.subscriptions.push(
		vscode.window.registerTerminalLinkProvider(
			new BuilderTerminalLinkProvider(terminalManager),
		),
	);

	// Make the give-up message's reconnect affordance clickable (#939)
	context.subscriptions.push(
		vscode.window.registerTerminalLinkProvider(
			new ReconnectTerminalLinkProvider(terminalManager),
		),
	);

	// CLI preflight (#791): verify the codev CLI is installed and >= this
	// extension's version. Fire-and-forget so activation isn't blocked — the
	// probe self-bounds at the `codev.cliVersionTimeoutMs` budget (#1024) and
	// caches its result for the session. Uses
	// detectWorkspacePath() directly (connectionManager.getWorkspacePath() isn't
	// populated until initialize() resolves, which may wait on Tower auto-start).
	runPreflight(context, detectWorkspacePath(), outputChannel);

	// Connect
	await connectionManager.initialize();
}

export function deactivate() {
	terminalManager?.dispose();
	terminalManager = null;
	connectionManager?.dispose();
	connectionManager = null;
	outputChannel = null;
	statusBarItem = null;
}
