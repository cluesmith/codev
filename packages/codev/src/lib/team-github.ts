/**
 * GitHub data enrichment for team members.
 *
 * Fetches assigned issues, open PRs, and recent activity for each
 * team member using a single batched GraphQL query via `gh api graphql`.
 *
 * Spec 587: Team Tab in Tower Right Panel.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isValidGitHubHandle } from './team.js';
import type { TeamMember } from './team.js';
import { executeForgeCommand, type ForgeConfig } from './forge.js';

const execFileAsync = promisify(execFile);

// =============================================================================
// Types
// =============================================================================

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

// Keep in sync with the canonical definition in @cluesmith/codev-types.
export interface TeamMemberGitHubData {
  assignedIssues: { number: number; title: string; url: string }[];
  openPRs: { number: number; title: string; url: string }[];
  recentActivity: {
    mergedPRs: { number: number; title: string; url: string; mergedAt: string }[];
    closedIssues: { number: number; title: string; url: string; closedAt: string }[];
  };
  reviewBlocking: ReviewBlockingEntry[];
}

// =============================================================================
// Repo Detection
// =============================================================================

export async function getRepoInfo(cwd?: string): Promise<{ owner: string; name: string } | null> {
  try {
    // Derive owner/name from git remote URL instead of calling gh directly
    const { stdout } = await execFileAsync('git', [
      'remote', 'get-url', 'origin',
    ], { cwd });
    const url = stdout.trim();
    // Match SSH (git@github.com:owner/repo.git) or HTTPS (https://github.com/owner/repo.git)
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) {
      return { owner: match[1], name: match[2] };
    }
    return null;
  } catch {
    return null;
  }
}

// =============================================================================
// GraphQL Query Building
// =============================================================================

function sevenDaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0]; // YYYY-MM-DD
}

/**
 * Sanitize a GitHub handle for use as a GraphQL alias.
 * Replaces hyphens with underscores and prefixes with `u_` to avoid
 * aliases starting with a digit (invalid in GraphQL).
 */
function toAlias(handle: string): string {
  return `u_${handle.replace(/-/g, '_')}`;
}

/**
 * Build a batched GraphQL query that fetches assigned issues, authored PRs,
 * and recent activity for all team members in one request.
 *
 * Owner/name are interpolated directly into search strings because
 * GraphQL variables are not substituted inside string literals.
 */
export function buildTeamGraphQLQuery(members: TeamMember[], owner: string, name: string): string {
  const since = sevenDaysAgo();
  const repo = `${owner}/${name}`;

  const fragments = members
    .filter(m => isValidGitHubHandle(m.github))
    .map((m) => {
      const alias = toAlias(m.github);
      return `
    ${alias}_assigned: search(query: "repo:${repo} assignee:${m.github} is:issue is:open", type: ISSUE, first: 20) {
      nodes { ... on Issue { number title url } }
    }
    ${alias}_prs: search(query: "repo:${repo} author:${m.github} is:pr is:open", type: ISSUE, first: 20) {
      nodes {
        ... on PullRequest {
          number
          title
          url
          isDraft
          createdAt
          reviewDecision
          reviewRequests(first: 20) {
            nodes { requestedReviewer { ... on User { login } } }
          }
        }
      }
    }
    ${alias}_merged: search(query: "repo:${repo} author:${m.github} is:pr is:merged merged:>=${since}", type: ISSUE, first: 20) {
      nodes { ... on PullRequest { number title url mergedAt } }
    }
    ${alias}_closed: search(query: "repo:${repo} assignee:${m.github} is:issue is:closed closed:>=${since}", type: ISSUE, first: 20) {
      nodes { ... on Issue { number title url closedAt } }
    }`;
    })
    .join('\n');

  return `{
  ${fragments}
}`;
}

// =============================================================================
// Review-Blocking Derivation
// =============================================================================

/**
 * Raw shape of an open-PR node as returned by the batched GraphQL query.
 * Exported for unit-test fixtures.
 */
export interface OpenPrNode {
  number: number;
  title: string;
  url: string;
  isDraft?: boolean;
  createdAt?: string;
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  reviewRequests?: {
    nodes?: Array<{ requestedReviewer?: { login?: string } | null } | null> | null;
  } | null;
}

/**
 * Derive review-blocking relationships from every team member's authored PRs.
 *
 * Two-pass algorithm:
 *   1. Collect (author, reviewer, pr) tuples by iterating each author's PRs
 *      and cross-referencing requested reviewers against the team roster.
 *   2. Distribute each tuple into the author's `reviewBlocking` array (as
 *      `direction: 'authored'`) and the reviewer's (as `direction: 'reviewing'`).
 *
 * Rules are documented in spec 694:
 *   - Open, not draft.
 *   - reviewDecision !== 'APPROVED'.
 *   - Requested reviewer must resolve to a User (not Team) and match the team roster.
 *   - Author is guaranteed to be a team member by construction (query scope).
 */
