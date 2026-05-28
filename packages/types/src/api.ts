/**
 * Tower API response shapes.
 *
 * These types are shared between the server (packages/codev),
 * the browser dashboard (packages/codev/dashboard), and the
 * VS Code extension (packages/codev-vscode).
 */

// --- Dashboard State (GET /workspace/:path/api/state) ---

export interface ArchitectState {
  /**
   * The architect's stable name (Spec 755). For single-architect workspaces this is
   * `'main'`. For sibling-architect workspaces, additional architects are
   * `'architect-2'`, `'architect-3'`, or whatever custom name was supplied via
   * `afx workspace add-architect --name <name>`.
   */
  name: string;
  port: number;
  pid: number;
  terminalId?: string;
  persistent?: boolean;
}

export interface Builder {
  id: string;
  name: string;
  port: number;
  pid: number;
  status: string;
  phase: string;
  worktree: string;
  branch: string;
  type: string;
  projectId?: string;
  terminalId?: string;
  persistent?: boolean;
  /**
   * Spec 755 / Spec 786: the architect that spawned this builder, if any.
   * `null` for builders spawned outside of an architect context; the
   * architect's name (`'main'` or a sibling name) otherwise. Surfaced to the
   * dashboard so the remove-architect confirmation modal (Phase 4) can show
   * users which builders are affected before they confirm the removal.
   */
  spawnedByArchitect?: string | null;
}

export interface UtilTerminal {
  id: string;
  name: string;
  port: number;
  pid: number;
  terminalId?: string;
  persistent?: boolean;
  lastDataAt?: number;
}

export interface Annotation {
  id: string;
  file: string;
  port: number;
  pid: number;
  /**
   * Optional parent reference. The Tower `/api/state` handler does not populate
   * this; the field is reserved for richer client-driven annotation flows that
   * may emerge later. Treat as informational only.
   */
  parent?: { type: string; id?: string };
}

export interface DashboardState {
  /**
   * Backward-compatible scalar pointer to the dashboard's "default" architect.
   * Populated as the architect named `'main'` if present, else the first
   * registered architect. Consumers that only need one architect (e.g. older
   * VSCode-extension builds) should read this field.
   */
  architect: ArchitectState | null;
  /**
   * Full collection of registered architects (Spec 761). The entry whose
   * `name === 'main'` is always at index 0 when present; remaining entries
   * follow insertion order from Tower's internal map. Empty array means no
   * architect is registered. Consumers that need to surface all architects
   * (e.g. the dashboard tab strip) should read this field.
   */
  architects: ArchitectState[];
  builders: Builder[];
  utils: UtilTerminal[];
  annotations: Annotation[];
  workspaceName?: string;
  version?: string;
  hostname?: string;
  teamEnabled?: boolean;
}

// --- Terminal Entry (returned by tower routes) ---

export interface TerminalEntry {
  type: 'architect' | 'builder' | 'shell' | 'file';
  id: string;
  label: string;
  url: string;
  active: boolean;
  /**
   * Spec 786 Phase 5: when `type === 'architect'`, the architect's stable
   * name (`'main'` or a sibling). Allows consumers to enumerate architects
   * without parsing the tab id.
   */
  architectName?: string;
  /**
   * Spec 786 Phase 5: live PID from Tower's in-memory PtySession (architect
   * entries only; not persisted in `state.db`).
   */
  pid?: number;
  /**
   * Spec 786 Phase 5: port assigned to the terminal, if any.
   */
  port?: number;
  /**
   * Spec 786 Phase 5: the underlying PtySession id. For architects, the
   * `id` field carries the tab identifier (Spec 761 deep-link convention);
   * this field exposes the actual session id for terminal-attach correlation.
   */
  terminalId?: string;
}

// --- Overview (GET /api/overview) ---

