/**
 * Per-workspace file watcher for `.codev/config.json` and
 * `.codev/config.local.json`. Lazily installed by any config-resolving route
 * handler (`/api/worktree-config`, `/api/activity-hooks`) on first request, then
 * persists for the Tower process lifetime. On each detected change it fans out a
 * `codev-config-updated` SSE event so subscribed clients (the VSCode extension, the
 * dashboard) refetch whichever resolved config they consume and re-render.
 *
 * Watches the codev config FILES, not any one config section — so a single watcher
 * + event serves every consumer of `.codev/config(.local).json`.
 *
 * Pattern follows `tower-tunnel.ts:startConfigWatcher` (which watches
 * `~/.codev/cloud.json` for OAuth credential changes) — `node:fs.watch`
 * on the parent directory, filename filter, short debounce to coalesce
 * the multiple events that fire per save.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

type NotifyFn = (notification: {
  type: string;
  title: string;
  body: string;
  workspace?: string;
}) => void;

const TARGET_FILES = new Set(['config.json', 'config.local.json']);
const DEBOUNCE_MS = 50;

const watchers = new Map<string, fs.FSWatcher>();
const debounces = new Map<string, NodeJS.Timeout>();
let notify: NotifyFn | undefined;

/**
 * Wire the broadcast function once at Tower startup. Subsequent calls
 * to `ensureCodevConfigWatcher` will use this notifier when files change.
 */
export function setCodevConfigNotifier(fn: NotifyFn): void {
  notify = fn;
}

/**
 * Lazily install (or no-op if already installed) a file watcher for
 * `<workspacePath>/.codev/{config.json,config.local.json}`. Safe to
 * call on every route hit.
 */
export function ensureCodevConfigWatcher(workspacePath: string): void {
  if (watchers.has(workspacePath)) { return; }
  const dir = path.join(workspacePath, '.codev');
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (!filename || !TARGET_FILES.has(filename)) { return; }
      const prev = debounces.get(workspacePath);
      if (prev) { clearTimeout(prev); }
      debounces.set(
        workspacePath,
        setTimeout(() => {
          debounces.delete(workspacePath);
          notify?.({
            type: 'codev-config-updated',
            title: 'Codev config changed',
            body: JSON.stringify({ workspace: workspacePath }),
            workspace: workspacePath,
          });
        }, DEBOUNCE_MS),
      );
    });
    watcher.on('error', () => { /* benign — dir may be removed mid-watch */ });
    watchers.set(workspacePath, watcher);
  } catch {
    // `.codev/` may not exist yet; the next ensure call will retry.
  }
}

/** Test / shutdown helper — close every watcher and clear pending debounces. */
export function stopAllCodevConfigWatchers(): void {
  for (const t of debounces.values()) { clearTimeout(t); }
  debounces.clear();
  for (const w of watchers.values()) { try { w.close(); } catch { /* benign */ } }
  watchers.clear();
}
