/**
 * ReviewQueueStore — the single owner of `.codev/pending-comments.json` reads
 * and writes for every builder (#1037). All surfaces (inline threads, status
 * bar, submit command) go through this store; none touch the files directly.
 *
 * Sync model (plan decision 7, hybrid):
 * - Every mutation this store performs fires `onDidChangeQueue(builderId)`
 *   immediately, so same-window surfaces update with no watcher latency.
 * - A `FileSystemWatcher` on each `.builders/<id>/.codev/pending-comments.json`
 *   (relative to the workspace root) catches other VSCode windows' writes and
 *   external deletes (`afx cleanup` removing the worktree), debounced 200ms
 *   per file. Own writes are echo-suppressed by comparing the file content
 *   against the last bytes this store wrote.
 *
 * Worktree paths are registered by callers from authoritative sources (the
 * diff-inject registry entry or the Tower overview), never synthesized from
 * the workspace root — a builder's worktree can live anywhere.
 *
 * On the first write of a queue file the store also appends a managed ignore
 * block to `$GIT_COMMON_DIR/info/exclude` (plan decision 8) so the file — and
 * the `.builder-*` spawn scaffolding family — never shows as untracked noise
 * in any worktree's `git status`.
 */

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  addComment,
  editComment,
  parseQueueFile,
  QUEUE_FILE_RELPATH,
  removeComments,
  serializeQueueFile,
  mergeExcludeBlock,
  type PendingComment,
} from './queue.js';

const execFileAsync = promisify(execFile);

const WATCHER_DEBOUNCE_MS = 200;