export interface OverviewBuilder {
  id: string;
  issueId: string | null;
  issueTitle: string | null;
  phase: string;
  mode: 'strict' | 'soft';
  gates: Record<string, string>;
  worktreePath: string;
  /**
   * Canonical role identifier (e.g. `builder-pir-1423`) derived from the
   * worktree basename. Stable across requests for a given builder while
   * its worktree exists, and the key by which Tower's runtime terminal
   * registry indexes the live session. `null` for soft-mode builders
   * whose worktree name doesn't match a known protocol pattern.
   */
  roleId: string | null;
  protocol: string;
  planPhases: Array<{ id: string; title: string; status: string }>;
  progress: number;
  /** Human-readable label for the gate the builder is blocked on (e.g. "plan review"). */
  blocked: string | null;
  /**
   * Canonical gate name (e.g. "plan-approval") for the gate the builder is
   * blocked on. Use this when calling `porch approve` — `blocked` is a
   * display label and won't match porch's gate keys.
   */
  blockedGate: string | null;
  blockedSince: string | null;
  startedAt: string | null;
  idleMs: number;
  /**
   * Wall-clock ISO timestamp of the last DATA frame Tower received from
   * this builder's shellper, or `null` when no live session exists.
   * Clients use it to flag builders that have been silent for a threshold
   * — likely waiting for non-gate human input. Distinct from `idleMs`,
   * which sums time spent at formal porch gates.
   */
  lastDataAt: string | null;
  /**
   * Name of the architect that spawned this builder (Spec 755 / 823). `null` for
   * legacy rows from before #755, for builders whose worktree doesn't have a
   * matching row in `state.db.builders`, or when state.db is unavailable. Used
   * by the dashboard to render an inline attribution tag when the workspace
   * hosts more than one architect.
   */
  spawnedByArchitect: string | null;
  /**
   * Single `area/*` value for this builder's issue, projected via
   * `parseArea` (first-alphabetical wins; `'Uncategorized'` when the
   * builder has no issue or the issue has no `area/*` labels).
   * Required-with-default — never `undefined`. Consumed by the
   * builders-tree grouping in #818 and the equivalent dashboard view.
   */
  area: string;
  /**
   * Canonical "PR is waiting on a human reviewer" signal (Issue #872). True the
   * moment porch transitions out of the CMAP-emitting state for the PR-creating
   * phase, for ALL bundled protocols. Computed from `pr_ready_for_human` in
   * status.yaml when present; otherwise falls back to the v3.1.3 derived logic
   * (`blocked === 'PR review'` || BUGFIX `phase === 'verified'`) so in-flight
   * projects from before this field shipped continue to surface correctly.
   *
   * Consumers gate on this single boolean instead of deriving from the
   * protocol-specific gate shape (the v3.1.3 derivation silently dropped
   * BUGFIX PRs because BUGFIX has no `pr` gate).
   */
  prReady: boolean;
}

export interface OverviewPR {
  id: string;
  title: string;
  url: string;
  reviewStatus: string;
  linkedIssue: string | null;
  createdAt: string;
  author?: string;
}

export interface OverviewBacklogItem {
  id: string;
  title: string;
  url: string;
  type: string;
  priority: string;
  /**
   * Single `area/*` value for this issue, projected via `parseArea`
   * (first-alphabetical wins; `'Uncategorized'` when the issue has no
   * `area/*` labels). Required-with-default — never `undefined`. Consumed
   * by the backlog grouping in #811 and the equivalent vscode view.
   */
  area: string;
  hasSpec: boolean;
  hasPlan: boolean;
  hasReview: boolean;
  hasBuilder: boolean;
  createdAt: string;
  author?: string;
  assignees?: string[];
  specPath?: string;
  planPath?: string;
  reviewPath?: string;
}

export interface OverviewRecentlyClosed {
  id: string;
  title: string;
  url: string;
  type: string;
  closedAt: string;
  prUrl?: string;
  specPath?: string;
  planPath?: string;
  reviewPath?: string;
}

export interface OverviewData {
  builders: OverviewBuilder[];
  pendingPRs: OverviewPR[];
  backlog: OverviewBacklogItem[];
  recentlyClosed: OverviewRecentlyClosed[];
  /**
   * Issue IDs of PRs merged in the recent window (matches the
   * `fetchRecentMergedPRs` 24h window in the overview server). Consumers
   * cross-reference this against a builder's `issueId` to detect post-merge
   * builders whose status.yaml may still carry stale `prReady: true` — used
   * by `NeedsAttentionList` to skip the cache-miss defensive emit when the
   * PR is correctly absent from `pendingPRs` because it has been merged
   * (Issue #901). Empty array when the forge call fails or returns no rows.
   */
  recentlyMergedIssueIds: string[];
  /** Auto-detected GitHub login of the current user (via the user-identity forge concept). */
  currentUser?: string;
  errors?: { prs?: string; issues?: string };
}

