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
  comments: Array<{
    body: string;
    createdAt: string;
    author: { login: string };
  }>;
}

/** Single item in `issue-list` concept output. */
export interface IssueListItem {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  createdAt: string;
  closedAt?: string;
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
}

/** Output of the `pr-search` concept command. */
export type PrSearchResult = PrSearchItem[];

/** Output of the `pr-view` concept command. */
export interface PrViewResult {
  title: string;
  body: string;
  state: string;
  author: { login: string };
  baseRefName: string;
  headRefName: string;
  additions: number;
  deletions: number;
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

/** Output of the `gh-auth-status` concept command: exit code only. */
// Exit code 0 = authenticated, non-zero = not authenticated.
