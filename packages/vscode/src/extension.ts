import * as vscode from 'vscode';
import { ConnectionManager } from './connection-manager.js';
import { TerminalManager } from './terminal-manager.js';
import { encodeWorkspacePath } from '@cluesmith/codev-core/workspace';

let connectionManager: ConnectionManager | null = null;
let terminalManager: TerminalManager | null = null;
let outputChannel: vscode.OutputChannel | null = null;
let statusBarItem: vscode.StatusBarItem | null = null;

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
	terminalManager = new TerminalManager(connectionManager, outputChannel);
	context.subscriptions.push({ dispose: () => terminalManager?.dispose() });

	// Commands
	context.subscriptions.push(
		vscode.commands.registerCommand('codev.helloWorld', () => {
			const state = connectionManager?.getState() ?? 'unknown';
			const workspace = connectionManager?.getWorkspacePath() ?? 'none';
			vscode.window.showInformationMessage(`Codev: ${state} | Workspace: ${workspace}`);
		}),
		vscode.commands.registerCommand('codev.openArchitectTerminal', async () => {
			const client = connectionManager?.getClient();
			if (!client || connectionManager?.getState() !== 'connected') {
				vscode.window.showErrorMessage('Codev: Not connected to Tower');
				return;
			}
			// Find architect terminal from workspace state
			const workspacePath = connectionManager?.getWorkspacePath();
			if (!workspacePath) { return; }
			try {
				const encoded = encodeWorkspacePath(workspacePath);
				const state = await client.request<{ architect: { terminalId?: string } | null }>(`/workspace/${encoded}/api/state`);
				if (state.ok && state.data?.architect?.terminalId) {
					await terminalManager?.openArchitect(state.data.architect.terminalId);
				} else {
					vscode.window.showWarningMessage('Codev: No architect terminal found');
				}
			} catch {
				vscode.window.showErrorMessage('Codev: Failed to get workspace state');
			}
		}),
		vscode.commands.registerCommand('codev.openBuilderTerminal', async () => {
			const client = connectionManager?.getClient();
			if (!client || connectionManager?.getState() !== 'connected') {
				vscode.window.showErrorMessage('Codev: Not connected to Tower');
				return;
			}
			try {
				const workspacePath = connectionManager?.getWorkspacePath();
				if (!workspacePath) { return; }
				const encoded = encodeWorkspacePath(workspacePath);
				const state = await client.request<{ builders: Array<{ id: string; name: string; terminalId?: string }> }>(`/workspace/${encoded}/api/state`);
				if (!state.ok || !state.data?.builders?.length) {
					vscode.window.showWarningMessage('Codev: No builders found');
					return;
				}
				const builders = state.data.builders.filter(b => b.terminalId);
				if (builders.length === 0) {
					vscode.window.showWarningMessage('Codev: No builder terminals available');
					return;
				}
				const picked = await vscode.window.showQuickPick(
					builders.map(b => ({ label: b.name, id: b.id, terminalId: b.terminalId! })),
					{ placeHolder: 'Select a builder' },
				);
				if (picked) {
					await terminalManager?.openBuilder(picked.terminalId, picked.id, `Codev: ${picked.label}`);
				}
			} catch {
				vscode.window.showErrorMessage('Codev: Failed to get builders');
			}
		}),
		vscode.commands.registerCommand('codev.newShell', async () => {
			const client = connectionManager?.getClient();
			if (!client || connectionManager?.getState() !== 'connected') {
				vscode.window.showErrorMessage('Codev: Not connected to Tower');
				return;
			}
			try {
				const workspacePath = connectionManager?.getWorkspacePath();
				if (!workspacePath) { return; }
				const encoded = encodeWorkspacePath(workspacePath);
				const result = await client.request<{ id: string; name: string; terminalId: string }>(`/workspace/${encoded}/api/tabs/shell`, {
					method: 'POST',
					body: JSON.stringify({}),
				});
				if (result.ok && result.data?.terminalId) {
					const shellNum = (terminalManager?.getTerminalCount() ?? 0) + 1;
					await terminalManager?.openShell(result.data.terminalId, shellNum);
				}
			} catch {
				vscode.window.showErrorMessage('Codev: Failed to create shell');
			}
		}),
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
