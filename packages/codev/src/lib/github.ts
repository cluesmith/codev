/**
 * Shared forge utilities for Codev.
 *
 * Provides non-fatal forge API access via configurable concept commands.
 * Default commands wrap the `gh` CLI. Projects can override via af-config.json.
 * All functions return `null` on failure instead of throwing,
 * enabling graceful degradation when forge is unavailable.
 *
 * @see codev/specs/589-non-github-repository-support.md
 */

import { executeForgeCommand, type ForgeConfig } from './forge.js';
import { getRepoInfo } from './team-github.js';
import type { IssueViewResult, PrListItem, IssueListItem } from './forge-contracts.js';

// =============================================================================
// Types — re-export forge-contracts types under generic names
// =============================================================================

/** A single issue as returned by the `issue-view` concept command. */
export type ForgeIssue = IssueViewResult;
/** A single PR/MR item as returned by the `pr-list` concept command. */
export type ForgePR = PrListItem;
/** A single issue item as returned by the `issue-list` concept command. */
export type ForgeIssueListItem = IssueListItem;

/** @deprecated Use ForgeIssue instead. */
export type GitHubIssue = ForgeIssue;
/** @deprecated Use ForgePR instead. */
export type GitHubPR = ForgePR;
/** @deprecated Use ForgeIssueListItem instead. */
export type GitHubIssueListItem = ForgeIssueListItem;

// =============================================================================
// Core forge API functions (non-fatal, via concept commands)
// =============================================================================

/**
 * Fetch a single issue by ID.
 * Routes through the `issue-view` concept command.
 * Returns null if the concept command fails.
 *
 * @param issueId - Issue identifier (number or string)
 * @param options - Optional forge config and cwd
 */
export async function fetchIssue(
  issueId: string | number,
  options?: { cwd?: string; forgeConfig?: ForgeConfig | null },
): Promise<ForgeIssue | null> {
  const result = await executeForgeCommand('issue-view', {
    CODEV_ISSUE_ID: String(issueId),
  }, {
    cwd: options?.cwd,
    forgeConfig: options?.forgeConfig,
  });
  return result as ForgeIssue | null;
}

/**
 * Fetch a single issue by ID.
 * Throws on failure (for use in spawn where failure is fatal).
 *
 * @param issueId - Issue identifier (number or string)
 * @param options - Optional forge config and cwd
 */
export async function fetchIssueOrThrow(
  issueId: string | number,
  options?: { cwd?: string; forgeConfig?: ForgeConfig | null },
): Promise<ForgeIssue> {
  const issue = await fetchIssue(issueId, options);
  if (!issue) {
    throw new Error(
      `Failed to fetch issue #${issueId}. Ensure the 'issue-view' forge concept command is configured ` +
      `(default: 'gh' CLI must be installed and authenticated). ` +
      `Configure forge commands in af-config.json if using a non-GitHub forge.`,
    );
  }
  return issue;
}

/** @deprecated Use fetchIssue instead. */
export const fetchGitHubIssue = fetchIssue;
/** @deprecated Use fetchIssueOrThrow instead. */
export const fetchGitHubIssueOrThrow = fetchIssueOrThrow;

/**
 * Fetch open PRs for the current repo.
 * Routes through the `pr-list` concept command.
 * Returns null on failure.
 */
export async function fetchPRList(
  cwd?: string,
  forgeConfig?: ForgeConfig | null,
): Promise<ForgePR[] | null> {
  const result = await executeForgeCommand('pr-list', {}, {
    cwd,
    forgeConfig,
  });
  return result as ForgePR[] | null;
}

/**
 * Fetch open issues for the current repo.
 * Routes through the `issue-list` concept command.
 * Returns null on failure.
 */
export async function fetchIssueList(
  cwd?: string,
  forgeConfig?: ForgeConfig | null,
): Promise<ForgeIssueListItem[] | null> {
  const result = await executeForgeCommand('issue-list', {}, {
    cwd,
    forgeConfig,
  });
  return result as ForgeIssueListItem[] | null;
}

/**
 * Fetch recently closed issues (last 24 hours).
 * Routes through the `recently-closed` concept command.
 * Returns null on failure.
 */
export async function fetchRecentlyClosed(
  cwd?: string,
  forgeConfig?: ForgeConfig | null,
): Promise<ForgeIssueListItem[] | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const result = await executeForgeCommand('recently-closed', {
    CODEV_SINCE_DATE: since,
  }, {
    cwd,
    forgeConfig,
  });
  if (!result || !Array.isArray(result)) return result as ForgeIssueListItem[] | null;

  // Filter to last 24 hours (concept command may return more)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (result as ForgeIssueListItem[]).filter(
    i => i.closedAt && new Date(i.closedAt).getTime() >= cutoff,
  );
}

/**
 * Fetch recently merged PRs (last 24 hours).
 * Routes through the `recently-merged` concept command.
 * Returns null on failure.
 */
