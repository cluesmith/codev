import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import type { ActivityEvent, ActivityHook } from '@cluesmith/codev-types';

export type { ActivityEvent, ActivityHook };

/**
 * The active workspace's resolved activity hooks. Fed from Tower's
 * `GET /api/activity-hooks` via `setActivityHooks`, and refreshed on the
 * `codev-config-updated` SSE — so we never parse or merge config ourselves. SECURITY:
 * Tower resolves these from the PERSONAL config layers only (`~/.codev/config.json` +
 * `.codev/config.local.json`), never the committed `.codev/config.json`, because hooks
 * open URLs and a committed hook would be a zero-click RCE.
 */
let cachedHooks: ActivityHook[] = [];

/** Replace the cached hooks (called after fetching from Tower). */
export function setActivityHooks(hooks: ActivityHook[]): void {
  cachedHooks = hooks;
}

/**
 * Set once a hook delivery fails (no handler for the url, or no opener) so we stop
 * spawning a doomed process on every event. Reset on window reload (module re-init).
 */
let deliveryDisabled = false;

/** Last `(event, workspace, builder)` fired — to dedup rapid repeats (see fireActivity). */
let lastFiredKey = '';

/**
 * Publish an activity event to the configured URL hooks. No-op when no hook listens
 * for the event, so a workspace that configures nothing sees zero behavior. The
 * extension knows only the abstract event + its data; the destination url lives in
 * config (a deep link, a companion app, a webhook launcher).
 */
export function fireActivity(
  workspaceRoot: string | null,
  event: ActivityEvent,
  data: Record<string, string> = {},
): void {
  if (deliveryDisabled || !workspaceRoot) { return; }
  // SECURITY: hooks execute (we open their url), so never fire in a workspace the
  // user hasn't trusted (VSCode Restricted Mode). Defence-in-depth with resolving
  // hooks from personal config layers only (never the committed .codev/config.json).
  if (!vscode.workspace.isTrusted) { return; }
  // `builder-active` is emitted from three subscriptions (diff / terminal / sidebar);
  // rapid navigation within one builder would relaunch the same url repeatedly. Dedup
  // consecutive identical fires.
  const key = JSON.stringify({ event, workspaceRoot, builder: data.builder ?? '' });
  if (key === lastFiredKey) { return; }
  lastFiredKey = key;
  const values: Record<string, string> = { workspace: workspaceRoot, ...data };
  for (const { url, background } of resolveHookUrls(cachedHooks, event, values)) {
    openUrl(url, background);
  }
}

/**
 * Pure core: select hooks listening for `event` and interpolate their url
 * templates with `values` (each value URL-encoded; absent keys → empty).
 */
export function resolveHookUrls(
  hooks: ActivityHook[],
  event: ActivityEvent,
  values: Record<string, string>,
): Array<{ url: string; background: boolean }> {
  return hooks
    .filter((h) => !!h.url && Array.isArray(h.on) && h.on.includes(event))
    .map((h) => ({ url: interpolate(h.url, values), background: h.background ?? false }));
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(values[key] ?? ''));
}

/**
 * Deliver a url to its OS handler. Routes through `vscode.env.openExternal` so it
 * works under remote dev (the URL is forwarded to the LOCAL client, where the
 * handler app — a Stream Deck, a companion app — actually lives) and avoids OS
 * shell-quoting pitfalls (a Windows `cmd /c start "" url` would treat an `&` in the
 * url as a command separator and truncate/execute the remainder).
 *
 * The one exception is macOS + `background:true`: `open -g` is the only way to
 * deliver WITHOUT foregrounding the handler app, which `openExternal` can't express.
 * (That path is local-only; a background hook under remote dev is an accepted edge.)
 *
 * Fire-and-forget. On the first failure we stop and warn once, rather than retrying
 * a doomed url on every event.
 */
function openUrl(url: string, background: boolean): void {
  const onFail = (): void => {
    if (deliveryDisabled) { return; }
    deliveryDisabled = true;
    void vscode.window.showWarningMessage(
      'Codev: an activity hook could not be delivered (no handler for its url). Pausing activity hooks ' +
        'for this window; reload the window to retry, or fix the url in your codev config.',
    );
  };
  if (background && process.platform === 'darwin') {
    execFile('open', ['-g', url], (err) => { if (err) { onFail(); } }); // -g = don't foreground
    return;
  }
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(url, true);
  } catch {
    onFail();
    return;
  }
  void vscode.env.openExternal(uri).then((ok) => { if (!ok) { onFail(); } }, () => { onFail(); });
}
