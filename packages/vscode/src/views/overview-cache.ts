import * as vscode from 'vscode';
import type { OverviewData } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';

/**
 * Shared cache for /api/overview data.
 * Refreshed on SSE events, consumed by all Work View TreeDataProviders.
 */
export class OverviewCache {
  private data: OverviewData | null = null;
  private loading = false;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private connectionManager: ConnectionManager) {
    // Refresh on SSE events
    connectionManager.onSSEEvent(() => {
      this.refresh();
    });
  }

  getData(): OverviewData | null {
    return this.data;
  }

  async refresh(): Promise<void> {
    if (this.loading) { return; }
    this.loading = true;

    try {
      const client = this.connectionManager.getClient();
      if (!client || this.connectionManager.getState() !== 'connected') {
        this.data = null;
        this.changeEmitter.fire();
        return;
      }

      const result = await client.request<OverviewData>('/api/overview');
      if (result.ok && result.data) {
        this.data = result.data;
      } else {
        this.data = null;
      }
    } finally {
      this.loading = false;
      this.changeEmitter.fire();
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
