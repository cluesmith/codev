/**
 * Shared GitHub utilities for Codev.
 *
 * Provides non-fatal GitHub API access via the `gh` CLI.
 * All functions return `null` on failure instead of throwing,
 * enabling graceful degradation when GitHub is unavailable.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// =============================================================================
// Types
// =============================================================================

export interface GitHubIssue {
  title: string;
  body: string;
  state: string;
  comments: Array<{
    body: string;
    createdAt: string;
    author: { login: string };
  }>;
}

export interface GitHubPR {
  number: number;
  title: string;
  url: string;
  reviewDecision: string;
  body: string;
  createdAt: string;
  mergedAt?: string;
}

export interface GitHubIssueListItem {
  number: number;
  title: string;
  url: string;
  labels: Array<{ name: string }>;
  createdAt: string;
  closedAt?: string;
}

// =============================================================================
// Core GitHub API functions (non-fatal)
// =============================================================================

/**
 * Fetch a single GitHub issue by number.
 * Returns null if gh CLI fails (not authenticated, network down, etc.).
 */
export async function fetchGitHubIssue(issueNumber: number): Promise<GitHubIssue | null> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'view', String(issueNumber),
      '--json', 'title,body,state,comments',
    ]);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Fetch a single GitHub issue by number.
 * Throws on failure (for use in spawn where failure is fatal).
 */
export async function fetchGitHubIssueOrThrow(issueNumber: number): Promise<GitHubIssue> {
  const issue = await fetchGitHubIssue(issueNumber);
  if (!issue) {
    throw new Error(`Failed to fetch issue #${issueNumber}. Ensure 'gh' CLI is installed and authenticated.`);
  }
  return issue;
}

/**
 * Fetch open PRs for the current repo.
 * Returns null on failure.
 * @param cwd - Working directory for `gh` CLI (determines which repo is queried).
 */
export async function fetchPRList(cwd?: string): Promise<GitHubPR[] | null> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'list',
      '--json', 'number,title,url,reviewDecision,body,createdAt',
    ], { cwd });
    return JSON.parse(stdout);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[github] fetchPRList failed (cwd=${cwd ?? 'none'}): ${msg}`);
    return null;
  }
}

/**
 * Fetch open issues for the current repo.
 * Returns null on failure.
 * @param cwd - Working directory for `gh` CLI (determines which repo is queried).
 */
export async function fetchIssueList(cwd?: string): Promise<GitHubIssueListItem[] | null> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'list',
      '--json', 'number,title,url,labels,createdAt',
      '--limit', '200',
    ], { cwd });
    return JSON.parse(stdout);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[github] fetchIssueList failed (cwd=${cwd ?? 'none'}): ${msg}`);
    return null;
  }
}

/**
 * Fetch recently closed issues (last 24 hours).
 * Returns null on failure.
 * @param cwd - Working directory for `gh` CLI (determines which repo is queried).
 */
export async function fetchRecentlyClosed(cwd?: string): Promise<GitHubIssueListItem[] | null> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'issue', 'list',
      '--state', 'closed',
      '--json', 'number,title,url,labels,createdAt,closedAt',
      '--limit', '50',
    ], { cwd });
    const issues: GitHubIssueListItem[] = JSON.parse(stdout);
    // Filter to last 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return issues.filter(i => i.closedAt && new Date(i.closedAt).getTime() >= cutoff);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[github] fetchRecentlyClosed failed (cwd=${cwd ?? 'none'}): ${msg}`);
    return null;
  }
}

/**
 * Fetch recently merged PRs (last 24 hours).
 * Returns null on failure.
 * @param cwd - Working directory for `gh` CLI (determines which repo is queried).
 */
export async function fetchRecentMergedPRs(cwd?: string): Promise<GitHubPR[] | null> {
  try {
    const { stdout } = await execFileAsync('gh', [
      'pr', 'list',
      '--state', 'merged',
      '--json', 'number,title,url,body,createdAt,mergedAt',
      '--limit', '50',
    ], { cwd });
    const prs: GitHubPR[] = JSON.parse(stdout);
    // Filter to last 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return prs.filter(pr => pr.mergedAt && new Date(pr.mergedAt).getTime() >= cutoff);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[github] fetchMergedPRs failed (cwd=${cwd ?? 'none'}): ${msg}`);
    return null;
  }
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
 * Uses `gh pr list --state merged --search "merged:>=DATE"` which provides `mergedAt`.
 * Returns null on failure.
 */
export async function fetchMergedPRs(since: string | null, cwd?: string): Promise<MergedPR[] | null> {
  try {
    const args = [
      'pr', 'list',
      '--state', 'merged',
      '--json', 'number,title,createdAt,mergedAt,body,headRefName',
      '--limit', '1000',
    ];
    if (since) {
      args.push('--search', `merged:>=${since}`);
    }
    const { stdout } = await execFileAsync('gh', args, { cwd });
    return JSON.parse(stdout);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[github] fetchMergedPRs failed (cwd=${cwd ?? 'none'}): ${msg}`);
    return null;
  }
}

/**
 * Fetch closed issues, optionally filtered to those closed since a given date.
 * Uses `gh issue list --state closed --search "closed:>=DATE"` which provides `closedAt`.
 * Returns null on failure.
 */
export async function fetchClosedIssues(since: string | null, cwd?: string): Promise<ClosedIssue[] | null> {
  try {
    const args = [
      'issue', 'list',
      '--state', 'closed',
      '--json', 'number,title,createdAt,closedAt,labels',
      '--limit', '1000',
    ];
    if (since) {
      args.push('--search', `closed:>=${since}`);
    }
    const { stdout } = await execFileAsync('gh', args, { cwd });
    return JSON.parse(stdout);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[github] fetchClosedIssues failed (cwd=${cwd ?? 'none'}): ${msg}`);
    return null;
  }
}

