import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';
import type { TerminalManager } from '../terminal-manager.js';
import { loadWorktreeConfig } from '../load-worktree-config.js';
import { formatUptime, extractDevPort, formatTargetName } from './dev-format.js';

/**
 * The "Codev Dev" panel tab (#921). A status surface for the single `afx dev`
 * PTY: which target is running, for how long, and on what port (best-effort).
 * Deliberately *not* an output mirror — the native `Codev: <name> (dev)`
 * terminal stays as the place to read stdout. The actionable controls
 * (Stop / Restart / Switch Target / Reveal) live in the view's title bar
 * (see package.json `view/title`), not as rows here.
 *
 * Single source of truth is `TerminalManager.listDevTerminals()` (single-slot:
 * at most one dev). We re-derive on every `onDidChangeDevTerminals` and keep a
 * 1s ticker running while a dev is up so the uptime row stays live.
 */
export class DevTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** The running dev, or null. `startedAt` is null when its start time is unknown
   *  (a dev that predates activation) so we render "Running" without a fake clock. */
  private running: { builderId: string; startedAt: number | null } | null = null;
  /** Last-stopped summary, shown until another dev starts or the user dismisses the tab. */
  private epitaph: { target: string; ranMs: number | null } | null = null;
  private port: number | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly terminalManager: TerminalManager,
  ) {
    this.subscription = terminalManager.onDidChangeDevTerminals(() => this.onDevTerminalsChanged());
    this.onDevTerminalsChanged(); // seed from any dev already running at activation
  }

  /** True iff a dev is currently running — drives the `codev.devRunning` context key. */
  isRunning(): boolean {
    return this.running !== null;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    if (this.running) {
      const rows = [
        this.row(`Target: ${formatTargetName(this.running.builderId)}`, 'server'),
        this.running.startedAt === null
          ? this.row('Running', 'watch')
          : this.row(`Running for ${formatUptime(Date.now() - this.running.startedAt)}`, 'watch'),
      ];
      if (this.port !== null) {
        rows.push(this.row(`Port: ${this.port}`, 'plug'));
      }
      return rows;
    }
    if (this.epitaph) {
      const ran = this.epitaph.ranMs === null ? '' : `, ran ${formatUptime(this.epitaph.ranMs)}`;
      return [this.row(`Stopped. Last target ${formatTargetName(this.epitaph.target)}${ran}`, 'circle-slash')];
    }
    return [this.row('No dev running. Start via `afx dev <target>` or the Workspace view.', 'info')];
  }

  private row(label: string, icon: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label);
    item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }

  private onDevTerminalsChanged(): void {
    const current = this.terminalManager.listDevTerminals()[0];
    if (current) {
      if (!this.running || this.running.builderId !== current.builderId) {
        const startedAt = this.terminalManager.getDevStartedAt(current.builderId) ?? null;
        this.running = { builderId: current.builderId, startedAt };
        this.epitaph = null;
        this.port = null;
        this.refreshPort(current.builderId);
        this.startTicker();
      }
    } else {
      if (this.running) {
        this.epitaph = {
          target: this.running.builderId,
          ranMs: this.running.startedAt === null ? null : Date.now() - this.running.startedAt,
        };
      }
      this.running = null;
      this.port = null;
      this.stopTicker();
    }
    this._onDidChangeTreeData.fire();
  }

  /** Best-effort port from the Tower-merged worktree config. Async; guarded so a
   *  late resolve for a since-swapped target is ignored. */
  private async refreshPort(builderId: string): Promise<void> {
    const config = await loadWorktreeConfig(this.connectionManager);
    if (this.running?.builderId !== builderId) { return; }
    this.port = extractDevPort(config);
    this._onDidChangeTreeData.fire();
  }

  private startTicker(): void {
    if (this.ticker) { return; }
    this.ticker = setInterval(() => this._onDidChangeTreeData.fire(), 1000);
  }

  private stopTicker(): void {
    if (!this.ticker) { return; }
    clearInterval(this.ticker);
    this.ticker = null;
  }

  dispose(): void {
    this.stopTicker();
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