// --- Worktree config (GET /api/worktree-config) ---

/** One row in the VSCode "Open Dev URL" workspace surface. */
export interface WorktreeDevUrl {
  label: string;
  url: string;
}

/**
 * Resolved view of the `worktree` config block with defaults applied
 * across the loadConfig layer chain (defaults / cache / global /
 * project / project-local). Always has populated fields — unset
 * scalars collapse to null, unset collections to empty arrays — so
 * consumers don't have to branch.
 */
export interface ResolvedWorktreeConfig {
  /** Glob patterns to symlink from workspace root into each worktree. `[]` when unset. */
  symlinks: string[];
  /** Shell commands to run in each worktree after creation. `[]` when unset. */
  postSpawn: string[];
  /** Command for `afx dev <builder-id>`. `null` when unset. */
  devCommand: string | null;
  /**
   * Canonical resolved list of dev URLs for the VSCode "Open Dev URL"
   * workspace surface. Always an array — `[]` when neither `devUrl`
   * nor `devUrls` is set in the user config.
   */
  devUrls: WorktreeDevUrl[];
}

// --- Issue view (GET /api/issue) ---

/**
 * A single issue as returned by the `issue-view` forge concept and
 * surfaced verbatim by Tower's GET /api/issue. Mirrors the server-side
 * IssueViewResult (packages/codev/src/lib/forge-contracts.ts).
 */
export interface IssueView {
  title: string;
  body: string;
  state: string;
  comments: Array<{
    body: string;
    createdAt: string;
    author: { login: string };
  }>;
}

// --- Team (GET /workspace/:path/api/team) ---

export interface ReviewBlockingEntry {
  direction: 'authored' | 'reviewing';
  otherName: string;
  otherGithub: string;
  pr: {
    number: number;
    title: string;
    url: string;
    createdAt: string;
  };
}

export interface TeamMemberGitHubData {
  // node arrays are capped at GitHub search `first` (20) and feed lists /
  // review-blocking; the *Count fields are the true totals (search.issueCount)
  // and must be used for any "N assigned / N open" display.
  assignedIssues: { number: number; title: string; url: string }[];
  assignedIssuesCount: number;
  openPRs: { number: number; title: string; url: string }[];
  openPRsCount: number;
  recentActivity: {
    mergedPRs: { number: number; title: string; url: string; mergedAt: string }[];
    mergedPRsCount: number;
    closedIssues: { number: number; title: string; url: string; closedAt: string }[];
    closedIssuesCount: number;
  };
  reviewBlocking: ReviewBlockingEntry[];
}

export interface TeamApiMember {
  name: string;
  github: string;
  role: string;
  filePath: string;
  github_data: TeamMemberGitHubData | null;
}

export interface TeamApiMessage {
  author: string;
  timestamp: string;
  body: string;
  channel: string;
}

export interface TeamApiResponse {
  enabled: boolean;
  members?: TeamApiMember[];
  messages?: TeamApiMessage[];
  warnings?: string[];
  githubError?: string;
}

// --- Tunnel (GET /api/tunnel/status) ---

export interface TunnelStatus {
  registered: boolean;
  state: 'disconnected' | 'connecting' | 'connected' | 'auth_failed' | 'error';
  uptime: number | null;
  towerId: string | null;
  towerName: string | null;
  serverUrl: string | null;
  accessUrl: string | null;
}

// --- Analytics (GET /api/analytics) ---

export interface ProtocolStats {
  count: number;
  avgWallClockHours: number | null;
  avgAgentTimeHours: number | null;
}

export interface AnalyticsResponse {
  timeRange: '24h' | '7d' | '30d' | 'all';
  activity: {
    prsMerged: number;
    medianTimeToMergeHours: number | null;
    issuesClosed: number;
    medianTimeToCloseBugsHours: number | null;
    projectsByProtocol: Record<string, ProtocolStats>;
  };
  consultation: {
    totalCount: number;
    totalCostUsd: number | null;
    costByModel: Record<string, number>;
    avgLatencySeconds: number | null;
    successRate: number | null;
    byModel: Array<{
      model: string;
      count: number;
      avgLatency: number;
      totalCost: number | null;
      successRate: number;
    }>;
    byReviewType: Record<string, number>;
    byProtocol: Record<string, number>;
  };
  errors?: {
    github?: string;
    consultation?: string;
  };
}
