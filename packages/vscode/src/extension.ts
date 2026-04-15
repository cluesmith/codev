import * as vscode from 'vscode';
import { ConnectionManager } from './connection-manager.js';

let connectionManager: ConnectionManager | null = null;
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

	// Placeholder command (replaced in Phase 5)
	const disposable = vscode.commands.registerCommand('codev.helloWorld', () => {
		const state = connectionManager?.getState() ?? 'unknown';
		const workspace = connectionManager?.getWorkspacePath() ?? 'none';
		vscode.window.showInformationMessage(`Codev: ${state} | Workspace: ${workspace}`);
	});
	context.subscriptions.push(disposable);

	// Connect
	await connectionManager.initialize();
}

export function deactivate() {
	connectionManager?.dispose();
	connectionManager = null;
	outputChannel = null;
	statusBarItem = null;
}
