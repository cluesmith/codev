import * as vscode from 'vscode';
import {
  getBuilderChanges,
  planResources,
  type ChangeEntry,
  type ChangeStatus,
  type ResourcePlan,
} from '../commands/view-diff.js';
import { builderFileResourceUri } from './builder-file-tree-item.js';

/**
 * A changed file paired with its diff plan. `planResources` maps
 * `changes` 1:1 in order, so zipping by index is safe.
 */
export interface BuilderFileChange {
  change: ChangeEntry;
  plan: ResourcePlan;
}

export interface BuilderDiffResult {
  /** Merge-base SHA (or branch name) — passed to `diffUrisForChange`. */
  baseRef: string;
  /** Empty when there are no changes. */
  files: BuilderFileChange[];
  /** Present when `git` failed; the tree shows a placeholder row. */
  error?: string;
}

/**
 * TTL cache around `getBuilderChanges` keyed by builder id, plus a global
 * `uri → git status` registry that backs the SCM-style file decorations
 * (colored status letter on each changed-file row).
 *
 * Why the TTL: VSCode re-queries an *expanded* tree node's children on
 * every `onDidChangeTreeData` — which `BuildersProvider` fires on each SSE
 * event and the 60s overview poll. Without a cache, every tick would spawn
 * `git` for every expanded builder. The TTL caps that to ~1 spawn /
 * interval / expanded builder; collapsed builders never call `getChildren`.
 */
export class BuilderDiffCache {
  private readonly cache = new Map<string, { ts: number; result: BuilderDiffResult }>();

  /** uri.toString() → status for every file currently shown across builders. */
  private readonly decorations = new Map<string, ChangeStatus>();
  /** builderId → the URIs it contributed, so a recompute can replace them. */
  private readonly builderUris = new Map<string, vscode.Uri[]>();

  private readonly _onDidChangeDecorations = new vscode.EventEmitter<vscode.Uri[]>();
  /** Fires the affected file URIs whenever the decoration map changes. */
  readonly onDidChangeDecorations = this._onDidChangeDecorations.event;

  constructor(private readonly ttlMs = 15_000) {}

  /** Status for a file URI, or undefined if it isn't a tracked change. */
  decorationFor(uri: vscode.Uri): ChangeStatus | undefined {
    return this.decorations.get(uri.toString());
  }

  async getDiff(builderId: string, worktreePath: string): Promise<BuilderDiffResult> {
    const hit = this.cache.get(builderId);
    if (hit && Date.now() - hit.ts < this.ttlMs) {
      return hit.result;
    }

    let result: BuilderDiffResult;
    try {
      const { baseRef, changes, binaryPaths } = await getBuilderChanges(worktreePath);
      const plans = planResources(changes, binaryPaths);
      result = {
        baseRef,
        files: changes.map((change, i) => ({ change, plan: plans[i]! })),
      };
    } catch (error) {
      result = {
        baseRef: '',
        files: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.cache.set(builderId, { ts: Date.now(), result });
    this.syncDecorations(builderId, worktreePath, result);
    return result;
  }

  /** Drop a builder's cached diff + decorations (e.g. after cleanup). */
  invalidate(builderId: string): void {
    this.cache.delete(builderId);
    this.syncDecorations(builderId, '', { baseRef: '', files: [] });
  }

  /**
   * Replace this builder's contribution to the decoration map and notify
   * listeners of every affected URI (old ∪ new) so VSCode re-queries them.
   *
   * URIs are constructed via the same helper `BuilderFileTreeItem` uses,
   * so the scheme/path match exactly — VSCode keys decoration cache
   * entries by the full URI, not by fsPath, so a scheme mismatch would
   * leave stale decorations on screen after a file list change.
   */
  private syncDecorations(builderId: string, worktreePath: string, result: BuilderDiffResult): void {
    const oldUris = this.builderUris.get(builderId) ?? [];
    for (const u of oldUris) { this.decorations.delete(u.toString()); }

    const newUris: vscode.Uri[] = [];
    for (const f of result.files) {
      const uri = builderFileResourceUri(worktreePath, f.change.path);
      this.decorations.set(uri.toString(), f.change.status);
      newUris.push(uri);
    }
    this.builderUris.set(builderId, newUris);

    const seen = new Set<string>();
    const affected: vscode.Uri[] = [];
    for (const u of [...oldUris, ...newUris]) {
      const key = u.toString();
      if (seen.has(key)) { continue; }
      seen.add(key);
      affected.push(u);
    }
    if (affected.length > 0) {
      this._onDidChangeDecorations.fire(affected);
    }
  }

  dispose(): void {
    this._onDidChangeDecorations.dispose();
  }
}
