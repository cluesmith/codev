import * as vscode from 'vscode';
import type { PRView } from '@cluesmith/codev-types';
import {
  getBuilderChanges,
  getPullRequestChanges,
  planResources,
  type ChangeEntry,
  type ChangeStatus,
  type ResourcePlan,
} from '../commands/view-diff.js';
import { builderFileResourceUri } from './builder-file-tree-item.js';
import { pullRequestFileResourceUri } from './pull-request-file-tree-item.js';
import { ensurePullRequestHead, isFullCommitSha, type PullRequestHeadFailure } from '../pr-refs.js';

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

/** Why a pull request's file list could not be produced. Each renders as its own visible row. */
export type PullRequestDiffErrorKind =
  | 'forge-unavailable'
  | 'no-head-commit'
  | 'too-large'
  | 'git-failed'
  | PullRequestHeadFailure;

export interface PullRequestDiffResult {
  /** The head commit the list was computed at (the right side of every diff). */
  headSha: string;
  /** Merge-base of the base branch and the head (the left side of every diff). */
  baseRef: string;
  /** The PR's base branch, for labels. */
  baseRefName: string;
  files: BuilderFileChange[];
  error?: string;
  errorKind?: PullRequestDiffErrorKind;
  /** Changed-file count when `errorKind` is `too-large`. */
  fileCount?: number;
}

/**
 * Above this many changed files the PR's list is not rendered (a row says so
 * and offers the browser). GitHub's own per-PR file list stops at 3000.
 */
export const PULL_REQUEST_MAX_FILES = 3000;

/** A PR entry costs one forge call (via Tower) per miss, so it lives longer than a builder's. */
const PULL_REQUEST_TTL_MS = 60_000;

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
  /** prId → the PR's last computed file list. Separate from `cache` so ids never collide. */
  private readonly prCache = new Map<string, { ts: number; result: PullRequestDiffResult }>();
  /** prId → an in-flight load, so concurrent `getChildren` calls share one forge call + fetch. */
  private readonly prInFlight = new Map<string, Promise<PullRequestDiffResult>>();

  /** uri.toString() → status for every file currently shown across builders. */
  private readonly decorations = new Map<string, ChangeStatus>();
  /** Source key (`builderId`, or `pr:<id>`) → the URIs it contributed, so a recompute can replace them. */
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
   * A pull request's changed files (#2008): merge-base ↔ head commit, computed
   * in `repo` (the main checkout) after the head is fetched under the hidden
   * ref namespace. `loadPR` is the forge read (Tower `GET /api/pr`), called
   * once per TTL miss — that re-read is what notices a moved head.
   */
  async getPullRequestDiff(
    pr: { prId: string; repo: string },
    loadPR: () => Promise<PRView | null>,
  ): Promise<PullRequestDiffResult> {
    const hit = this.prCache.get(pr.prId);
    if (hit && Date.now() - hit.ts < PULL_REQUEST_TTL_MS) {
      return hit.result;
    }
    const pending = this.prInFlight.get(pr.prId);
    if (pending) { return pending; }
    const run = this.loadPullRequestDiff(pr, loadPR).then(result => {
      this.prCache.set(pr.prId, { ts: Date.now(), result });
      this.syncUris(pullRequestKey(pr.prId), result.files.map(f => ({
        uri: pullRequestFileResourceUri(pr.repo, pr.prId, f.change.path),
        status: f.change.status,
      })));
      return result;
    }).finally(() => this.prInFlight.delete(pr.prId));
    this.prInFlight.set(pr.prId, run);
    return run;
  }

  /** The last computed PR result, without loading (used to resolve tree parents). */
  peekPullRequestDiff(prId: string): PullRequestDiffResult | undefined {
    return this.prCache.get(prId)?.result;
  }

  /** Drop a PR's cached list + decorations, so the next expansion re-reads the forge. */
  invalidatePullRequest(prId: string): void {
    this.prCache.delete(prId);
    this.syncUris(pullRequestKey(prId), []);
  }

  /** Drop every cached PR not in `openIds` (closed or merged). */
  retainPullRequests(openIds: ReadonlySet<string>): void {
    for (const prId of [...this.prCache.keys()]) {
      if (!openIds.has(prId)) { this.invalidatePullRequest(prId); }
    }
  }

  /** Drop every cached PR (the view's refresh button). */
  invalidateAllPullRequests(): void {
    for (const prId of [...this.prCache.keys()]) { this.invalidatePullRequest(prId); }
  }

  private async loadPullRequestDiff(
    pr: { prId: string; repo: string },
    loadPR: () => Promise<PRView | null>,
  ): Promise<PullRequestDiffResult> {
    const empty = { headSha: '', baseRef: '', baseRefName: '', files: [] as BuilderFileChange[] };
    let view: PRView | null;
    try {
      view = await loadPR();
    } catch (error) {
      return { ...empty, errorKind: 'forge-unavailable', error: messageOf(error) };
    }
    if (!view) {
      return { ...empty, errorKind: 'forge-unavailable', error: 'Tower could not load this pull request from the forge' };
    }
    const baseRefName = view.baseRefName;
    // No fallback to the branch name (`headRefName`): a forge preset that does
    // not report the head commit cannot be diffed here.
    if (!isFullCommitSha(view.headRefOid)) {
      return { ...empty, baseRefName, errorKind: 'no-head-commit', error: 'this forge preset does not report the pull request head commit' };
    }
    const headSha = view.headRefOid;
    const head = await ensurePullRequestHead(pr.repo, { prId: pr.prId, headSha, baseRefName });
    if (!head.ok) {
      return { ...empty, headSha, baseRefName, errorKind: head.kind, error: head.detail };
    }
    try {
      const { changes, binaryPaths } = await getPullRequestChanges(pr.repo, head.mergeBase, headSha);
      const result = { headSha, baseRef: head.mergeBase, baseRefName, files: [] as BuilderFileChange[] };
      if (changes.length > PULL_REQUEST_MAX_FILES) {
        return { ...result, errorKind: 'too-large', fileCount: changes.length, error: `${changes.length} changed files` };
      }
      const plans = planResources(changes, binaryPaths, 'head');
      result.files = changes.map((change, i) => ({ change, plan: plans[i]! }));
      return result;
    } catch (error) {
      return { ...empty, headSha, baseRefName, errorKind: 'git-failed', error: messageOf(error) };
    }
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
    this.syncUris(builderId, result.files.map(f => ({
      uri: builderFileResourceUri(worktreePath, f.change.path),
      status: f.change.status,
    })));
  }

  /** Replace one source's decorated URIs and fire the affected set (old ∪ new). */
  private syncUris(key: string, entries: Array<{ uri: vscode.Uri; status: ChangeStatus }>): void {
    const oldUris = this.builderUris.get(key) ?? [];
    for (const u of oldUris) { this.decorations.delete(u.toString()); }

    const newUris: vscode.Uri[] = [];
    for (const { uri, status } of entries) {
      this.decorations.set(uri.toString(), status);
      newUris.push(uri);
    }
    this.builderUris.set(key, newUris);

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

function pullRequestKey(prId: string): string {
  return `pr:${prId}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) { return error.message; }
  return String(error);
}
