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
  } catch {
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
  } catch {
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
  } catch {
    return null;
  }
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
const BARE_TYPE_LABELS = new Set(['bug', 'project']);

/** Title keywords that suggest a bug report. */
const BUG_TITLE_PATTERNS = /\b(fix|bug|broken|error|crash|fail|wrong|issue|regression|not working)\b/i;

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
