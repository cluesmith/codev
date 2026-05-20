import * as vscode from 'vscode';
import { ConnectionManager } from './connection-manager.js';
import { TerminalManager } from './terminal-manager.js';
import { OverviewCache } from './views/overview-data.js';
import { spawnBuilder } from './commands/spawn.js';
import { sendMessage } from './commands/send.js';
import { approveGate } from './commands/approve.js';
import { cleanupBuilder } from './commands/cleanup.js';
import { openWorktreeWindow } from './commands/open-worktree-window.js';
import { viewDiff, activateDiffView, diffUrisForChange } from './commands/view-diff.js';
import { runWorktreeDev } from './commands/run-worktree-dev.js';
import { stopWorktreeDev } from './commands/stop-worktree-dev.js';
import { runWorkspaceDev, stopWorkspaceDev } from './commands/run-workspace-dev.js';
import { openDevUrl } from './commands/open-dev-url.js';
import { pasteImage } from './commands/paste-image.js';
import { openWorktreeFolder } from './commands/open-worktree-folder.js';
import { runWorktreeSetup } from './commands/run-worktree-setup.js';
import { viewPlanFile } from './commands/view-artifact.js';
import { activateIssueView, viewBacklogIssue } from './commands/view-issue.js';
import { connectTunnel, disconnectTunnel } from './commands/tunnel.js';
import { listCronTasks } from './commands/cron.js';
import { addReviewComment } from './commands/review.js';
import { activateGateToasts } from './notifications/gate-toast.js';
import { activateReviewDecorations } from './review-decorations.js';
import { activateReviewComments } from './comments/plan-review.js';
import { BuilderSpawnHandler } from './builder-spawn-handler.js';
import { BuilderTerminalLinkProvider } from './terminal-link-provider.js';
import { isIdleWaiting } from '@cluesmith/codev-core/builder-helpers';
import { BuildersProvider } from './views/builders.js';
import { PullRequestsProvider } from './views/pull-requests.js';
import { BacklogProvider, spawnableBacklog } from './views/backlog.js';
import { RecentlyClosedProvider } from './views/recently-closed.js';
import { TeamProvider } from './views/team.js';
import { StatusProvider } from './views/status.js';
import { WorkspaceProvider } from './views/workspace.js';
import { BuilderTreeItem } from './views/builder-tree-item.js';
import { BuilderFileTreeItem } from './views/builder-file-tree-item.js';
import { BuilderDiffCache } from './views/builder-diff-cache.js';
import { BuilderFileDecorationProvider } from './views/builder-file-decoration.js';
import { BacklogTreeItem } from './views/backlog-tree-item.js';

