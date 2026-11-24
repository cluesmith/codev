import type * as vscode from 'vscode';

/** A view whose visibility keeps the periodic overview refresh running. */
export interface GatedView {
  readonly visible: boolean;
  readonly onDidChangeVisibility: vscode.Event<unknown>;
}

/**
 * Periodic overview refresh (`codev.overviewRefreshSeconds`). VS Code has no timer-based refresh
 * (event-only), so an idle workspace would never see externally-merged PRs or new issues. Mirror
 * the dashboard's poll idiom: refresh on a cadence while any overview-backed view is visible,
 * paused when none is. The shared Tower-side 30 s cache throttles gh cost across windows, and
 * `OverviewCache.refresh()` is last-write-wins, so periodic and event-driven refreshes coexist.
 *
 * Every view that renders this window's overview is one of `views` — the Codev container's list
 * views and, since Spec 1963, the Cockpit — so with only the Cockpit visible the timer still runs.
 */
export class OverviewRefreshGate implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param views the views whose visibility keeps the timer running.
   * @param intervalSeconds the configured cadence; `0` turns the refresh off.
   * @param onTick runs on each interval.
   * @param onResume runs once when the timer starts (an immediate refresh on becoming visible).
   */
  constructor(
    private readonly views: readonly GatedView[],
    private readonly intervalSeconds: () => number,
    private readonly onTick: () => void,
    private readonly onResume: () => void,
  ) {}

  /** Re-check on every view's visibility change. */
  wire(): vscode.Disposable[] {
    return this.views.map(view => view.onDidChangeVisibility(() => this.reconcile()));
  }

  /** True while the periodic refresh is running. */
  isRunning(): boolean {
    return this.timer !== undefined;
  }

  /** Start the timer if a view is visible and the cadence is on; stop it otherwise. */
  reconcile(): void {
    const seconds = this.intervalSeconds();
    if (seconds === 0 || !this.views.some(view => view.visible)) {
      this.stop();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setInterval(() => this.onTick(), seconds * 1000);
      this.onResume();
    }
  }

  /** The cadence setting changed: start over at the new interval. */
  restart(): void {
    this.stop();
    this.reconcile();
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