export async function fetchRecentMergedPRs(
  cwd?: string,
  forgeConfig?: ForgeConfig | null,
): Promise<ForgePR[] | null> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const result = await executeForgeCommand('recently-merged', {
    CODEV_SINCE_DATE: since,
  }, {
    cwd,
    forgeConfig,
  });
  if (!result || !Array.isArray(result)) return result as ForgePR[] | null;

  // Filter to last 24 hours (concept command may return more)
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return (result as ForgePR[]).filter(
    pr => pr.mergedAt && new Date(pr.mergedAt).getTime() >= cutoff,
  );
}

// =============================================================================
// Historical data queries (for statistics)
// =============================================================================

export interface MergedPR {
  number: number;
  title: string;
  createdAt: string;
  mergedAt: string;
  body: string;
  headRefName: string;
}

export interface ClosedIssue {
  number: number;
  title: string;
  createdAt: string;
  closedAt: string;
  labels: Array<{ name: string }>;
}

/**
 * Fetch merged PRs, optionally filtered to those merged since a given date.
 * Routes through the `recently-merged` concept command.
 * Returns null on failure.
 */
export async function fetchMergedPRs(
  since: string | null,
  cwd?: string,
  forgeConfig?: ForgeConfig | null,
): Promise<MergedPR[] | null> {
  const env: Record<string, string> = {};
  if (since) {
    env.CODEV_SINCE_DATE = since;
  }
  const result = await executeForgeCommand('recently-merged', env, {
    cwd,
    forgeConfig,
  });
  return result as MergedPR[] | null;
}

/**
 * Fetch closed issues, optionally filtered to those closed since a given date.
 * Routes through the `recently-closed` concept command.
 * Returns null on failure.
 */
export async function fetchClosedIssues(
  since: string | null,
  cwd?: string,
  forgeConfig?: ForgeConfig | null,
): Promise<ClosedIssue[] | null> {
  const env: Record<string, string> = {};
  if (since) {
    env.CODEV_SINCE_DATE = since;
  }
  const result = await executeForgeCommand('recently-closed', env, {
    cwd,
    forgeConfig,
  });
  return result as ClosedIssue[] | null;
}

/**
 * Fetch the "On it!" comment timestamp for multiple issues.
 *
 * Routes through the `on-it-timestamps` concept command. The default command
 * uses `gh api graphql` with a batched query. Non-GitHub forges can provide
 * a simpler command that accepts CODEV_ISSUE_NUMBERS (comma-separated) and
 * returns a JSON map of issue number → ISO timestamp.
 *
 * For the default GitHub implementation, this function builds the GraphQL
 * query internally and passes it via CODEV_GRAPHQL_QUERY. It also needs
 * repo owner/name which it fetches via a separate gh call.
 *
 * Batches in groups of 50 to stay within GraphQL complexity limits.
 * Returns empty map on failure (graceful degradation — analytics falls
 * back to PR createdAt for wall-clock time).
 */