let connectionManager: ConnectionManager | null = null;
let terminalManager: TerminalManager | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;

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
function extractIssueId(arg: vscode.TreeItem | string | undefined): string | undefined {
	if (typeof arg === 'string') { return arg; }
	if (arg instanceof BacklogTreeItem) { return arg.issueId; }
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
	const updateListViewTitles = () => {
		const data = overviewCache.getData();
		const withCount = (base: string, n: number | undefined) =>
			typeof n === 'number' ? `${base} (${n})` : base;
		if (buildersView) { buildersView.title = withCount('Builders', data?.builders.length); }
		if (pullRequestsView) { pullRequestsView.title = withCount('Pull Requests', data?.pendingPRs.length); }
		if (backlogView) { backlogView.title = withCount('Backlog', data ? spawnableBacklog(data.backlog).length : undefined); }
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

	// Close builder/dev terminal tabs when their builder disappears from Tower
	// state. Covers cleanup triggered from the VSCode "Cleanup Builder" command,
	// `afx cleanup` on the CLI, or any other removal path — otherwise Tower
	// kills the PTY but the VSCode tab lingers as a dead "Process exited" entry.
	// Uses a present→absent diff so freshly-spawned builders whose first state
	// refresh hasn't landed aren't pre-emptively closed; the inFlight guard
	// drops overlapping state fetches so a stale response can't overwrite a
	// fresher prevBuilderIds.
	let prevBuilderIds: Set<string> | null = null;
	let pruneInFlight = false;
	const pruneClosedBuilderTerminals = async () => {
		if (pruneInFlight) { return; }
		if (connectionManager?.getState() !== 'connected') { return; }
		const client = connectionManager.getClient();
		const workspacePath = connectionManager.getWorkspacePath();
		if (!client || !workspacePath) { return; }
		pruneInFlight = true;
		try {
			const state = await client.getWorkspaceState(workspacePath);
			if (!state?.builders) { return; }
			const currIds = new Set(state.builders.map(b => b.id));
			if (prevBuilderIds !== null) {
				for (const prev of prevBuilderIds) {
					if (!currIds.has(prev)) {
						terminalManager?.closeBuilderTerminal(prev);
					}
				}
			}
			prevBuilderIds = currIds;
		} catch {
			// Transient state-fetch failures must not drop prevBuilderIds —
			// next successful tick will resync.
		} finally {
			pruneInFlight = false;
		}
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

	// List views use createTreeView so their title can carry a live item
	// count; the rest stay on registerTreeDataProvider.
	buildersView = vscode.window.createTreeView('codev.builders', { treeDataProvider: new BuildersProvider(overviewCache, builderDiffCache) });
	pullRequestsView = vscode.window.createTreeView('codev.pullRequests', { treeDataProvider: new PullRequestsProvider(overviewCache) });
	backlogView = vscode.window.createTreeView('codev.backlog', { treeDataProvider: new BacklogProvider(overviewCache) });
	recentlyClosedView = vscode.window.createTreeView('codev.recentlyClosed', { treeDataProvider: new RecentlyClosedProvider(overviewCache) });
	// Seed the badge so it's correct immediately if overview data is already
	// cached, instead of waiting for the next onDidChange tick.
	updateActivityBadge();
	const teamProvider = new TeamProvider(connectionManager);
	context.subscriptions.push(
		buildersView,
		pullRequestsView,
		backlogView,
		recentlyClosedView,
		vscode.window.registerTreeDataProvider('codev.workspace', new WorkspaceProvider(connectionManager, terminalManager!)),
		vscode.window.registerTreeDataProvider('codev.team', teamProvider),
		vscode.window.registerTreeDataProvider('codev.status', new StatusProvider(connectionManager)),
	);

	// Builders accordion: expanding one builder auto-collapses the others so a
	// reviewer can't have diffs from unrelated worktrees open at once. The
	// deterministic collapseAll+reveal pair (vs fighting VSCode's expansion
	// reconciliation) is guarded against the expand/collapse events it itself
	// generates. Toggle via the header button / `codev.buildersAutoCollapse`.
	const readAccordion = () =>
		vscode.workspace.getConfiguration('codev').get<boolean>('buildersAutoCollapse', true);
	let accordionOn = readAccordion();
	let reconciling = false;
	// The builder we've made (or are making) the single open one. The id check
	// is the real guard: `reveal({expand:true})` re-fires onDidExpandElement
	// for the same builder, and that re-fire can land *after* the await chain
	// (so `reconciling` is already false). Matching builderId makes the
	// re-fire a no-op regardless of timing — `reconciling` only debounces
	// rapid expands of *different* builders.
	let openBuilderId: string | undefined;
	vscode.commands.executeCommand('setContext', 'codev.buildersAutoCollapse', accordionOn);
	context.subscriptions.push(
		buildersView.onDidExpandElement(async (e) => {
			if (!accordionOn) { return; }
			if (!(e.element instanceof BuilderTreeItem)) { return; }
			if (e.element.builderId === openBuilderId || reconciling) { return; }
			openBuilderId = e.element.builderId;
			reconciling = true;
			try {
				await vscode.commands.executeCommand('workbench.actions.treeView.codev.builders.collapseAll');
				await buildersView!.reveal(e.element, { expand: true, select: false, focus: false });
			} finally {
				reconciling = false;
			}
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('codev.buildersAutoCollapse')) { return; }
			accordionOn = readAccordion();
			vscode.commands.executeCommand('setContext', 'codev.buildersAutoCollapse', accordionOn);
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

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('codev.helloWorld', () => {
			const state = connectionManager?.getState() ?? 'unknown';
			const workspace = connectionManager?.getWorkspacePath() ?? 'none';
			vscode.window.showInformationMessage(`Codev: ${state} | Workspace: ${workspace}`);
		}),
		vscode.commands.registerCommand('codev.openArchitectTerminal', async () => {
			const client = connectionManager?.getClient();
			const workspacePath = connectionManager?.getWorkspacePath();
			if (!client || !workspacePath || connectionManager?.getState() !== 'connected') {
				vscode.window.showErrorMessage('Codev: Not connected to Tower');
				return;
			}
			try {
				const state = await client.getWorkspaceState(workspacePath);
				if (state?.architect?.terminalId) {
					await terminalManager?.openArchitect(state.architect.terminalId, true);
				} else {
					vscode.window.showWarningMessage('Codev: No architect terminal found — is the workspace activated?');
				}
			} catch {
				vscode.window.showErrorMessage('Codev: Failed to get workspace state');
			}
		}),
		vscode.commands.registerCommand('codev.openBuilderTerminal', async () => {
			const client = connectionManager?.getClient();
			const workspacePath = connectionManager?.getWorkspacePath();
			if (!client || !workspacePath || connectionManager?.getState() !== 'connected') {
				vscode.window.showErrorMessage('Codev: Not connected to Tower');
				return;
			}
			try {
				const state = await client.getWorkspaceState(workspacePath);
				const builders = state?.builders?.filter(b => b.terminalId) ?? [];
				if (builders.length === 0) {
					vscode.window.showWarningMessage('Codev: No builder terminals available');
					return;
				}
				const picked = await vscode.window.showQuickPick(
					builders.map(b => ({ label: b.name, id: b.id, terminalId: b.terminalId! })),
					{ placeHolder: 'Select a builder' },
				);
				if (picked) {
					await terminalManager?.openBuilder(picked.terminalId, picked.id, `Codev: ${picked.label}`, true);
				}
			} catch {
				vscode.window.showErrorMessage('Codev: Failed to get builders');
			}
		}),
		vscode.commands.registerCommand('codev.newShell', async () => {
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
		vscode.commands.registerCommand('codev.openBuilderById', async (arg: vscode.TreeItem | string | undefined) => {
			// Left-click on a tree item passes b.id (string) via item.command.arguments;
			// right-click context-menu invocations pass the BuilderTreeItem itself.
			const roleOrId = extractBuilderId(arg);
			if (!roleOrId) { return; }
			await terminalManager?.openBuilderByRoleOrId(roleOrId, true);
		}),
		vscode.commands.registerCommand('codev.openBuilderRow', async (item: unknown) => {
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
		vscode.commands.registerCommand('codev.spawnBuilder', (arg: vscode.TreeItem | string | undefined) =>
			spawnBuilder(extractIssueId(arg))),
		vscode.commands.registerCommand('codev.openBacklogIssue', (arg: vscode.TreeItem | undefined) => {
			if (arg instanceof BacklogTreeItem) {
				void vscode.env.openExternal(vscode.Uri.parse(arg.issueUrl));
			}
		}),
		vscode.commands.registerCommand('codev.copyBacklogIssueNumber', async (arg: vscode.TreeItem | undefined) => {
			if (arg instanceof BacklogTreeItem) {
				await vscode.env.clipboard.writeText(`#${arg.issueId}`);
				vscode.window.showInformationMessage(`Codev: Copied #${arg.issueId}`);
			}
		}),
		vscode.commands.registerCommand('codev.viewBacklogIssue', (arg: vscode.TreeItem | string | undefined) =>
			viewBacklogIssue(connectionManager!, extractIssueId(arg))),
		vscode.commands.registerCommand('codev.referenceIssueInArchitect', async (arg: vscode.TreeItem | string | undefined) => {
			// Inline-button action on a backlog row: open + focus the architect
			// terminal, then type `#<id> ` into its prompt without submitting,
			// so the user can keep typing their context before hitting Enter.
			const issueId = extractIssueId(arg);
			if (!issueId) { return; }
			await vscode.commands.executeCommand('codev.openArchitectTerminal');
			const ok = terminalManager?.injectArchitectText(`#${issueId} `);
			if (!ok) {
				vscode.window.showWarningMessage('Codev: Architect terminal not available');
			}
		}),
		vscode.commands.registerCommand('codev.sendMessage', () => sendMessage(connectionManager!)),
		vscode.commands.registerCommand('codev.approveGate', (arg: vscode.TreeItem | string | undefined, options?: { skipConfirmation?: boolean }) =>
			approveGate(connectionManager!, overviewCache, extractBuilderId(arg), options)),
		vscode.commands.registerCommand('codev.cleanupBuilder', () => cleanupBuilder(connectionManager!, overviewCache)),
		vscode.commands.registerCommand('codev.openWorktreeWindow', (arg: vscode.TreeItem | string | undefined) =>
			openWorktreeWindow(connectionManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.viewDiff', (arg: vscode.TreeItem | string | undefined) =>
			viewDiff(connectionManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.openBuilderFileDiff', async (arg: unknown) => {
			if (!(arg instanceof BuilderFileTreeItem)) { return; }
			const { left, right } = diffUrisForChange(arg.plan, { wt: arg.worktreePath, ref: arg.baseRef });
			const title = `${arg.plan.resourcePath} (#${arg.builderId})`;
			await vscode.commands.executeCommand('vscode.diff', left, right, title);
		}),
		vscode.commands.registerCommand('codev.runWorktreeDev', (arg: vscode.TreeItem | string | undefined) =>
			runWorktreeDev(connectionManager!, terminalManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.stopWorktreeDev', () =>
			stopWorktreeDev(connectionManager!, terminalManager!)),
		vscode.commands.registerCommand('codev.runWorkspaceDev', () =>
			runWorkspaceDev(connectionManager!, terminalManager!)),
		vscode.commands.registerCommand('codev.stopWorkspaceDev', () =>
			stopWorkspaceDev(connectionManager!, terminalManager!)),
		vscode.commands.registerCommand('codev.openDevUrl', (urlArg?: unknown) =>
			openDevUrl(connectionManager!, typeof urlArg === 'string' ? urlArg : undefined)),
		vscode.commands.registerCommand('codev.pasteImage', () =>
			pasteImage(connectionManager!, terminalManager!)),
		vscode.commands.registerCommand('codev.refreshTeam', () => teamProvider.refresh()),
		vscode.commands.registerCommand('codev.openWorktreeFolder', (arg: vscode.TreeItem | string | undefined) =>
			openWorktreeFolder(connectionManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.runWorktreeSetup', (arg: vscode.TreeItem | string | undefined) =>
			runWorktreeSetup(connectionManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.viewPlanFile', (arg: vscode.TreeItem | string | undefined) =>
			viewPlanFile(connectionManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.refreshOverview', () => overviewCache.refresh()),
		vscode.commands.registerCommand('codev.enableBuildersAutoCollapse', () =>
			vscode.workspace.getConfiguration('codev').update('buildersAutoCollapse', true, vscode.ConfigurationTarget.Global)),
		vscode.commands.registerCommand('codev.disableBuildersAutoCollapse', () =>
			vscode.workspace.getConfiguration('codev').update('buildersAutoCollapse', false, vscode.ConfigurationTarget.Global)),
		vscode.commands.registerCommand('codev.reconnect', () => connectionManager?.reconnect()),
		vscode.commands.registerCommand('codev.connectTunnel', () => connectTunnel(connectionManager!)),
		vscode.commands.registerCommand('codev.disconnectTunnel', () => disconnectTunnel(connectionManager!)),
		vscode.commands.registerCommand('codev.cronTasks', () => listCronTasks(connectionManager!)),
		vscode.commands.registerCommand('codev.addReviewComment', () => addReviewComment()),
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

	// Review comment decorations
	activateReviewDecorations(context);

	// Inline plan-review comments via VSCode Comments API. Gutter "+" on
	// any line in codev/plans/*.md or codev/specs/*.md; submit writes
	// `<!-- REVIEW(@architect): ... -->` inline, matching the format
	// produced by `codev.addReviewComment` and review.json snippet.
	activateReviewComments(context);

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
