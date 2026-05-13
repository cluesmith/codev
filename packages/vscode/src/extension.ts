import * as vscode from 'vscode';
import { ConnectionManager } from './connection-manager.js';
import { TerminalManager } from './terminal-manager.js';
import { OverviewCache } from './views/overview-data.js';
import { spawnBuilder } from './commands/spawn.js';
import { sendMessage } from './commands/send.js';
import { approveGate } from './commands/approve.js';
import { cleanupBuilder } from './commands/cleanup.js';
import { reviewDiff } from './commands/review-diff.js';
import { runWorktreeDev } from './commands/run-worktree-dev.js';
import { stopWorktreeDev } from './commands/stop-worktree-dev.js';
import { openWorktreeFolder } from './commands/open-worktree-folder.js';
import { runWorktreeSetup } from './commands/run-worktree-setup.js';
import { viewPlanFile } from './commands/view-artifact.js';
import { connectTunnel, disconnectTunnel } from './commands/tunnel.js';
import { listCronTasks } from './commands/cron.js';
import { addReviewComment } from './commands/review.js';
import { activateGateToasts } from './notifications/gate-toast.js';
import { activateReviewDecorations } from './review-decorations.js';
import { BuilderSpawnHandler } from './builder-spawn-handler.js';
import { BuilderTerminalLinkProvider } from './terminal-link-provider.js';
import { NeedsAttentionProvider } from './views/needs-attention.js';
import { BuildersProvider } from './views/builders.js';
import { PullRequestsProvider } from './views/pull-requests.js';
import { BacklogProvider } from './views/backlog.js';
import { RecentlyClosedProvider } from './views/recently-closed.js';
import { TeamProvider } from './views/team.js';
import { StatusProvider } from './views/status.js';
import { WorkspaceProvider } from './views/workspace.js';
import { BuilderTreeItem } from './views/builder-tree-item.js';

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

	// Terminal Manager
	terminalManager = new TerminalManager(connectionManager, outputChannel, context.extensionUri);
	context.subscriptions.push({ dispose: () => terminalManager?.dispose() });

	// Update status bar with builder/gate counts
	const updateStatusBarCounts = () => {
		if (!statusBarItem || connectionManager?.getState() !== 'connected') { return; }
		const data = overviewCache.getData();
		if (!data) { return; }
		const builderCount = data.builders.length;
		const blockedCount = data.builders.filter(b => b.blocked).length;
		statusBarItem.text = blockedCount > 0
			? `$(server) Codev: ${builderCount} builders · $(bell) ${blockedCount} blocked`
			: `$(server) Codev: ${builderCount} builders`;
	};

	// Sidebar TreeViews
	const overviewCache = new OverviewCache(connectionManager);
	context.subscriptions.push({ dispose: () => overviewCache.dispose() });
	overviewCache.onDidChange(updateStatusBarCounts);

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('codev.workspace', new WorkspaceProvider(connectionManager)),
		vscode.window.registerTreeDataProvider('codev.needsAttention', new NeedsAttentionProvider(overviewCache)),
		vscode.window.registerTreeDataProvider('codev.builders', new BuildersProvider(overviewCache)),
		vscode.window.registerTreeDataProvider('codev.pullRequests', new PullRequestsProvider(overviewCache)),
		vscode.window.registerTreeDataProvider('codev.backlog', new BacklogProvider(overviewCache)),
		vscode.window.registerTreeDataProvider('codev.recentlyClosed', new RecentlyClosedProvider(overviewCache)),
		vscode.window.registerTreeDataProvider('codev.team', new TeamProvider(connectionManager)),
		vscode.window.registerTreeDataProvider('codev.status', new StatusProvider(connectionManager)),
	);

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
		vscode.commands.registerCommand('codev.spawnBuilder', () => spawnBuilder()),
		vscode.commands.registerCommand('codev.sendMessage', () => sendMessage(connectionManager!)),
		vscode.commands.registerCommand('codev.approveGate', (arg: vscode.TreeItem | string | undefined) =>
			approveGate(connectionManager!, overviewCache, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.cleanupBuilder', () => cleanupBuilder(connectionManager!, overviewCache)),
		vscode.commands.registerCommand('codev.reviewDiff', (arg: vscode.TreeItem | string | undefined) =>
			reviewDiff(connectionManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.runWorktreeDev', (arg: vscode.TreeItem | string | undefined) =>
			runWorktreeDev(connectionManager!, terminalManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.stopWorktreeDev', () =>
			stopWorktreeDev(connectionManager!, terminalManager!)),
		vscode.commands.registerCommand('codev.openWorktreeFolder', (arg: vscode.TreeItem | string | undefined) =>
			openWorktreeFolder(connectionManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.runWorktreeSetup', (arg: vscode.TreeItem | string | undefined) =>
			runWorktreeSetup(connectionManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.viewPlanFile', (arg: vscode.TreeItem | string | undefined) =>
			viewPlanFile(connectionManager!, extractBuilderId(arg))),
		vscode.commands.registerCommand('codev.refreshOverview', () => overviewCache.refresh()),
		vscode.commands.registerCommand('codev.reconnect', () => connectionManager?.reconnect()),
		vscode.commands.registerCommand('codev.connectTunnel', () => connectTunnel(connectionManager!)),
		vscode.commands.registerCommand('codev.disconnectTunnel', () => disconnectTunnel(connectionManager!)),
		vscode.commands.registerCommand('codev.cronTasks', () => listCronTasks(connectionManager!)),
		vscode.commands.registerCommand('codev.addReviewComment', () => addReviewComment()),
	);

	// Review comment decorations
	activateReviewDecorations(context);

	// Toast on new gate-pending — surfaces blocked builders without forcing the
	// user to watch the Needs Attention tree. Respects `codev.gateToasts.enabled`.
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
