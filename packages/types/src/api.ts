import type { ServedAgentState } from './agent-state.js';
import type { PeerCloudLimits, PeerListedSwitchState } from './peer-wire.js';

/**
 * Tower API response shapes.
 *
 * These types are shared between the server (packages/codev),
 * the browser dashboard (packages/codev/dashboard), and the
 * VS Code extension (packages/codev-vscode).
 */

/**
 * The largest request body Tower reads, in bytes: past it, the request is dropped
 * unanswered. A literal, so the SDK's mirror of it is checked against this.
 */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

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
  /**
   * Spec 1595: the architect's served attention state. Optional and nullable:
   * absent and `null` both mean unknown.
   */
  agentState?: ServedAgentState | null;
  /**
   * Spec 1595: wall-clock ISO time of the architect session's last PTY output,
   * for the sdk's `working` staleness rule. Optional and nullable like
   * `OverviewBuilder.lastDataAt`'s `null`.
   */
  lastDataAt?: string | null;
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
  /**
   * Spec 1819: true when the workspace's decisions file (config
   * `dashboard.decisionsFile`, default `codev/state/pending-decisions.md`)
   * exists inside the workspace. Controls the Decisions tab's visibility.
   */
  decisionsEnabled?: boolean;
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

/**
 * A single plan sub-phase as surfaced in the overview payload. `status` is a
 * free-form string (not the narrower porch `PlanPhaseStatus` union) because the
 * overview parser reads it verbatim out of `status.yaml`. Named shape so both
 * the server and `OverviewBuilder.planPhases` reference one declaration.
 */
export interface PlanPhase {
  id: string;
  title: string;
  status: string;
}

