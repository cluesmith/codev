import * as vscode from 'vscode';
import type { OverviewData } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';

/**
 * Shared cache for /api/overview data.
 * Refreshed on SSE events, consumed by all Work View TreeDataProviders.
 */
export class OverviewCache {
  private data: OverviewData | null = null;
  private latestSeq = 0;

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

  /**
   * Fetch the latest overview from Tower and notify subscribers.
   *
   * Last-write-wins via a sequence counter rather than a load gate: every
   * call increments `latestSeq` and only commits its result if the seq is
   * still current. This guarantees the cache reflects the most-recently
   * requested state even when SSE bursts (e.g. `porch done --pr` →
   * `porch done --merged` → `afx cleanup`) trigger several refreshes back-
   * to-back. A naive `if (loading) return` gate drops requests #2 and #3
   * and freezes the cache on the mid-transition state from request #1
   * until something else triggers an SSE event — the bug this fixes.
   * Cost: N rapid events → N parallel `/api/overview` requests; on
   * localhost-Tower that's negligible.
   */
  async refresh(): Promise<void> {
    const mySeq = ++this.latestSeq;
    const client = this.connectionManager.getClient();
    if (!client || this.connectionManager.getState() !== 'connected') {
      if (mySeq !== this.latestSeq) { return; }
      this.data = null;
      this.changeEmitter.fire();
      return;
    }

    const workspacePath = this.connectionManager.getWorkspacePath();
    const result = await client.getOverview(workspacePath ?? undefined) ?? null;
    if (mySeq !== this.latestSeq) { return; }
    this.data = result;
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
