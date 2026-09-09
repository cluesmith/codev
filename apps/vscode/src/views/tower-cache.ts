import * as vscode from 'vscode';
import { deriveAttention } from '@cluesmith/codev-sdk/builder-helpers';
import type { AttentionSummary } from '@cluesmith/codev-sdk/builder-helpers';
import type { TowerWorkspace } from '@cluesmith/codev-sdk/tower-client';
import type { ConnectionManager } from '../connection-manager.js';

/** A workspace paired with its derived attention roll-up (the Tower view's per-row datum). */
export interface FleetEntry {
  workspace: TowerWorkspace;
  attention: AttentionSummary;
}

/** How often the fallback poll re-fetches the fleet when SSE isn't delivering (ms). */
const POLL_INTERVAL_MS = 20_000;

/**
 * Cross-workspace attention cache for the Tower view.
 *
 * Tower is machine-global (one daemon serving every workspace), so this window's shared
 * `TowerClient` can read *every* workspace: `listWorkspaces()` for the set, then a per-workspace
 * `getOverview(path)` fan-out for the active ones, each projected through the SDK's `deriveAttention`
 * (never re-derived here). The single-workspace `OverviewCache` can't serve this — hence a second
 * cache — but there is still exactly **one** SSE stream: this cache subscribes to
 * `connectionManager.onSSEEvent`, the stream ConnectionManager already owns, and never opens its own
 * `EventSource` (the #1211 connection-pool lesson).
 *
 * Refresh triggers: every non-heartbeat SSE event; a manual `refresh()` the activate/deactivate
 * actions call (workspace activation emits no SSE, so the list must be re-polled); and a
 * low-frequency fallback poll for when SSE isn't delivering. `getOverview` failures never clobber a
 * workspace's last-known attention, and out-of-order fan-out landings are dropped by a sequence
 * guard (the #916 last-write-wins pattern, at per-workspace granularity).
 */
export class TowerFleetCache {
  private entries: FleetEntry[] = [];
  private lastAttention = new Map<string, AttentionSummary>();
  private latestSeq = 0;
  private loaded = false;

  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private readonly subscriptions: vscode.Disposable[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private connectionManager: ConnectionManager) {
    this.subscriptions.push(
      connectionManager.onSSEEvent(() => { void this.refresh(); }),
      connectionManager.onStateChange((state) => { if (state === 'connected') { void this.refresh(); } }),
    );
    // Always-on low-frequency poll: the safety net for SSE gaps and for list changes Tower never
    // pushes (activation/deactivation emit no event). `refresh()` self-guards, so a disconnected
    // tick is a cheap no-op.
    this.pollTimer = setInterval(() => { void this.refresh(); }, POLL_INTERVAL_MS);
  }

  /** Current fleet, in Tower's list order. The Tower view applies label + urgency ordering. */
  getFleet(): FleetEntry[] {
    return this.entries;
  }

  /** True once the first successful fetch has populated the cache (drives the loading vs empty state). */
  isLoaded(): boolean {
    return this.loaded;
  }

  /** Number of workspaces that currently need a human — the machine-wide badge count. */
  getAttentionCount(): number {
    let count = 0;
    for (const entry of this.entries) {
      if (!entry.attention.isEmpty) { count++; }
    }
    return count;
  }

  /**
   * Re-fetch the workspace list and fan out per-workspace overviews. Last-write-wins via `latestSeq`:
   * a call whose sequence is superseded before it commits is discarded, so SSE bursts and out-of-order
   * landings never install stale data. A not-`connected` state or absent client returns without
   * touching the cache (keep last-known-good). A dormant workspace contributes an empty summary
   * without a fetch; an active workspace whose overview fetch fails keeps its previous attention.
   */
  async refresh(): Promise<void> {
    const mySeq = ++this.latestSeq;
    const client = this.connectionManager.getClient();
    if (!client || this.connectionManager.getState() !== 'connected') {
      return;
    }

    const workspaces = await client.listWorkspaces();
    if (mySeq !== this.latestSeq) { return; }

    const entries = await Promise.all(workspaces.map(async (workspace): Promise<FleetEntry> => {
      if (!workspace.active) {
        return { workspace, attention: deriveAttention(null) };
      }
      const overview = await client.getOverview(workspace.path);
      if (overview === null) {
        // Transient fetch failure — retain this workspace's last-known attention rather than
        // flipping it to quiet on a blip.
        const previous = this.lastAttention.get(workspace.path);
        return { workspace, attention: previous ?? deriveAttention(null) };
      }
      return { workspace, attention: deriveAttention(overview) };
    }));
    if (mySeq !== this.latestSeq) { return; }

    this.entries = entries;
    this.lastAttention = new Map(entries.map((e) => [e.workspace.path, e.attention]));
    this.loaded = true;
    this.changeEmitter.fire();
  }

  dispose(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const sub of this.subscriptions) { sub.dispose(); }
    this.changeEmitter.dispose();
  }
}