/**
 * Fetch the "On it!" comment timestamp for multiple issues using GraphQL.
 *
 * Uses a batched GraphQL query via `gh api graphql` to fetch comments for
 * many issues in a single API call. Finds the first comment containing
 * "On it!" (posted by `af spawn`). Returns a map of issue number → ISO timestamp.
 * Issues without an "On it!" comment are omitted from the result.
 *
 * Batches in groups of 50 to stay within GraphQL complexity limits.
 * For 100 issues, this makes 2 API calls instead of 100.
 */
export async function fetchOnItTimestamps(
  issueNumbers: number[],
  cwd?: string,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (issueNumbers.length === 0) return result;

  const unique = [...new Set(issueNumbers)];

  // Get repo owner/name for GraphQL query
  let owner: string;
  let repoName: string;
  try {
    const { stdout } = await execFileAsync('gh', [
      'repo', 'view', '--json', 'owner,name',
    ], { cwd });
    const repo = JSON.parse(stdout);
    owner = repo.owner.login;
    repoName = repo.name;
  } catch {
    return result; // Can't determine repo, skip gracefully
  }

  const BATCH_SIZE = 50;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);

    // Build aliased GraphQL query — one field per issue
    const issueFragments = batch.map((num) =>
      `issue${num}: issue(number: ${num}) { comments(first: 50) { nodes { body createdAt } } }`,
    ).join('\n    ');

    const query = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${issueFragments}
  }
}`;

    try {
      const { stdout } = await execFileAsync('gh', [
        'api', 'graphql',
        '-f', `query=${query}`,
        '-f', `owner=${owner}`,
        '-f', `name=${repoName}`,
      ], { cwd });

      const data = JSON.parse(stdout);
      const repoData = data.data?.repository;
      if (!repoData) continue;

      for (const num of batch) {
        const issueData = repoData[`issue${num}`];
        if (!issueData?.comments?.nodes) continue;

        const onItComment = (issueData.comments.nodes as Array<{ body: string; createdAt: string }>)
          .find((c) => c.body.includes('On it!'));
        if (onItComment) {
          result.set(num, onItComment.createdAt);
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
export function parseLinkedIssue(prBody: string, prTitle: string): number | null {
  // Check PR body for GitHub closing keywords
  const closingKeywordPattern = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/i;
  const bodyMatch = prBody.match(closingKeywordPattern);
  if (bodyMatch) {
    return parseInt(bodyMatch[1], 10);
  }

  // Check PR title for [Spec N] or [Bugfix #N] patterns
  const specPattern = /\[Spec\s+#?(\d+)\]/i;
  const bugfixPattern = /\[Bugfix\s+#?(\d+)\]/i;

  const titleSpecMatch = prTitle.match(specPattern);
  if (titleSpecMatch) {
    return parseInt(titleSpecMatch[1], 10);
  }

  const titleBugfixMatch = prTitle.match(bugfixPattern);
  if (titleBugfixMatch) {
    return parseInt(titleBugfixMatch[1], 10);
  }

  // Also check body for same patterns
  const bodySpecMatch = prBody.match(specPattern);
  if (bodySpecMatch) {
    return parseInt(bodySpecMatch[1], 10);
  }

  const bodyBugfixMatch = prBody.match(bugfixPattern);
  if (bodyBugfixMatch) {
    return parseInt(bodyBugfixMatch[1], 10);
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
export function parseAllLinkedIssues(prBody: string, prTitle: string): number[] {
  const issues = new Set<number>();
  const combined = `${prTitle}\n${prBody}`;

  // GitHub closing keywords (global)
  const closingPattern = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi;
  for (const m of combined.matchAll(closingPattern)) {
    issues.add(parseInt(m[1], 10));
  }

  // [Spec N] or [Bugfix #N] patterns (global)
  const specPattern = /\[Spec\s+#?(\d+)\]/gi;
  for (const m of combined.matchAll(specPattern)) {
    issues.add(parseInt(m[1], 10));
  }

  const bugfixPattern = /\[Bugfix\s+#?(\d+)\]/gi;
  for (const m of combined.matchAll(bugfixPattern)) {
    issues.add(parseInt(m[1], 10));
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
