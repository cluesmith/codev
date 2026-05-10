import * as vscode from 'vscode';
import { encodeWorkspacePath } from '@cluesmith/codev-core/workspace';
import type { ConnectionManager } from '../connection-manager.js';
import { getTowerAddress } from '../workspace-detector.js';

/**
 * Workspace-level entry points: architect terminal + Tower web dashboard.
 * Sits at the top of the Codev sidebar so users can launch either with
 * one click instead of hunting in the command palette.
 */
export class WorkspaceProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private connectionManager: ConnectionManager) {
    connectionManager.onStateChange(() => this.changeEmitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];

    const architect = new vscode.TreeItem('Open Architect');
    architect.iconPath = new vscode.ThemeIcon('person');
    architect.tooltip = 'Open the architect terminal';
    architect.contextValue = 'workspace-architect';
    architect.command = {
      command: 'codev.openArchitectTerminal',
      title: 'Open Architect Terminal',
    };
    items.push(architect);

    const webUrl = this.buildDashboardUrl();
    if (webUrl) {
      const web = new vscode.TreeItem('Open Web Interface');
      web.iconPath = new vscode.ThemeIcon('globe');
      web.tooltip = webUrl;
      web.contextValue = 'workspace-web';
      web.command = {
        command: 'vscode.open',
        title: 'Open Tower dashboard in browser',
        arguments: [vscode.Uri.parse(webUrl)],
      };
      items.push(web);
    }

    return items;
  }

  private buildDashboardUrl(): string | null {
    const workspacePath = this.connectionManager.getWorkspacePath();
    if (!workspacePath) { return null; }
    const { host, port } = getTowerAddress();
    return `http://${host}:${port}/workspace/${encodeWorkspacePath(workspacePath)}/`;
  }
}
