/**
 * TypeScript interfaces for forge concept command JSON output contracts.
 *
 * Default `gh`-based commands produce output conforming to these interfaces.
 * Custom commands for other forges should match these shapes where possible.
 *
 * **Provider presets (gitlab, gitea) are best-effort.** Their CLI tools may
 * output different schemas than GitHub's. Consumers that parse concept output
 * must handle `null` returns gracefully — a non-conforming response from a
 * preset command is treated the same as a command failure.
 *
 * @see codev/specs/589-non-github-repository-support.md
 */

// =============================================================================
// Issue concepts
// =============================================================================

/** Output of the `issue-view` concept command. */
export interface IssueViewResult {
  title: string;
  body: string;
  state: string;
  /**
   * The issue's **browser/web** URL (NOT an API endpoint), when the concept
   * supplies it. Each forge script maps its own web-URL field here: GitHub
   * `url`, GitLab `web_url`, Gitea `html_url` (Gitea's `url` is the API
   * endpoint — do not use it), Linear `url`, Jira `<site>/browse/<key>` (never
   * the REST `self` link, which names an infrastructure host). Optional to keep the contract
   * forge-neutral (a forge script that doesn't emit it degrades gracefully).
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

/** Single item in `issue-list` concept output. */
export interface IssueListItem {
  number: number | string;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  /**
   * ISO 8601 creation time. Optional: Jira's search (#1740) cannot return dates,
   * so its list items omit it; consumers render no age and sort it last.
   */
  createdAt?: string;
  closedAt?: string;
  author?: { login: string };
  assignees?: Array<{ login: string }>;
  /**
   * Issue body. Populated by the `issue-search` concept (the backlog-search
   * path); the `issue-list` concept omits it so the always-on `/api/overview`
   * payload stays lean. Non-GitHub forges may not populate it — consumers
   * degrade to title-only matching when it's absent.
   */
  body?: string;
}

/** Output of the `issue-list` concept command. */
export type IssueListResult = IssueListItem[];

/** Output of the `recently-closed` concept command. */
export type RecentlyClosedResult = IssueListItem[];

/** Output of the `issue-comment` concept command: exit code only, no JSON. */
// No interface needed — success is determined by exit code 0.

// =============================================================================
// PR concepts
// =============================================================================

/** Single item in `pr-list` concept output. */
export interface PrListItem {
  number: number;
  title: string;
  url: string;
  reviewDecision: string;
  body: string;
  createdAt: string;
  mergedAt?: string;
  author?: { login: string };
  /**
   * Logins of users requested as reviewers. Every preset populates it for real:
   * GitHub flattens gh's reviewer objects to logins, GitLab maps glab's
   * `.reviewers[].username`, and Gitea maps the REST `requested_reviewers[]`
   * (team reviewers carry no login and are dropped). Consumed by the VSCode PR
   * sidebar to bucket "review-requested" PRs.
   */
  reviewRequests: string[];
  /**
   * Whether the PR is a draft. Every preset reports it for real — GitLab from
   * the merge request's `draft`/WIP flag, Gitea from the REST `draft` flag.
   */
  isDraft: boolean;
}

/** Output of the `pr-list` concept command. */
export type PrListResult = PrListItem[];

/** Output of the `pr-exists` concept command: JSON boolean on stdout. */
// Returns `true` or `false` as JSON.

/** Single item in `recently-merged` concept output. */
export interface MergedPrItem {
  number: number;
  title: string;
  url?: string;
  body: string;
  createdAt: string;
  mergedAt: string;
  headRefName: string;
}

/** Output of the `recently-merged` concept command. */
export type RecentlyMergedResult = MergedPrItem[];

/** Single item in `pr-search` concept output. */
export interface PrSearchItem {
  number: number;
  headRefName: string;
  /**
   * PR/MR state, normalized to the GitHub convention: `OPEN` | `MERGED` |
   * `CLOSED`. Because `pr-search` runs `--state all` (#759), consumers that
   * only want open PRs must filter on this — the spawn collision guard ignores
   * non-open results (#1637). Optional: a stale project-local override of
   * `pr-search.sh` may predate this field (and the gitlab script leaves it
   * blank when glab omits it), so consumers treat an absent or empty value as
   * "unknown" rather than assuming a state.
   */
  state?: string;
}

/** Output of the `pr-search` concept command. */
export type PrSearchResult = PrSearchItem[];

/** Output of the `pr-view` concept command. */
export interface PrViewResult {
  title: string;
  body: string;
  state: string;
  /**
   * The PR's **browser/web** URL (NOT an API endpoint), when the concept
   * supplies it. Each forge script maps its own web-URL field here: GitHub
   * `url`, GitLab `web_url`, Gitea `html_url` (Gitea's `url` is the API
   * endpoint — do not use it). Optional to keep the contract forge-neutral
   * (a forge script that doesn't emit it degrades gracefully) — same shape
   * as `IssueViewResult.url`.
   */
  url?: string;
  author: { login: string };
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
  /*
   * The fields below are optional and additive (Spec 1951, consumed by `codev check`).
   * A preset that cannot supply one omits it; the consumer then reports the dependent
   * check as "not run", never as passing.
   */
  /** Full SHA of the PR's head commit as the forge sees it: GitHub `headRefOid`, GitLab `sha`, Gitea `head.sha`. */
  headRefOid?: string;
  /** Whether the PR is a draft. */
  isDraft?: boolean;
  /** The forge's own mergeability, normalized to GitHub's three words. */
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  /**
   * The forge's merge-state word in GitHub's vocabulary, where `CLEAN` is the clean state.
   * Other presets map their clean state to `CLEAN` and pass any other state through
   * upper-cased.
   */
  mergeStateStatus?: string;
  /** The commit the merge produced (merge, squash or rebase tip); null while unmerged. */
  mergeCommit?: { oid: string } | null;
  /** ISO 8601 merge time; null while unmerged. */
  mergedAt?: string | null;
  /**
   * The review state in GitHub's words (`APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`),
   * which explains a `BLOCKED` merge state. Explicitly `null` from presets whose forge has
   * no equivalent (gitlab, gitea).
   */
  reviewDecision?: string | null;
}

// =============================================================================
// Overview concepts (Spec 1647)
// =============================================================================

/**
 * Output of the `overview-bundle` concept command: the four forge-backed sections of
 * Tower's overview from one invocation, in place of `pr-list`, `issue-list`,
 * `recently-closed` and `recently-merged`.
 *
 * **Input.** `CODEV_SINCE_DATE`, always set by the caller: the start of the two 24 h
 * windows, an ISO-8601 UTC timestamp at seconds precision (`YYYY-MM-DDTHH:MM:SSZ`), as
 * the two search concepts receive it. The GitHub script exits non-zero, before sending
 * any request, on a missing or malformed value.
 *
 * **Output on exit 0.** One JSON object with these four required keys. Each holds what
 * the corresponding concept emits for the same repository state, under that concept's
 * contract, or `null`, which means that section alone could not be fetched. Items are
 * held to those contracts, not to any one CLI's full output: the GitHub script emits only
 * the contract fields, so its items are narrower than `gh --json`'s (no `is_bot`, no label
 * `color`). Extra top-level keys are ignored, as extra item fields are.
 *
 * **Non-zero exit.** The whole bundle failed. stderr carries the reason; the rate
 * limiter reads it.
 *
 * **Malformed output** is a whole-bundle failure: not JSON, not an object, a required
 * key missing, or a section that is neither an array nor `null`.
 */
export interface OverviewBundleResult {
  /** As `pr-list`: open PRs, newest first, up to 30. */
  prs: PrListResult | null;
  /** As `issue-list`: open issues, newest first, up to 200. */
  issues: IssueListResult | null;
  /** As `recently-closed`: issues closed after `CODEV_SINCE_DATE`, up to 1,000. */
  recentlyClosed: RecentlyClosedResult | null;
  /** As `recently-merged`: PRs merged after `CODEV_SINCE_DATE`, up to 1,000. */
  recentlyMerged: RecentlyMergedResult | null;
}

// =============================================================================
// Commit and workflow concepts (Spec 1951)
// =============================================================================

/** A check result's state, normalized across forges. Skipped and neutral count as passed. */
export type CommitCheckState = 'pass' | 'fail' | 'pending' | 'skipped' | 'neutral';

/**
 * Single item in `commit-checks` concept output: one check run or commit status
 * reported for the commit named by `CODEV_COMMIT_SHA`.
 */
export interface CommitCheckItem {
  name: string;
  state: CommitCheckState;
  /** Browser URL of the run's details, when the forge supplies one. */
  url?: string;
  /** Workflow the run belongs to, when the forge supplies it cheaply. */
  workflow?: string;
}

/** Output of the `commit-checks` concept command. Empty when nothing reported on the commit. */
export type CommitChecksResult = CommitCheckItem[];

/**
 * Single item in `workflow-runs` concept output: one run of the workflow named by
 * `CODEV_WORKFLOW` on the branch named by `CODEV_BRANCH`.
 */
export interface WorkflowRunItem {
  /** Full SHA the run was for. */
  headSha: string;
  /** `completed` once finished; anything else means still running or queued. */
  status: string;
  /** For a completed run, `success` means green. Empty or null while running. */
  conclusion: string | null;
  url: string;
  /** ISO 8601. */
  createdAt: string;
}

/** Output of the `workflow-runs` concept command, newest first. */
export type WorkflowRunsResult = WorkflowRunItem[];

/**
 * Output of the `pr-create` concept command.
 *
 * Inputs are environment variables, like every other concept:
 * `CODEV_PR_TITLE` (required), `CODEV_PR_BODY` (required — set it to `''` for
 * an empty body; an *absent* one is rejected rather than silently posting a
 * bodyless PR), and the optional `CODEV_PR_BASE`, `CODEV_PR_HEAD`,
 * `CODEV_PR_REPO`, `CODEV_PR_DRAFT`. The gitea script also reads the optional
 * `CODEV_PR_LOGIN` (tea's `--login`, for multi-login hosts). A failed creation
 * exits non-zero rather than emitting JSON.
 */
export interface PrCreateResult {
  /** The created PR's number (`iid` on GitLab, `index` on Gitea). */
  number: number;
  /** The created PR's **browser/web** URL — never an API endpoint. */
  url: string;
}

/** Output of the `pr-diff` concept command: raw diff text, not JSON. */
// Returns diff text on stdout. Use `raw: true` option.

/** Output of the `pr-merge` concept command: exit code only, no JSON. */
// No interface needed — success is determined by exit code 0.

// =============================================================================
// Identity & team concepts
// =============================================================================

/** Output of the `user-identity` concept command: plain string (username). */
// Returns username string on stdout. Not JSON.

/** Output of the `team-activity` concept command: raw GraphQL response. */
// Returns the raw GraphQL JSON response. Codev handles parsing via
// parseTeamGraphQLResponse in team-github.ts.

/** Output of the `on-it-timestamps` concept command: raw GraphQL response. */
// Returns the raw GraphQL JSON response. Codev handles parsing to extract
// "On it!" comment timestamps per issue.

// =============================================================================
// Auth concepts
// =============================================================================

/** Output of the `auth-status` concept command: exit code only. */
// Exit code 0 = authenticated, non-zero = not authenticated.