export async function fetchOnItTimestamps(
  issueIds: string[],
  cwd?: string,
  forgeConfig?: ForgeConfig | null,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (issueIds.length === 0) return result;

  const unique = [...new Set(issueIds)];

  // Check if a custom (non-default) on-it-timestamps command is configured.
  // Custom commands receive CODEV_ISSUE_NUMBERS and return a simple JSON map.
  const customCmd = forgeConfig?.['on-it-timestamps'];
  if (customCmd !== undefined) {
    // Custom command or explicitly disabled (null)
    if (customCmd === null) return result;

    const cmdResult = await executeForgeCommand('on-it-timestamps', {
      CODEV_ISSUE_NUMBERS: unique.join(','),
    }, { cwd, forgeConfig });

    if (cmdResult && typeof cmdResult === 'object' && !Array.isArray(cmdResult)) {
      for (const [key, value] of Object.entries(cmdResult as Record<string, string>)) {
        const num = parseInt(key, 10);
        if (!isNaN(num) && typeof value === 'string') {
          result.set(num, value);
        }
      }
    }
    return result;
  }

  // Default path: build GraphQL query for gh api graphql
  // Get repo owner/name from git remote
  const repo = await getRepoInfo(cwd);
  if (!repo) {
    return result; // Can't determine repo, skip gracefully
  }
  const { owner, name: repoName } = repo;

  const BATCH_SIZE = 50;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);

    // Build aliased GraphQL query — one field per issue
    // GraphQL requires numeric issue numbers; skip non-numeric IDs (non-GitHub forges)
    const numericBatch = batch.filter(id => /^\d+$/.test(id));
    if (numericBatch.length === 0) continue;
    const issueFragments = numericBatch.map((id) =>
      `issue${id}: issue(number: ${id}) { comments(first: 50) { nodes { body createdAt } } }`,
    ).join('\n    ');

    const query = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${issueFragments}
  }
}`;

    try {
      const cmdResult = await executeForgeCommand('on-it-timestamps', {
        CODEV_ISSUE_NUMBERS: batch.join(','),
        CODEV_GRAPHQL_QUERY: query,
        CODEV_REPO_OWNER: owner,
        CODEV_REPO_NAME: repoName,
      }, { cwd, forgeConfig });

      // Default gh command returns GraphQL response structure
      const data = cmdResult as { data?: { repository?: Record<string, { comments?: { nodes?: Array<{ body: string; createdAt: string }> } }> } } | null;
      const repoData = data?.data?.repository;
      if (!repoData) continue;

      for (const id of numericBatch) {
        const issueData = repoData[`issue${id}`];
        if (!issueData?.comments?.nodes) continue;

        const onItComment = issueData.comments.nodes
          .find((c) => c.body.includes('On it!'));
        if (onItComment) {
          result.set(id, onItComment.createdAt);
        }
      }
    } catch {
      // Silently skip batch — fallback to PR createdAt will be used
    }
  }

  return result;
}

// =============================================================================
// Parsing utilities
// =============================================================================

/**
 * Parse a linked issue number from a PR body and title.
 *
 * Checks for:
 * - GitHub closing keywords: Fixes #N, Closes #N, Resolves #N
 * - Commit message conventions: [Spec N], [Bugfix #N]
 *
 * Returns the first matched issue number, or null if none found.
 */
export function parseLinkedIssue(prBody: string, prTitle: string): string | null {
  // Check PR body for GitHub closing keywords
  const closingKeywordPattern = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/i;
  const bodyMatch = prBody.match(closingKeywordPattern);
  if (bodyMatch) {
    return bodyMatch[1];
  }

  // Check PR title for [Spec N] or [Bugfix #N] patterns
  const specPattern = /\[Spec\s+#?(\d+)\]/i;
  const bugfixPattern = /\[Bugfix\s+#?(\d+)\]/i;

  const titleSpecMatch = prTitle.match(specPattern);
  if (titleSpecMatch) {
    return titleSpecMatch[1];
  }

  const titleBugfixMatch = prTitle.match(bugfixPattern);
  if (titleBugfixMatch) {
    return titleBugfixMatch[1];
  }

  // Also check body for same patterns
  const bodySpecMatch = prBody.match(specPattern);
  if (bodySpecMatch) {
    return bodySpecMatch[1];
  }

  const bodyBugfixMatch = prBody.match(bugfixPattern);
  if (bodyBugfixMatch) {
    return bodyBugfixMatch[1];
  }

  return null;
}

/**
 * Parse ALL linked issue numbers from a PR body and title.
 *
 * Unlike `parseLinkedIssue` (which returns the first match), this variant
 * uses global regex to extract every distinct issue number referenced via:
 * - GitHub closing keywords: Fixes #N, Closes #N, Resolves #N
 * - Commit message conventions: [Spec N], [Bugfix #N]
 *
 * Returns a deduplicated array of issue numbers (may be empty).
 */
export function parseAllLinkedIssues(prBody: string, prTitle: string): string[] {
  const issues = new Set<string>();
  const combined = `${prTitle}\n${prBody}`;

  // GitHub closing keywords (global)
  const closingPattern = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi;
  for (const m of combined.matchAll(closingPattern)) {
    issues.add(m[1]);
  }

  // [Spec N] or [Bugfix #N] patterns (global)
  const specPattern = /\[Spec\s+#?(\d+)\]/gi;
  for (const m of combined.matchAll(specPattern)) {
    issues.add(m[1]);
  }

  const bugfixPattern = /\[Bugfix\s+#?(\d+)\]/gi;
  for (const m of combined.matchAll(bugfixPattern)) {
    issues.add(m[1]);
  }

  return [...issues];
}

/**
 * Extract type and priority from GitHub issue labels.
 *
 * Type resolution order:
 * 1. Explicit `type:*` label (e.g. `type:bug`)
 * 2. Bare label matching known types (e.g. `bug`, `project`)
 * 3. Title-based heuristic — bug keywords → "bug", otherwise "project"
 *
 * Defaults:
 * - No priority:* label → "medium"
 * - Multiple labels of same kind → first alphabetical
 */
/** Labels that map directly to a type without the `type:` prefix. */
const BARE_TYPE_LABELS = new Set(['bug', 'project', 'spike']);

/** Title keywords that suggest a bug report. Trailing \b omitted to match plurals/verb forms. */
const BUG_TITLE_PATTERNS = /\b(fix|bug|broken|error|crash|fail|wrong|regression|not working)/i;

export function parseLabelDefaults(
  labels: Array<{ name: string }>,
  title?: string,
): {
  type: string;
  priority: string;
} {
  const names = labels.map(l => l.name);

  const typeLabels = names
    .filter(n => n.startsWith('type:'))
    .map(n => n.slice(5))
    .sort();

  // Fall back to bare label names (e.g. "bug", "project") if no type: prefix found
  if (typeLabels.length === 0) {
    const bare = names.filter(n => BARE_TYPE_LABELS.has(n)).sort();
    if (bare.length > 0) typeLabels.push(bare[0]);
  }

  // If still no type, infer from title keywords
  let type = typeLabels[0];
  if (!type) {
    type = title && BUG_TITLE_PATTERNS.test(title) ? 'bug' : 'project';
  }

  const priorityLabels = names
    .filter(n => n.startsWith('priority:'))
    .map(n => n.slice(9))
    .sort();

  return {
    type,
    priority: priorityLabels[0] || 'medium',
  };
}