export interface OverviewBuilder {
  id: string;
  issueId: string | null;
  issueTitle: string | null;
  /**
   * Display phase. Collapsed: prefers the active plan sub-phase id
   * (`current_plan_phase`, e.g. `phase_5`) over the protocol phase, so the
   * dashboard can match it against `planPhases` to render sub-phase progress
   * (`(1/4)`). NOT the coarse protocol phase — read `protocolPhase` for that.
   */
  phase: string;
  /**
   * Coarse *protocol* phase — `plan` / `implement` / `review` (and `specify` /
   * `verify` for SPIR/ASPIR). The raw `phase:` from `status.yaml`, before the
   * `phase` field's sub-phase collapse. Surfaces the high-level phase for
   * at-a-glance UIs (the VSCode builders-tree row prefix, #810) without leaking
   * free-form plan sub-phase ids like `phase_0_rebase_onto_ci`. Empty string
   * when no live status exists.
   */
  protocolPhase: string;
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
  planPhases: PlanPhase[];
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
   * Spec 1595: the builder's served attention state (working / needs-input /
   * idle / blocked / dead). Optional and nullable: absent and `null` both mean
   * unknown, and consumers fall back to the `lastDataAt` silence rule.
   */
  agentState?: ServedAgentState | null;
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
   * Canonical "PR is waiting on a human reviewer" signal. Gate-authoritative
   * (#927): true exactly when the builder's `pr` gate is genuinely pending
   * (`status: pending` + `requested_at`). Porch requests the `pr` gate after
   * the PR phase / CMAP for EVERY bundled PR-producing protocol (BUGFIX, AIR,
   * SPIR, ASPIR, PIR — #887 gave BUGFIX a `pr` gate), so the pending `pr` gate
   * is the uniform post-CMAP signal.
   *
   * Consumers gate on this single boolean instead of deriving from the
   * protocol-specific gate shape. (Earlier revisions read `pr_ready_for_human`
   * plus a `bugfix && phase === 'verified'` fallback; #927 dropped both in
   * favor of reading the `pr` gate directly — the field is coincident with the
   * gate, and the gate read avoids the sticky-`false` rollback hazard.)
   */
  prReady: boolean;
  /**
   * Spec 1313: count of currently-held mailbox rows addressed to THIS builder (its
   * `roleId`). Optional — `undefined` (or absent) means none held, so existing
   * consumers/producers need no change. Count only, never message bodies.
   */
  heldCount?: number;
}

export interface OverviewPR {
  id: string;
  title: string;
  url: string;
  reviewStatus: string;
  linkedIssue: string | null;
  createdAt: string;
  author?: string;
  /**
   * Logins of users requested as reviewers, flowed through from the `pr-list`
   * forge concept. Consumed by the VSCode PR sidebar to sort PRs awaiting the
   * current user's review above unrelated ones. Empty array when the forge
   * exposes no review-request list.
   */
  reviewRequests: string[];
  /** Whether the PR is a draft. Drives the draft badge in the VSCode PR sidebar. */
  isDraft: boolean;
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
  /** ISO 8601 creation time; absent when the forge cannot supply it (Jira, #1740). */
  createdAt?: string;
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

/** The shape of a workspace's issue ids: bare numbers, or tracker keys like `ENG-123`. */
export type IssueIdKind = 'number' | 'key';

export interface OverviewData {
  builders: OverviewBuilder[];
  pendingPRs: OverviewPR[];
  backlog: OverviewBacklogItem[];
  recentlyClosed: OverviewRecentlyClosed[];
  /**
   * The workspace's architects with a live session (Issue 1104), main-first.
   * Carries the same `ArchitectState[]` shape `DashboardState.architects`
   * exposes, built by the shared `liveArchitects` helper from the live terminal
   * sessions, so the overview payload and the dashboard-state payload never
   * drift. Only architects with a live session are listed (stale registrations
   * are skipped). `[]` when the workspace has no architects or none are live —
   * never `undefined`, so consumers don't branch. Lets the VSCode Agents tree
   * render its architect tier and the architect-attribution badge straight off
   * the overview cache without a second fetch.
   */
  architects: ArchitectState[];
  /**
   * Spec 1313: count of currently-*held* mailbox rows across this workspace (all
   * recipient agents — builders and architects). Drives the dashboard/VSCode
   * held-count indicator. Count only, never message bodies. 0 when nothing is held.
   *
   * Issue 1450: this counts ELIGIBLE held rows only — a pre-due `--delay` send is
   * excluded (`heldSummaryForWorkspace`). `GET /api/inbox` lists ALL held rows,
   * pre-due ones included, so this number is a LOWER BOUND on that list's length.
   * See `HeldMessage` for the full explanation; any surface showing both must
   * render the difference rather than assume they agree.
   */
  heldCount: number;
  /**
   * Spec 1313: true when at least one held row in this workspace has crossed the
   * escalation age — puts the indicator into its attention state. Visibility only;
   * escalation never triggers delivery.
   */
  mailboxEscalated: boolean;
  /**
   * Issue 1410: per-builder count of pending review-comments (the queued
   * feedback in each builder's `.codev/pending-comments.json`), keyed by
   * `OverviewBuilder.id`. A **map, never a scalar total** — the Stream Deck
   * badge reads its selected builder's count, and #1049's future Attention
   * rollup consumes the same field. A builder absent from the map has none
   * (read as 0); `{}` when nothing is queued anywhere — never `undefined`, so
   * consumers don't branch.
   */
  queuedFeedback: Record<string, number>;
  /**
   * Issue 1410: the workspace's current review-feedback delivery mode, projected
   * from the VSCode `codev.diffCodelensMode` setting (`forward` → `'forward'`,
   * `comment` → `'queue'`). `'forward'` = a review chunk is sent to the builder
   * immediately; `'queue'` = it accumulates in the pending-comments queue until
   * flushed. Lets the deck name the live semantic on the dial touchscreen
   * (`Files · send` vs `Files · queue`) instead of inferring it. Defaults to
   * `'forward'` (the setting's own default) when unreadable.
   */
  feedbackMode: 'forward' | 'queue';
  /** Auto-detected GitHub login of the current user (via the user-identity forge concept). */
  currentUser?: string;
  /**
   * Issue #1740: the shape of this workspace's issue ids, from its configured
   * forge provider: `'number'` (GitHub, GitLab, Gitea: `42`) or `'key'` (Linear,
   * Jira: `ENG-123`). Clients gate key-shaped input on it. Absent when Tower
   * cannot tell (the issue concepts are overridden by hand, or an older Tower);
   * clients then fall back to their own inference.
   */
  issueIdKind?: IssueIdKind;
  /**
   * Issue #1645: why forge-backed sections (PRs, backlog, recently closed/merged)
   * may be stale or empty. `rate-limited` = the backend's budget is exhausted and
   * Tower has suspended fetches until `forgeResetAt`; `unavailable` = at least one
   * section could not be fetched for another reason (CLI missing, offline).
   */
  forgeStatus?: 'ok' | 'rate-limited' | 'unavailable';
  /** ISO instant the rate-limit suspension lifts; present only when `forgeStatus` is `rate-limited`. */
  forgeResetAt?: string;
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

// --- Activity hooks (GET /api/activity-hooks) ---

/** An abstract Codev activity the extension publishes to configured URL hooks. */
export type ActivityEvent = 'window-focus' | 'builder-active';

/**
 * One configured sink from the `activityHooks` config block: when one of `on`'s
 * events fires, the extension opens `url` (a template — `{workspace}`/`{builder}`
 * placeholders are replaced with the URL-encoded event data). `background: true`
 * delivers without foregrounding the handler app. The destination is the user's
 * (a deep link, a companion app, a webhook launcher); the extension is agnostic.
 */
export interface ActivityHook {
  on: ActivityEvent[];
  url: string;
  background?: boolean;
}

/**
 * Resolved `activityHooks`. SECURITY: hooks resolve from the **personal config
 * layers only** — `~/.codev/config.json` (global) + `.codev/config.local.json`
 * (per-engineer) — and NEVER the committed `.codev/config.json` project layer.
 * Hooks open URLs (a deep link, a companion app, a scheme handler), so sourcing
 * them from repo-committed config would be a zero-click RCE (a cloned repo could
 * ship a hook url that fires on `window-focus`). Do NOT widen this to `loadConfig`.
 * Malformed entries are dropped; `hooks` is always an array (`[]` when unset).
 */
export interface ResolvedActivityHooks {
  hooks: ActivityHook[];
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
  /**
   * The issue's **browser/web** URL (NOT an API endpoint), when the forge
   * concept supplies it. Each forge maps its own web-URL field into this:
   * GitHub `url`, GitLab `web_url`, Gitea `html_url` (Gitea's `url` is the API
   * endpoint — do not use it), Linear `url`, Jira `<site>/browse/<key>` (never
   * the REST `self` link, which names an infrastructure host). Optional so the contract stays
   * forge-neutral; consumers that open the issue in a browser degrade
   * gracefully when it's absent (e.g. a forge script that doesn't emit it).
   */
  url?: string;
  /**
   * Login/handle of the user who opened the issue, when the forge concept
   * supplies it: GitHub `author.login`, GitLab `author.username`, Gitea
   * `user.login`, Linear `creator.displayName`, Jira the creator's email
   * (falling back to display name). Optional so the contract
   * stays forge-neutral — a forge/script that omits it degrades gracefully
   * (the consumer drops the "opened by" attribution).
   */
  author?: { login: string };
  /**
   * ISO 8601 creation timestamp, when the forge concept supplies it. Optional
   * for forge-neutral degradation, same as `url`.
   */
  createdAt?: string;
  /**
   * Assignee logins/handles, when the forge concept supplies them: absent when
   * the forge doesn't expose them, empty when the issue is unassigned. Optional
   * per the forge-neutral degradation contract.
   */
  assignees?: Array<{ login: string }>;
  /**
   * Issue labels, when the forge concept supplies them: absent when the forge
   * doesn't expose labels, empty when the issue has none. Optional per the
   * forge-neutral degradation contract.
   */
  labels?: Array<{ name: string }>;
  /**
   * The issue's milestone, when set. GitHub emits a literal `null` when the
   * issue has no milestone (hence `| null`, not merely optional); consumers
   * guard on `milestone?.title`, so both absent and null render nothing.
   * Optional/nullable per the forge-neutral degradation contract.
   */
  milestone?: { title: string } | null;
  comments: Array<{
    body: string;
    createdAt: string;
    author: { login: string };
  }>;
}

// --- PR view (GET /api/pr) ---

/**
 * A single PR as returned by the `pr-view` forge concept and surfaced
 * verbatim by Tower's GET /api/pr. Mirrors the server-side PrViewResult
 * (packages/codev/src/lib/forge-contracts.ts).
 */
export interface PRView {
  title: string;
  body: string;
  state: string;
  /**
   * The PR's **browser/web** URL (NOT an API endpoint), when the forge
   * concept supplies it. Each forge maps its own web-URL field into this:
   * GitHub `url`, GitLab `web_url`, Gitea `html_url` (Gitea's `url` is the
   * API endpoint — do not use it). Optional so the contract stays
   * forge-neutral; consumers that open the PR in a browser degrade
   * gracefully when it's absent (e.g. a forge script that doesn't emit it).
   */
  url?: string;
  author: { login: string };
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
}

// --- Issue search (GET /api/issue-search) ---

/**
 * One searchable issue row returned by Tower's GET /api/issue-search.
 * Distinct from `OverviewBacklogItem`: it carries the issue `body` (so the
 * search panel can match against it host-side) and omits the spec/plan/
 * builder enrichment the sidebar tree needs. Body lives only on this
 * on-demand search path — `OverviewBacklogItem` and `/api/overview` stay
 * body-free so the always-on overview payload doesn't grow.
 */
export interface IssueSearchItem {
  id: string;
  title: string;
  url: string;
  /** Single `area/*` value (via `parseArea`); `'Uncategorized'` when unlabeled. */
  area: string;
  author?: string;
  assignees?: string[];
  /** ISO 8601 creation time; absent when the forge cannot supply it (Jira, #1740). */
  createdAt?: string;
  /** Issue body for substring matching. `''` when the forge can't supply it. */
  body: string;
}

/**
 * Response shape of GET /api/issue-search. `currentUser` powers the
 * panel's "Me"/"Unassigned" assignee scope. `error` is set (with an empty
 * `items`) when the forge is unavailable, so the panel can show a reason
 * rather than a silent empty table.
 */
export interface IssueSearchResponse {
  items: IssueSearchItem[];
  currentUser?: string;
  error?: string;
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

// --- Decisions (GET/POST /workspace/:path/api/decisions…, Spec 1819) ---

/**
 * A heading timestamp, resolved to an instant only from the zone written in it or, failing
 * that, the file's `_Zone: …_` line.
 */
export interface DecisionStamp {
  /** The stamp exactly as written in the heading. */
  raw: string;
  /** ISO-8601 UTC instant, or null when the stamp could not be converted. */
  instant: string | null;
  /** The stamp gives a time but no date (it was read as today): show the time alone. */
  timeOnly?: true;
  /**
   * Why `instant` is null, when the stamp names a zone the tab cannot use or a time the
   * clocks skipped or repeated. Absent with a null instant: no zone is known, so the stamp
   * is shown as written.
   */
  unconvertedReason?: 'unknown-zone' | 'nonexistent-time' | 'ambiguous-time';
}

export interface DecisionOption {
  /** The backticked word the owner chooses (and the tab writes). */
  word: string;
  /**
   * The text after `=` on the `**Your word:**` line; failing that, the word's entry in the
   * item body's `**Options:**` (`(a) `word` = …`, `(a) `word`: …` or `- `word` = …`); else ''.
   */
  description: string;
  /** The first option on the `**Your word:**` line. */
  recommended: boolean;
}

/** One `- **You asked (t):**` / `- **<Name>'s answer (t):**` entry from an item body. */
export type DecisionQaEntry =
  | { kind: 'asked'; time: string; markdown: string; answered: boolean }
  | { kind: 'answer'; name: string; time: string; markdown: string };

export type DecisionItemProblem =
  | 'id-missing'
  | 'duplicate-id'
  | 'your-word-missing'
  | 'your-word-multiple';

export type DecisionsFileProblem = 'open-missing' | 'open-multiple' | 'ruled-multiple';

export interface DecisionItem {
  id: string;
  stamp: DecisionStamp | null;
  question: string;
  /** Item body markdown (heading → `**Your word:**` line), Q&A entries removed. */
  bodyMarkdown: string;
  options: DecisionOption[];
  /** Text after the `**Your word:**` line, trimmed, verbatim; '' when unruled. */
  currentRuling: string;
  qa: DecisionQaEntry[];
  /** SHA-256 of the item's exact text (trailing blank lines excluded); echoed back on a ruling request. */
  fingerprint: string;
  problems: DecisionItemProblem[];
  /** Whether the tab may write a ruling for this item. */
  writable: boolean;
}

export interface DecisionsDocument {
  /** Workspace-relative path of the decisions file. */
  path: string;
  /** SHA-256 of the whole file; changes whenever the file does. */
  version: string;
  /** `## Open` items, in file order. */
  items: DecisionItem[];
  /** `## Ruled` section content (markdown), '' when absent. */
  ruledMarkdown: string;
  problems: DecisionsFileProblem[];
}

export interface DecisionsRuleRequest {
  id: string;
  word?: string;
  comment?: string;
  fingerprint: string;
}

export type DecisionsRefusalCode =
  | 'invalid-request'
  | 'empty-ruling'
  | 'comment-too-long'
  | 'comment-heading'
  | 'comment-fence'
  | 'comment-your-word'
  | 'open-multiple'
  | 'heading-missing'
  | 'heading-duplicate'
  | 'your-word-missing'
  | 'your-word-multiple'
  | 'already-ruled'
  | 'unknown-word'
  | 'item-changed'
  | 'structure-changed'
  | 'not-utf8'
  | 'write-failed'
  | 'not-found'
  | 'outside-workspace'
  | 'config-error'
  | 'not-an-image'
  | 'image-too-large';

/** GET …/api/decisions. */
export type DecisionsReadResponse =
  | { ok: true; document: DecisionsDocument }
  | { ok: false; code: DecisionsRefusalCode; message: string };

/** POST …/api/decisions/rule; on success, the document re-parsed from the bytes just written. */
export type DecisionsRuleResponse =
  | { ok: true; document: DecisionsDocument }
  | { ok: false; code: DecisionsRefusalCode; message: string };

// --- Workspace address name (PUT /api/workspaces/:encodedPath/address-name) ---

/**
 * Body of `PUT /api/workspaces/:encodedPath/address-name` (Spec 1940): the explicit name
 * other workspaces address this one by. `null` clears it, and the workspace is addressed
 * by its directory basename again.
 */
export interface SetWorkspaceAddressNameRequest {
  name: string | null;
}

/**
 * The 200 response: what the workspace is addressed by now. A refusal is the usual Tower
 * error body, `{ error, message }`, with `error` one of `INVALID_NAME` or `RESERVED_NAME`
 * (400), `NAME_TAKEN` (409), or `NOT_FOUND` (404, a workspace Tower has not registered).
 */
export interface SetWorkspaceAddressNameResponse {
  /** The explicit name now stored, lower-cased; `null` after a clear. */
  explicitName: string | null;
  /**
   * The name that reaches this workspace now: the explicit name, else its basename.
   * `null` when it has none, which can only follow a clear (its basename is another
   * workspace's name, or is shared with another running workspace).
   */
  addressName: string | null;
  /** Why it has no address name. Present exactly when `addressName` is `null`. */
  unaddressableReason?: string;
}

// --- Address book (GET /api/address-book) ---

/**
 * One agent in the address book (Spec 1940, Decision 6): an architect, a builder or a
 * shell, with the address the caller would type to reach it.
 */
export interface AddressBookAgent {
  kind: 'architect' | 'builder' | 'shell';
  /** An architect's name, or a builder's or a shell's id. */
  name: string;
  /**
   * The address of this agent as the caller writes it: `<workspace>:architect:<name>` or
   * `<workspace>:<id>`, and the form with no workspace for an agent in the caller's own
   * workspace when that workspace has no usable name. `null` when there is no address to
   * give: the workspace has no usable name and is not the caller's, or the agent's own
   * name cannot be written in an address.
   */
  address: string | null;
  /** Does it have a live terminal now? Mail to one that does not is held for it. */
  live: boolean;
  /**
   * Does `afx send <address>`, run by this caller now, reach this agent? Tower answers by
   * resolving the address as the caller, the way the send route does. Always `false` when
   * `address` is `null`.
   */
  sendable: boolean;
  /**
   * When the caller is not allowed to name this agent (a builder and an architect that did
   * not spawn it): the address that is the way in. Absent when the caller may name it, and
   * when that address reaches nobody either.
   */
  reachThrough?: string;
}

/** One workspace in the address book: every workspace Tower has registered is listed. */
export interface AddressBookWorkspace {
  path: string;
  /**
   * Whether it is running: Tower holds at least one open terminal for it (Issue #1978). A
   * workspace that is not has no agents listed, and an address that names it is refused.
   */
  running: boolean;
  /** The name other workspaces write before the colon; `null` when it has none it can be written by. */
  addressName: string | null;
  /** Why it has no address name, with the remedy. Present exactly when `addressName` is `null`. */
  unaddressableReason?: string;
  /** Architects, then builders, then shells. Empty for a workspace that is not running. */
  agents: AddressBookAgent[];
}

/**
 * The 200 response of `GET /api/address-book?workspace=<path>&from=<id>`: every workspace
 * on this Tower and its agents, as addresses for the caller the query names. `workspace`
 * and `from` are the caller's, as `POST /api/send` takes them; both are optional, and a
 * caller that gives neither is treated as a sender outside every workspace.
 */
export interface AddressBookResponse {
  workspaces: AddressBookWorkspace[];
}

// --- Peers: the remote-messaging switch, grants and the peer list (Spec 1967; /api/peer/…) ---
//
// The local routes behind `afx peer on|off|list|grants|grant|revoke|limits`. A refusal is the
// usual Tower error body, `{ error, message }`. The codes: `INVALID_PARAMS` (400),
// `HUMAN_APPROVAL_REQUIRED` (403: turning the switch on and adding a grant are a human's
// acts), `NOT_OVER_TUNNEL` (403: neither is accepted from Codev Cloud's tunnel),
// `NOT_AVAILABLE` (400: another owner's Tower, stage 3), `NOT_A_PEER` (400: this Tower
// itself), `UNKNOWN_TOWER` (404), `NOT_GRANTABLE` (400: an address no grant can name),
// `NOT_FOUND` (404: no such workspace or architect, or no grant to remove), `AMBIGUOUS`
// (409), `CONFIG_INVALID` (500).

/** The remote-messaging switch (`GET /api/peer/switch`, `PUT /api/peer/switch`). */
export interface PeerSwitchResponse {
  state: 'on' | 'off';
  /** Did this request change it? Always `false` for a GET and for a request that asked for the state it was in. */
  changed: boolean;
  /** When a human last turned it on or off, epoch ms; `null` if never. */
  changedAt: number | null;
  /** This Tower's own name, the slug Codev Cloud gave it; `null` if it has never been registered. */
  towerName: string | null;
  /** How many grants this Tower holds. */
  grantCount: number;
  /**
   * What this Tower did to tell Codev Cloud of the change (contract section 2); `null` when
   * nothing changed. `reporting`: the report is under way, retried if it fails. `tunnel-down`:
   * not reported now, and the next connection states it. `not-connected`: this Tower has no
   * registration, or the cloud removed it. `no-relay`: the cloud has no relay, so there is
   * nothing to tell. `failed`: the report could not be started (see the Tower log); the next
   * connection states the switch.
   */
  cloudReport: PeerSwitchReport | null;
}

/** See {@link PeerSwitchResponse.cloudReport}. */
export type PeerSwitchReport = 'reporting' | 'tunnel-down' | 'not-connected' | 'no-relay' | 'failed';

/** Body of `PUT /api/peer/switch`. `on` is refused unless `humanApproved` is `true`. */
export interface PeerSwitchRequest {
  state: 'on' | 'off';
  humanApproved?: boolean;
}

/**
 * What a grant covers (Spec 1940, Decision 4): a workspace's front door, resolved when mail
 * arrives; one architect by name; every architect of a workspace; or everything here.
 */
export type PeerGrantScopeName = 'front-door' | 'architect' | 'architects' | 'all';
/** What happens to mail a grant admits: delivered, or held for release by a human. */
export type PeerGrantModeName = 'deliver' | 'hold';

/** The recipients of a grant request, as `afx peer grant` names them: exactly one of the three. */
export interface PeerGrantRecipients {
  /** Local addresses: `<workspace>:architect:<name>` for one architect, `<workspace>:architect` for its front door. */
  addresses?: string[];
  /** `--workspace <name>`: every architect in that workspace. */
  workspace?: string;
  /** `--all`: everything on this Tower, architects and builders. */
  all?: boolean;
}

/** Body of `POST /api/peer/grants`. Refused unless `humanApproved` is `true`. */
export interface PeerGrantRequest extends PeerGrantRecipients {
  /** The peer, as a tower-ref (`devvm`). */
  tower: string;
  /** Default `deliver`. */
  mode?: PeerGrantModeName;
  humanApproved?: boolean;
}

/**
 * Body of `POST /api/peer/grants/revoke`. With none of the three recipient fields it removes
 * every grant for that Tower. Narrowing access needs no approval.
 */
export interface PeerRevokeRequest extends PeerGrantRecipients {
  tower: string;
}

/** One grant as the routes report it. */
export interface PeerGrantView {
  peerTowerId: string;
  /** The peer's current name, as this Tower last listed it; `null` if it has not been listed. */
  peerName: string | null;
  scope: PeerGrantScopeName;
  mode: PeerGrantModeName;
  /** The workspace's key; `null` exactly when the scope is `all`. */
  workspacePath: string | null;
  /** The name the workspace is addressed by now; `null` for `all`, or when it has none. */
  workspaceName: string | null;
  /** The architect's name; set exactly when the scope is `architect`. */
  architect: string | null;
  /** What it covers, for a person: `codev:architect:local`, `codev:architect`, `every architect in codev`, `everything`. */
  recipient: string;
  /** For a front-door grant, the architect the front door reaches now; otherwise `null`. */
  reaches: string | null;
  /** Why the grant matches nothing now (its workspace or architect is gone); `null` when it applies. */
  matchesNothing: string | null;
  createdAt: number;
  updatedAt: number;
}

/** `GET /api/peer/grants[?tower=<tower-ref>]`. */
export interface PeerGrantsResponse {
  remoteMessaging: 'on' | 'off';
  grants: PeerGrantView[];
}

/** A peer as a grant route resolved it. */
export interface PeerTowerNamed {
  towerId: string;
  name: string;
}

/** What one requested grant did. */
export interface PeerGrantChange {
  grant: PeerGrantView;
  /** `added`; `mode-changed` (it existed with the other mode); `unchanged` (it existed as asked). */
  change: 'added' | 'mode-changed' | 'unchanged';
}

/** The 200 response of `POST /api/peer/grants`. */
export interface PeerGrantResponse {
  tower: PeerTowerNamed;
  changes: PeerGrantChange[];
  remoteMessaging: 'on' | 'off';
}

/** The 200 response of `POST /api/peer/grants/revoke`. */
export interface PeerRevokeResponse {
  tower: PeerTowerNamed;
  removed: PeerGrantView[];
}

/** The limits this Tower enforces itself, from the user's Codev config (`peer.limits`). */
export interface PeerTowerLimits {
  /** Remote messages accepted from one peer in a minute. */
  acceptedPerPeerPerMinute: number;
  /** Remote messages from one peer accepted here and not yet delivered. */
  undeliveredPerPeer: number;
  /** Messages waiting on this Tower for one peer. */
  waitingPerPeer: number;
}

/** `GET /api/peer/limits`. */
export interface PeerLimitsResponse {
  tower: PeerTowerLimits;
  /** Days this Tower keeps its record of cross-Tower attempts: the configured value, raised to 30. */
  recordRetentionDays: number;
  /** Codev Cloud's own limits, as its last peer list gave them; `null` if this Tower has never listed its peers. */
  cloud: { limits: PeerCloudLimits; listedAt: number } | null;
}

/**
 * Why `GET /api/peer/towers` answered from this Tower's cached list rather than a fresh one:
 * - `not-connected`: no registration with Codev Cloud (`afx tower connect`);
 * - `not-registered`: the registration was removed from Codev Cloud (`afx tower connect --reauth`);
 * - `no-relay`: the cloud has no relay, so it was not asked;
 * - `cloud-unreachable`: no answer, or an answer that was not the cloud's;
 * - `unauthenticated`: the cloud refused this Tower's key;
 * - `rate-limited`: the cloud is limiting this Tower's calls (`retryAfterSec` with it);
 * - `bad-listing`: the cloud's list did not fit the contract, and was not used;
 * - `registration-changed`: this Tower registered again while the list was being fetched, so the
 *   answer was the previous registration's, and was not used;
 * - `recent`: the list was fetched moments ago, within the call budget (contract section 3).
 */
export type PeerListProblem =
  | 'registration-changed'
  | 'not-connected'
  | 'not-registered'
  | 'no-relay'
  | 'cloud-unreachable'
  | 'unauthenticated'
  | 'rate-limited'
  | 'bad-listing'
  | 'recent';

/**
 * Whether Codev Cloud has a relay, as this Tower knows it: `available`; `none`, with why;
 * or `unknown` when the cloud has never said either way.
 */
export interface PeerCloudRelay {
  state: 'available' | 'none' | 'unknown';
  /**
   * With `none`: `insecure` (the server URL is plain HTTP and not loopback), `stated-none`
   * (the cloud said it has none), `old-cloud` (it predates the relay), `unsupported` (its
   * relay speaks no version this Tower speaks), `malformed` (its handshake's relay did not fit).
   */
  why: 'insecure' | 'stated-none' | 'old-cloud' | 'unsupported' | 'malformed' | null;
}

/** One of my other Towers, as `GET /api/peer/towers` lists it. */
export interface PeerListedTowerView {
  towerId: string;
  /** Its current name. */
  name: string;
  /** A live session at Codev Cloud when it was listed: a hint, never a promise. */
  online: boolean;
  /** The protocol versions its session stated. */
  protocols: number[];
  /** Its own switch, as the cloud last heard it. */
  remoteMessaging: PeerListedSwitchState;
  /** What it may message on this Tower: its grants here. Empty when nothing. */
  mayMessage: PeerGrantView[];
}

/** One address a peer answered a discovery query with, as this Tower writes it: `afx://<tower>/<address>`. */
export interface PeerShownAddress {
  address: string;
  /** Whether the agent has a live terminal there. */
  live: boolean;
}

/**
 * `GET /api/peer/show?tower=<tower-ref>` (Spec 1967, Decision 6): what runs on one of my other
 * Towers that this Tower may message, as that Tower answered. Only an answer is a 200; every
 * other outcome, an offline peer included, is a refusal (`REMOTE_REFUSED`), and nothing is held.
 */
export interface PeerShowResponse {
  tower: PeerTowerNamed;
  /** In the order the peer gave them. */
  addresses: PeerShownAddress[];
  /** The peer trimmed its list to fit the answer cap: some addresses are not shown. */
  truncated: boolean;
}

/** `GET /api/peer/towers`: my other Towers, fetched from Codev Cloud within the call budget, else cached. */
export interface PeerTowersResponse {
  remoteMessaging: 'on' | 'off';
  /** This Tower's own name; `null` if it has never been registered. */
  towerName: string | null;
  /** This Tower's own tunnel. While it is down this Tower can send but not receive. */
  tunnel: 'up' | 'down';
  relay: PeerCloudRelay;
  /** Whether the towers below were fetched now, and if not, why. */
  listing: {
    fresh: boolean;
    /** When the list below was fetched; `null` if this Tower has never listed its peers. */
    refreshedAt: number | null;
    problem: PeerListProblem | null;
    retryAfterSec: number | null;
  };
  towers: PeerListedTowerView[];
}

// --- Tunnel (GET /api/tunnel/status) ---

export interface TunnelStatus {
  /** False for a deregistered registration, whose credentials stay on disk (Issue #1871). */
  registered: boolean;
  state: 'disconnected' | 'connecting' | 'connected' | 'auth_failed' | 'deregistered' | 'error';
  uptime: number | null;
  towerId: string | null;
  /** The cloud's slug: the routing identity in `/t/<slug>/` (Issue #1871). */
  towerName: string | null;
  /** The cloud's display name, when known (Issue #1871). */
  displayName?: string | null;
  serverUrl: string | null;
  accessUrl: string | null;
  /** When the cloud rejected the key after it had connected (Issue #1871). */
  deregisteredAt?: string;
}

// --- Tower version (GET /api/version) ---

/**
 * Response of `GET /api/version` — the version of the *currently running*
 * Tower process, read from its in-memory `package.json` at boot (#983).
 *
 * Distinct from the installed CLI version (`codev --version`, which inspects
 * the on-disk binary): after an `npm install -g` upgrade without a Tower
 * restart, the two diverge. The VS Code preflight probes this endpoint to
 * detect that divergence and prompt a restart.
 */
export interface TowerVersionInfo {
  /** Semver of the in-memory Tower process. */
  version: string;
  /** ISO-8601 timestamp of when this Tower process started. */
  startedAt: string;
}

// --- Analytics (GET /api/analytics) ---

export interface ProtocolStats {
  count: number;
  avgWallClockHours: number | null;
  avgAgentTimeHours: number | null;
}

/**
 * Why a mailbox row is held, as every surface reports it (Spec 1313):
 * - `busy`, `no-profile`, `no-live-pty`: the render gate's verdict (see `HeldMessage.reason`);
 * - `held-for-release` (Spec 1967): mail from another Tower that a hold-for-release grant
 *   admitted, or whose grant or switch no longer allowed delivery. Nothing delivers it until a
 *   human releases it with `afx inbox release`.
 */
export type HeldMailReason = 'busy' | 'no-profile' | 'no-live-pty' | 'held-for-release';

/**
 * Issue 1450: one currently-*held* mailbox row as `GET /api/inbox` projects it —
 * the payload behind `afx inbox` and the dashboard's held-mail popover.
 *
 * **Metadata only, never the body** (Spec 1313 redaction rule). The message body
 * travels only over the live terminal stream on delivery, or through the separate
 * single-row `GET /api/inbox/:id` that backs `afx inbox show <id>`. Nothing that
 * consumes this type can leak a body, because no body is here to leak.
 *
 * **Held vs scheduled — these rows do NOT all count toward `OverviewData.heldCount`.**
 * The list comes from `listHeld`, which returns every `status = 'held'` row. The count
 * comes from `heldSummaryForWorkspace`, which additionally requires
 * `not_before IS NULL OR not_before <= now` — a pre-due `--delay` send is "scheduled,
 * not stuck" and deliberately does not inflate the attention count. So
 * `heldCount <= inbox.length`, always, by design. A UI showing both must group them
 * (`afx inbox` labels pre-due rows `scheduled`) rather than pretend the numbers match.
 */
export interface HeldMessage {
  /** Mailbox row id — the handle `afx inbox show|dismiss <id>` takes. */
  id: string;
  /** Normalized (realpath) workspace root the row was enqueued under. */
  workspacePath: string;
  /** Recipient agent (builder roleId or architect name). */
  toAgent: string;
  /** Sending agent; `null` for rows with no recorded sender (rendered as `?`). */
  fromAgent: string | null;
  /**
   * Why it is held: the render gate's `'busy' | 'no-profile' | 'no-live-pty'`, or
   * `'held-for-release'` for remote mail held for a human's release (Spec 1967); `null` if unset.
   */
  reason: HeldMailReason | null;
  /**
   * The gate's detail behind a `busy` reason (Issue #1482):
   * `'user-text'` — a draft or menu occupies the composer; a human is at the line and the hold
   * clears by itself. `'recent-input'` (Issue #1473) — the composer is EMPTY but input landed
   * within the input-settle window (a keystroke, a click, or an ungated `--interrupt`/
   * `--escape` write); also self-clearing, and distinct from `user-text` in that no draft
   * exists to be corrupted. `'composer-redraw'` (Issue #1664) — the composer is EMPTY but its
   * rendered region moved within the settle window (a turn-end redraw, a rotating placeholder,
   * a resize); also self-clearing, and NOT raised for the recipient merely producing output
   * elsewhere on the screen, which is safe to write onto. `'no-region-end'` /
   * `'no-composer-marker'` — the classifier could not verify the composer at all (a drifted
   * profile, a torn frame, or Tower's dimensions diverging from the real PTY); this hold does
   * NOT clear on its own.
   * `null` for a non-gate hold (`no-live-pty`, `no-profile`) and once delivered.
   */
  detail: string | null;
  /** True once the row has crossed the escalation age. A pre-due row never escalates. */
  escalated: boolean;
  /** Enqueue time, epoch ms — the basis for the displayed age. */
  createdAt: number;
  /**
   * Due time of a pre-due delayed (`--delay`) send, epoch ms; `null` = deliver ASAP.
   * `notBefore > now` marks the row SCHEDULED: excluded from `heldCount`, rendered
   * with a countdown rather than an age.
   */
  notBefore: number | null;
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