export function deriveReviewBlocking(
  prsByAuthor: Map<string, OpenPrNode[]>,
  members: TeamMember[],
): Map<string, ReviewBlockingEntry[]> {
  // Case-insensitive lookup: lower-case github handle → TeamMember.
  const roster = new Map<string, TeamMember>();
  for (const m of members) {
    if (!isValidGitHubHandle(m.github)) continue;
    roster.set(m.github.toLowerCase(), m);
  }

  const displayName = (m: TeamMember): string => m.name || m.github;

  const perMember = new Map<string, ReviewBlockingEntry[]>();
  const entriesFor = (handle: string): ReviewBlockingEntry[] => {
    const existing = perMember.get(handle);
    if (existing) return existing;
    const fresh: ReviewBlockingEntry[] = [];
    perMember.set(handle, fresh);
    return fresh;
  };

  for (const [authorHandle, prs] of prsByAuthor) {
    const author = roster.get(authorHandle.toLowerCase());
    if (!author) continue;

    for (const pr of prs) {
      if (pr.isDraft) continue;
      if (pr.reviewDecision === 'APPROVED') continue;

      const requestedNodes = pr.reviewRequests?.nodes ?? [];
      for (const node of requestedNodes) {
        const login = node?.requestedReviewer?.login;
        if (!login) continue; // Team-based requests resolve to undefined login.
        const reviewer = roster.get(login.toLowerCase());
        if (!reviewer) continue; // External reviewer.
        if (reviewer.github.toLowerCase() === author.github.toLowerCase()) continue; // Self-review edge.

        const prMeta = {
          number: pr.number,
          title: pr.title,
          url: pr.url,
          createdAt: pr.createdAt ?? '',
        };

        entriesFor(author.github).push({
          direction: 'authored',
          otherName: displayName(reviewer),
          otherGithub: reviewer.github,
          pr: prMeta,
        });
        entriesFor(reviewer.github).push({
          direction: 'reviewing',
          otherName: displayName(author),
          otherGithub: author.github,
          pr: prMeta,
        });
      }
    }
  }

  // Sort each member's entries oldest-first (stable, with PR number as tiebreaker).
  for (const list of perMember.values()) {
    list.sort((a, b) => {
      const byDate = (a.pr.createdAt ?? '').localeCompare(b.pr.createdAt ?? '');
      if (byDate !== 0) return byDate;
      return a.pr.number - b.pr.number;
    });
  }

  return perMember;
}

// =============================================================================
// Response Parser
// =============================================================================

/**
 * Parse the GraphQL response into a map of github handle → TeamMemberGitHubData.
 */
export function parseTeamGraphQLResponse(
  data: Record<string, unknown>,
  members: TeamMember[],
): Map<string, TeamMemberGitHubData> {
  const result = new Map<string, TeamMemberGitHubData>();
  const prsByAuthor = new Map<string, OpenPrNode[]>();

  for (const member of members) {
    if (!isValidGitHubHandle(member.github)) continue;

    const alias = toAlias(member.github);
    const assigned = data[`${alias}_assigned`] as { nodes?: Array<{ number: number; title: string; url: string }> } | undefined;
    const prs = data[`${alias}_prs`] as { nodes?: OpenPrNode[] } | undefined;
    const merged = data[`${alias}_merged`] as { nodes?: Array<{ number: number; title: string; url: string; mergedAt: string }> } | undefined;
    const closed = data[`${alias}_closed`] as { nodes?: Array<{ number: number; title: string; url: string; closedAt: string }> } | undefined;

    const openPrNodes = prs?.nodes ?? [];
    prsByAuthor.set(member.github, openPrNodes);

    result.set(member.github, {
      assignedIssues: (assigned?.nodes ?? []).map(n => ({ number: n.number, title: n.title, url: n.url })),
      openPRs: openPrNodes.map(n => ({ number: n.number, title: n.title, url: n.url })),
      recentActivity: {
        mergedPRs: (merged?.nodes ?? []).map(n => ({ number: n.number, title: n.title, url: n.url, mergedAt: n.mergedAt })),
        closedIssues: (closed?.nodes ?? []).map(n => ({ number: n.number, title: n.title, url: n.url, closedAt: n.closedAt })),
      },
      reviewBlocking: [],
    });
  }

  const perMemberBlocking = deriveReviewBlocking(prsByAuthor, members);
  for (const [handle, entries] of perMemberBlocking) {
    const bucket = result.get(handle);
    if (bucket) bucket.reviewBlocking = entries;
  }

  return result;
}

// =============================================================================
// Main Fetch Function
// =============================================================================

/**
 * Fetch forge data for all team members.
 * Routes through the `team-activity` concept command with a batched GraphQL query.
 * Returns empty data with error message on failure (graceful degradation).
 */
export async function fetchTeamGitHubData(
  members: TeamMember[],
  cwd?: string,
  forgeConfig?: ForgeConfig | null,
): Promise<{ data: Map<string, TeamMemberGitHubData>; error?: string }> {
  const validMembers = members.filter(m => isValidGitHubHandle(m.github));
  if (validMembers.length === 0) {
    return { data: new Map() };
  }

  const repo = await getRepoInfo(cwd);
  if (!repo) {
    return { data: new Map(), error: 'Could not determine repository. Configure forge concepts in .codev/config.json.' };
  }

  const query = buildTeamGraphQLQuery(validMembers, repo.owner, repo.name);

  try {
    const result = await executeForgeCommand('team-activity', {
      CODEV_GRAPHQL_QUERY: query,
    }, { cwd, forgeConfig });

    if (!result || typeof result !== 'object') {
      return { data: new Map(), error: 'team-activity concept returned no data' };
    }

    const response = result as { data?: Record<string, unknown> };
    if (!response.data) {
      return { data: new Map(), error: 'team-activity concept returned no data' };
    }

    return { data: parseTeamGraphQLResponse(response.data, validMembers) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: new Map(), error: `Forge API request failed: ${message}` };
  }
}
