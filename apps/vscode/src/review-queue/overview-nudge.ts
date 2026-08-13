/**
 * Keep the Stream Deck's Send Fb badge and dial mode-label fresh (#1410).
 *
 * Tower projects two out-of-band values into the overview: the per-builder
 * `queuedFeedback` count (read from each builder's `pending-comments.json`) and
 * `feedbackMode` (read from `<root>/.vscode/settings.json`). Tower has **no
 * watcher** on either file — it rebuilds them on demand when the overview is
 * fetched. So a queue mutation or a `codev.diffCodelensMode` toggle is invisible
 * to the deck until some *unrelated* SSE event happens to fire, and the deck's
 * refresh-on-command can even race ahead of the queue write (reading the stale,
 * pre-write count).
 *
 * This nudges Tower on exactly those two mutations. `refreshOverview()` invalidates
 * Tower's overview cache and broadcasts `overview-changed`, which fires AFTER the
 * write — so every client (deck + dashboard) re-fetches the fresh values
 * deterministically, no race. Best-effort: a no-op when Tower isn't connected.
 */

import * as vscode from 'vscode';
import type { ReviewQueueStore } from './store.js';
import type { ConnectionManager } from '../connection-manager.js';

export function activateOverviewNudge(
  store: ReviewQueueStore,
  connectionManager: ConnectionManager,
): vscode.Disposable {
  const nudge = (): void => { void connectionManager.getClient()?.refreshOverview(); };
  return vscode.Disposable.from(
    // Every queue mutation (deck-driven enqueue, Send Fb flush, discard, or an
    // external window's write) flows through this one event.
    store.onDidChangeQueue(() => nudge()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('codev.diffCodelensMode')) { nudge(); }
    }),
  );
}
