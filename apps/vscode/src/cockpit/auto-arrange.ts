/**
 * The first-show trigger for *Arrange Cockpit* (Spec 1963, approach C1).
 *
 * - **Once per window session.** The first time the Cockpit view is visible, the window is
 *   arranged. The check runs when this is created and on every visibility change: a window
 *   restored with the container already visible gets no visibility event. Later shows (Cmd+B,
 *   switching back from the Explorer) leave the editor area alone. A reload starts a new session.
 * - **After the first connection attempt.** On a reload with the Cockpit visible the view exists
 *   before Tower is connected, and the architect cannot be resolved yet. So an arrange waits until
 *   `ready()`, which the extension calls once its first connection attempt has finished.
 * - **Not with `codev.cockpit.autoArrange` off**, nor in a builder-worktree window or a window with
 *   no Codev workspace. The first show is spent either way: turning the setting on later arranges
 *   from the next window session, and *Arrange Cockpit* arranges at any time.
 * - **The one-time notice.** VS Code has no "undo layout". So the first auto-arrange for a user
 *   profile is followed by a notice offering *Don't arrange automatically*, which turns the setting
 *   off at the user (global) level. Its global-state flag is set when it is shown, whatever the user
 *   does with it, so it never appears again in any window. A manual *Arrange Cockpit* never shows it.
 */

import * as vscode from 'vscode';

/** The global-state flag: the notice has been shown for this user profile. */
export const AUTO_ARRANGE_NOTICE_KEY = 'codev.cockpit.autoArrangeNoticeShown';
export const DONT_ARRANGE_AUTOMATICALLY = "Don't arrange automatically";
export const AUTO_ARRANGE_NOTICE =
  'Codev: The editor area was arranged for the Cockpit: the main architect on the left, Work and Decisions on the right. '
  + 'This happens the first time the Cockpit is shown in a window. Codev: Arrange Cockpit arranges it again at any time.';

export interface CockpitAutoArrangeOptions {
  /** The Cockpit's tree view. */
  view: { readonly visible: boolean; readonly onDidChangeVisibility: vscode.Event<unknown> };
  /** Whether arranging is offered in this window: not in a builder-worktree or no-workspace window. */
  offered(): boolean;
  /** `codev.cockpit.autoArrange`. */
  enabled(): boolean;
  /** Arrange the editor area (`CockpitArranger`); resolves whether it was arranged. */
  arrange(): Promise<boolean>;
  /** The extension's global state, where the notice's flag lives. */
  globalState: Pick<vscode.Memento, 'get' | 'update'>;
  /** Turn `codev.cockpit.autoArrange` off at the user (global) level. */
  disable(): Thenable<void>;
  log(line: string): void;
}

export class CockpitAutoArrange implements vscode.Disposable {
  private firstShowSeen = false;
  private isReady = false;
  private pending = false;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly options: CockpitAutoArrangeOptions) {
    this.subscription = options.view.onDidChangeVisibility(() => this.check());
    this.check();
  }

  /** The window's first connection attempt has finished: a first show seen before now arranges. */
  ready(): void {
    if (this.isReady) { return; }
    this.isReady = true;
    if (this.pending) {
      this.pending = false;
      void this.run();
    }
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private check(): void {
    if (this.firstShowSeen || !this.options.view.visible) { return; }
    this.firstShowSeen = true;
    if (this.isReady) {
      void this.run();
    } else {
      this.pending = true;
    }
  }

  private async run(): Promise<void> {
    const { offered, enabled, arrange, log } = this.options;
    if (!offered() || !enabled()) { return; }
    try {
      if (await arrange()) { await this.noticeOnce(); }
    } catch (err) {
      log(`Cockpit auto-arrange failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async noticeOnce(): Promise<void> {
    const { globalState, disable } = this.options;
    if (globalState.get<boolean>(AUTO_ARRANGE_NOTICE_KEY)) { return; }
    await globalState.update(AUTO_ARRANGE_NOTICE_KEY, true);
    const choice = await vscode.window.showInformationMessage(AUTO_ARRANGE_NOTICE, DONT_ARRANGE_AUTOMATICALLY);
    if (choice === DONT_ARRANGE_AUTOMATICALLY) { await disable(); }
  }
}
