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

export interface TeamMemberGitHubData {
  assignedIssues: { number: number; title: string; url: string }[];
  openPRs: { number: number; title: string; url: string }[];
  recentActivity: {
    mergedPRs: { number: number; title: string; mergedAt: string }[];
    closedIssues: { number: number; title: string; closedAt: string }[];
  };
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
      nodes { ... on PullRequest { number title url } }
    }
    ${alias}_merged: search(query: "repo:${repo} author:${m.github} is:pr is:merged merged:>=${since}", type: ISSUE, first: 20) {
      nodes { ... on PullRequest { number title mergedAt } }
    }
    ${alias}_closed: search(query: "repo:${repo} assignee:${m.github} is:issue is:closed closed:>=${since}", type: ISSUE, first: 20) {
      nodes { ... on Issue { number title closedAt } }
    }`;
    })
    .join('\n');

  return `{
  ${fragments}
}`;
}

/**
 * Parse the GraphQL response into a map of github handle → TeamMemberGitHubData.
 */
export function parseTeamGraphQLResponse(
  data: Record<string, unknown>,
  members: TeamMember[],
): Map<string, TeamMemberGitHubData> {
  const result = new Map<string, TeamMemberGitHubData>();

  for (const member of members) {
    if (!isValidGitHubHandle(member.github)) continue;

    const alias = toAlias(member.github);
    const assigned = data[`${alias}_assigned`] as { nodes?: Array<{ number: number; title: string; url: string }> } | undefined;
    const prs = data[`${alias}_prs`] as { nodes?: Array<{ number: number; title: string; url: string }> } | undefined;
    const merged = data[`${alias}_merged`] as { nodes?: Array<{ number: number; title: string; mergedAt: string }> } | undefined;
    const closed = data[`${alias}_closed`] as { nodes?: Array<{ number: number; title: string; closedAt: string }> } | undefined;

    result.set(member.github, {
      assignedIssues: (assigned?.nodes ?? []).map(n => ({ number: n.number, title: n.title, url: n.url })),
      openPRs: (prs?.nodes ?? []).map(n => ({ number: n.number, title: n.title, url: n.url })),
      recentActivity: {
        mergedPRs: (merged?.nodes ?? []).map(n => ({ number: n.number, title: n.title, mergedAt: n.mergedAt })),
        closedIssues: (closed?.nodes ?? []).map(n => ({ number: n.number, title: n.title, closedAt: n.closedAt })),
      },
    });
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
    return { data: new Map(), error: 'Could not determine repository. Configure forge concepts in af-config.json.' };
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
