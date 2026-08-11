import * as vscode from 'vscode';
import type { ConnectionManager } from '../connection-manager.js';
import type { OverviewCache } from '../views/overview-data.js';
import {
  orderForSearch,
  toQuickPickItems,
  toDynamicQuickPickItems,
  type BacklogQuickPickItem,
  type DynamicQuickPickItem,
} from '../views/backlog-search.js';
import { openIssueInBrowser } from './open-issue-by-id.js';
import { openPRInBrowser } from './open-pr-by-id.js';

/**
 * `codev.searchBacklog` — open a Quick Pick over the current backlog and, on
 * selection, open the chosen issue via the same `codev.viewBacklogIssue` flow
 * a single sidebar-row click uses (issue #918).
 *
 * Type-ahead (issue #1179): when the typed value matches the numeric grammar
 * (`1350`, `#1350`, `issue 1350`, `view pr 1350`, ...), dynamic
 * `View Issue #N` / `View PR #N` rows are prepended. Accepting one skips the
 * pick-then-InputBox two-step and opens the target directly in the browser
 * via the same fetch path as `codev.openIssueById` / `codev.openPRById` —
 * reaching issues outside the loaded backlog (closed, claimed) and PRs, which
 * the static rows never contain. Any other input filters the static rows
 * exactly as before.
 *
 * Snapshots `overviewCache` at invoke time (a one-shot picker; live-updating
 * rows while the user types would be jittery and unlike `Cmd+P`). Search runs
 * over the full spawnable backlog — NOT the mine-only set — so a user can find
 * an issue they didn't author.
 */
export async function searchBacklog(
  connectionManager: ConnectionManager,
  overviewCache: OverviewCache,
): Promise<void> {
  const data = overviewCache.getData();
  let staticItems: BacklogQuickPickItem[];
  if (data) {
    staticItems = toQuickPickItems(orderForSearch(data), Date.now());
  } else {
    staticItems = [];
  }
  if (staticItems.length === 0) {
    vscode.window.showInformationMessage(
      'Codev: No backlog issues to search (not connected, or the backlog is empty).',
    );
    return;
  }

  const picker = vscode.window.createQuickPick<BacklogQuickPickItem | DynamicQuickPickItem>();
  picker.items = staticItems;
  picker.placeholder = 'Search backlog by id, title, area, assignee...';
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;

  picker.onDidChangeValue((value) => {
    const dynamicItems = toDynamicQuickPickItems(value);
    if (dynamicItems.length === 0) {
      picker.items = staticItems;
    } else {
      picker.items = [...dynamicItems, ...staticItems];
    }
  });

  picker.onDidAccept(() => {
    const picked = picker.selectedItems[0];
    picker.hide();
    if (!picked) { return; }
    if ('kind' in picked) {
      if (picked.kind === 'issue') {
        openIssueInBrowser(connectionManager, picked.id);
      } else {
        openPRInBrowser(connectionManager, picked.id);
      }
      return;
    }
    vscode.commands.executeCommand('codev.viewBacklogIssue', picked.issueId);
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
}
