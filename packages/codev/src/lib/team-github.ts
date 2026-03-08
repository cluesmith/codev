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
    const { stdout } = await execFileAsync('gh', [
      'repo', 'view', '--json', 'owner,name',
    ], { cwd });
    const repo = JSON.parse(stdout);
    return { owner: repo.owner.login, name: repo.name };
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
 * Build a batched GraphQL query that fetches assigned issues, authored PRs,
 * and recent activity for all team members in one request.
 */
export function buildTeamGraphQLQuery(members: TeamMember[]): string {
  const since = sevenDaysAgo();

  const fragments = members
    .filter(m => isValidGitHubHandle(m.github))
    .map((m) => {
      // Sanitize handle for use as GraphQL alias (replace hyphens with underscores)
      const alias = m.github.replace(/-/g, '_');
      return `
    ${alias}_assigned: search(query: "repo:$owner/$name assignee:${m.github} is:issue is:open", type: ISSUE, first: 20) {
      nodes { ... on Issue { number title url } }
    }
    ${alias}_prs: search(query: "repo:$owner/$name author:${m.github} is:pr is:open", type: ISSUE, first: 20) {
      nodes { ... on PullRequest { number title url } }
    }
    ${alias}_merged: search(query: "repo:$owner/$name author:${m.github} is:pr is:merged merged:>=${since}", type: ISSUE, first: 20) {
      nodes { ... on PullRequest { number title mergedAt } }
    }
    ${alias}_closed: search(query: "repo:$owner/$name assignee:${m.github} is:issue is:closed closed:>=${since}", type: ISSUE, first: 20) {
      nodes { ... on Issue { number title closedAt } }
    }`;
    })
    .join('\n');

  return `query($owner: String!, $name: String!) {
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

    const alias = member.github.replace(/-/g, '_');
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
 * Fetch GitHub data for all team members in a single batched GraphQL request.
 * Returns null on failure (graceful degradation).
 */
export async function fetchTeamGitHubData(
  members: TeamMember[],
  cwd?: string,
): Promise<{ data: Map<string, TeamMemberGitHubData>; error?: string }> {
  const validMembers = members.filter(m => isValidGitHubHandle(m.github));
  if (validMembers.length === 0) {
    return { data: new Map() };
  }

  const repo = await getRepoInfo(cwd);
  if (!repo) {
    return { data: new Map(), error: 'Could not determine repository (is gh CLI authenticated?)' };
  }

  const query = buildTeamGraphQLQuery(validMembers);

  try {
    const { stdout } = await execFileAsync('gh', [
      'api', 'graphql',
      '-f', `query=${query}`,
      '-f', `owner=${repo.owner}`,
      '-f', `name=${repo.name}`,
    ], { cwd });

    const response = JSON.parse(stdout);
    if (!response.data) {
      return { data: new Map(), error: 'GitHub GraphQL returned no data' };
    }

    return { data: parseTeamGraphQLResponse(response.data, validMembers) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: new Map(), error: `GitHub API request failed: ${message}` };
  }
}
