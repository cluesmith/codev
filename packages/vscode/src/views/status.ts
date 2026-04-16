import * as vscode from 'vscode';
import type { TunnelStatus } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';

export class StatusProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private connectionManager: ConnectionManager) {
    connectionManager.onStateChange(() => this.changeEmitter.fire());
    connectionManager.onSSEEvent(() => this.changeEmitter.fire());
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const items: vscode.TreeItem[] = [];
    const client = this.connectionManager.getClient();
    const state = this.connectionManager.getState();

    // Tower status
    const towerItem = new vscode.TreeItem(`Tower: ${state}`);
    towerItem.iconPath = state === 'connected'
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('testing.iconFailed'));
    items.push(towerItem);

    if (client && state === 'connected') {
      // Tunnel status
      try {
        const tunnel = await client.getTunnelStatus();
        if (tunnel) {
          const label = tunnel.state === 'connected'
            ? `Tunnel: ${tunnel.towerName ?? 'connected'}`
            : `Tunnel: ${tunnel.state}`;
          const tunnelItem = new vscode.TreeItem(label);
          tunnelItem.iconPath = tunnel.state === 'connected'
            ? new vscode.ThemeIcon('cloud', new vscode.ThemeColor('testing.iconPassed'))
            : new vscode.ThemeIcon('cloud-download');
          items.push(tunnelItem);
        }
      } catch { /* ignore */ }

      // Cron tasks
      try {
        const result = await client.request<{ tasks: Array<{ name: string; enabled: boolean }> }>('/api/cron/tasks');
        if (result.ok && result.data?.tasks) {
          const running = result.data.tasks.filter(t => t.enabled).length;
          const cronItem = new vscode.TreeItem(`Cron: ${result.data.tasks.length} tasks (${running} enabled)`);
          cronItem.iconPath = new vscode.ThemeIcon('clock');
          items.push(cronItem);
        }
      } catch { /* ignore */ }
    }

    return items;
  }
}