export class ReviewQueueStore implements vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<string>();
  /** Fires with the builderId whose queue changed (own mutation or external). */
  readonly onDidChangeQueue = this.changeEmitter.event;

  private readonly worktreeById = new Map<string, string>();
  /** In-memory queue cache, keyed by builderId; refreshed on external events. */
  private readonly cache = new Map<string, PendingComment[]>();
  /** Last serialized bytes written per queue path — the watcher echo filter. */
  private readonly lastWritten = new Map<string, string>();
  /** Worktrees whose info/exclude has been ensured this session. */
  private readonly excludeEnsured = new Set<string>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly workspaceRoot: string | undefined) {
    if (workspaceRoot) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(workspaceRoot, `.builders/*/${QUEUE_FILE_RELPATH}`),
      );
      const onEvent = (uri: vscode.Uri): void => { this.scheduleExternalRead(uri.fsPath); };
      this.disposables.push(
        watcher,
        watcher.onDidCreate(onEvent),
        watcher.onDidChange(onEvent),
        watcher.onDidDelete(onEvent),
      );
    }
  }

  /**
   * One-time scan of `.builders/<id>/.codev/pending-comments.json` under the
   * workspace root: register each worktree (dir basename = builder id, the
   * same fallback the watcher path uses) and load its queue into the cache.
   * Called fire-and-forget at activation so the palette Submit Review and the
   * status-bar counter see persisted queues after a window reload, before any
   * diff has been opened. Best-effort: a missing `.builders/` dir or an
   * unreadable file reads as empty, never throws.
   */
  async preloadFromDisk(): Promise<void> {
    if (!this.workspaceRoot) { return; }
    let names: string[] = [];
    try {
      names = await fs.readdir(path.join(this.workspaceRoot, '.builders'));
    } catch {
      return; // No worktrees — nothing to preload.
    }
    await Promise.all(names.map(async name => {
      const queueFile = path.join(this.workspaceRoot!, '.builders', name, QUEUE_FILE_RELPATH);
      try {
        await fs.access(queueFile);
      } catch {
        return; // This builder never queued anything.
      }
      await this.load(this.builderIdForQueuePath(queueFile));
    }));
  }

  /** Remember a builder's worktree root (idempotent; callers pass authoritative paths). */
  registerWorktree(builderId: string, worktreePath: string): void {
    this.worktreeById.set(builderId, worktreePath);
  }

  getWorktreePath(builderId: string): string | undefined {
    return this.worktreeById.get(builderId);
  }

  /** All builder ids with at least one pending comment loaded this session. */
  buildersWithPending(): string[] {
    const ids: string[] = [];
    for (const [id, comments] of this.cache) {
      if (comments.length > 0) { ids.push(id); }
    }
    return ids;
  }

  /** Cached queue for a builder (empty until `load` has run for it). */
  getComments(builderId: string): PendingComment[] {
    return this.cache.get(builderId) ?? [];
  }

  count(builderId: string): number {
    return this.getComments(builderId).length;
  }

  /**
   * Read the queue file from disk into the cache. Missing file (never
   * created, or the worktree was cleaned up) reads as empty. Fires the change
   * event only when the loaded content differs from the cache.
   */
  async load(builderId: string): Promise<PendingComment[]> {
    const filePath = this.queuePath(builderId);
    if (!filePath) { return []; }
    let comments: PendingComment[] = [];
    try {
      comments = parseQueueFile(await fs.readFile(filePath, 'utf8'));
    } catch {
      // Missing file or unreadable — an empty queue, not an error.
    }
    const before = JSON.stringify(this.cache.get(builderId) ?? []);
    this.cache.set(builderId, comments);
    if (JSON.stringify(comments) !== before) {
      this.changeEmitter.fire(builderId);
    }
    return comments;
  }

  async add(builderId: string, comment: PendingComment): Promise<void> {
    await this.mutate(builderId, comments => addComment(comments, comment));
  }

  async edit(builderId: string, id: string, body: string): Promise<void> {
    await this.mutate(builderId, comments => editComment(comments, id, body));
  }

  async remove(builderId: string, ids: readonly string[]): Promise<void> {
    await this.mutate(builderId, comments => removeComments(comments, ids));
  }

  async clear(builderId: string): Promise<void> {
    await this.mutate(builderId, () => []);
  }

  private queuePath(builderId: string): string | undefined {
    const worktree = this.worktreeById.get(builderId);
    if (!worktree) { return undefined; }
    return path.join(worktree, QUEUE_FILE_RELPATH);
  }

  /**
   * Load-mutate-write. Loads from disk first so concurrent writers (another
   * window) are folded in rather than clobbered, then persists and fires.
   */
  private async mutate(
    builderId: string,
    fn: (comments: PendingComment[]) => PendingComment[],
  ): Promise<void> {
    const filePath = this.queuePath(builderId);
    if (!filePath) {
      throw new Error(`No worktree registered for builder "${builderId}"`);
    }
    const current = await this.load(builderId);
    const next = fn(current);
    const serialized = serializeQueueFile(builderId, next);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, serialized, 'utf8');
    this.lastWritten.set(filePath, serialized);
    this.cache.set(builderId, next);
    await this.ensureExclude(this.worktreeById.get(builderId)!);
    this.changeEmitter.fire(builderId);
  }

  /**
   * Append the managed ignore block to the repo's shared
   * `$GIT_COMMON_DIR/info/exclude` (once per session per worktree; the merge
   * itself is idempotent across sessions). Failures are swallowed: an
   * unignored queue file is cosmetic noise, never worth failing a comment
   * write over.
   */
  private async ensureExclude(worktreePath: string): Promise<void> {
    if (this.excludeEnsured.has(worktreePath)) { return; }
    this.excludeEnsured.add(worktreePath);
    try {
      const { stdout } = await execFileAsync('git', [
        '-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir',
      ]);
      const commonDir = stdout.trim();
      if (!commonDir) { return; }
      const excludePath = path.join(commonDir, 'info', 'exclude');
      let existing = '';
      try {
        existing = await fs.readFile(excludePath, 'utf8');
      } catch {
        // No info/exclude yet — start from empty.
      }
      const merged = mergeExcludeBlock(existing);
      if (merged === null) { return; }
      await fs.mkdir(path.dirname(excludePath), { recursive: true });
      await fs.writeFile(excludePath, merged, 'utf8');
    } catch {
      // Not a git repo / git unavailable — skip silently.
    }
  }

  /** Debounced handler for watcher events on a queue file path. */
  private scheduleExternalRead(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) { clearTimeout(existing); }
    this.debounceTimers.set(filePath, setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.handleExternalEvent(filePath);
    }, WATCHER_DEBOUNCE_MS));
  }

  private async handleExternalEvent(filePath: string): Promise<void> {
    const builderId = this.builderIdForQueuePath(filePath);
    let content: string | null = null;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      // Deleted (afx cleanup) — treat as empty below.
    }
    if (content !== null && content === this.lastWritten.get(filePath)) {
      return; // Echo of our own write.
    }
    let comments: PendingComment[] = [];
    if (content !== null) { comments = parseQueueFile(content); }
    const before = JSON.stringify(this.cache.get(builderId) ?? []);
    this.cache.set(builderId, comments);
    if (JSON.stringify(comments) !== before) {
      this.changeEmitter.fire(builderId);
    }
  }

  /**
   * Map a watched queue-file path back to a builder id: a registered worktree
   * match wins; otherwise fall back to the worktree directory basename (the
   * `.builders/<id>/` convention), registering it so subsequent reads work.
   */
  private builderIdForQueuePath(filePath: string): string {
    const worktree = path.dirname(path.dirname(filePath));
    for (const [id, wt] of this.worktreeById) {
      if (wt === worktree) { return id; }
    }
    const id = path.basename(worktree);
    this.worktreeById.set(id, worktree);
    return id;
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) { clearTimeout(timer); }
    this.debounceTimers.clear();
    for (const d of this.disposables) { d.dispose(); }
    this.changeEmitter.dispose();
  }
}
