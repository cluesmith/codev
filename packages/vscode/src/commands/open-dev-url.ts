/**
 * Codev: Open Dev URL — open URLs configured under `worktree.devUrls`
 * in the user's default browser. Surfaced as one workspace-view row
 * per configured URL (label = row text), plus a palette command.
 * Both `label` and `url` are mandatory per schema; entries missing
 * either are silently filtered out (by the resolver server-side).
 *
 * The resolved devUrls list comes from Tower's GET /api/worktree-config,
 * which applies the full layered config merge (defaults / cache /
 * global / project / project-local). The extension never parses
 * `.codev/config.json` directly — Tower is the single source of truth
 * for "what's configured" so the merge semantics can't drift.
 *
 * Why the default browser over VSCode's Simple Browser: DevTools /
 * Console / Network are dev-loop essentials Simple Browser doesn't
 * have, and a real browser sidesteps the third-party-cookie issues
 * that come from loading the dev URL inside a `vscode-webview://`
 * iframe.
 */

import * as vscode from 'vscode';
import type { WorktreeDevUrl } from '@cluesmith/codev-types';
import type { ConnectionManager } from '../connection-manager.js';

export type { WorktreeDevUrl };

/**
 * Fetch the canonical resolved dev-URL list for the active workspace
 * from Tower. Returns `[]` when Tower is unreachable, the workspace
 * isn't activated, or the config has no `devUrls` — callers don't
 * have to branch.
 */
export async function loadWorktreeDevUrls(connectionManager: ConnectionManager): Promise<WorktreeDevUrl[]> {
  const client = connectionManager.getClient();
  const workspacePath = connectionManager.getWorkspacePath();
  if (!client || !workspacePath || connectionManager.getState() !== 'connected') { return []; }
  const config = await client.getWorktreeConfig(workspacePath);
  return config?.devUrls ?? [];
}

export async function openDevUrl(
  connectionManager: ConnectionManager,
  urlArg?: string,
): Promise<void> {
  // Direct invocation: a row click passes its URL; just open it.
  if (typeof urlArg === 'string' && urlArg.trim()) {
    await vscode.env.openExternal(vscode.Uri.parse(urlArg));
    return;
  }

  // Palette / arg-less invocation: resolve from config and route.
  const devUrls = await loadWorktreeDevUrls(connectionManager);

  if (devUrls.length === 0) {
    vscode.window.showWarningMessage(
      'Codev: `worktree.devUrls` not configured in `.codev/config.json`',
    );
    return;
  }
  if (devUrls.length === 1) {
    await vscode.env.openExternal(vscode.Uri.parse(devUrls[0]!.url));
    return;
  }

  const picked = await vscode.window.showQuickPick(
    devUrls.map(d => ({ label: d.label, description: d.url, url: d.url })),
    { placeHolder: 'Open which dev URL?' },
  );
  if (picked) {
    await vscode.env.openExternal(vscode.Uri.parse(picked.url));
  }
}
