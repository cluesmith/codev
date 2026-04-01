/**
 * Unit tests for lib/team-github.ts — GitHub data enrichment.
 *
 * Tests the pure functions (query builder, response parser) directly.
 * Also tests fetchTeamGitHubData graceful degradation via vi.mock.
 *
 * Spec 587: Team Tab in Tower Right Panel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildTeamGraphQLQuery,
  parseTeamGraphQLResponse,
  fetchTeamGitHubData,
} from '../lib/team-github.js';
import type { TeamMember } from '../lib/team.js';

// =============================================================================
// Helpers
// =============================================================================

function makeMember(github: string, name?: string): TeamMember {
  return { github, name: name ?? github, role: 'member', filePath: `people/${github}.md` };
}

// =============================================================================
// buildTeamGraphQLQuery
// =============================================================================

describe('buildTeamGraphQLQuery', () => {
  it('generates aliased search queries for each member', () => {
    const members = [makeMember('alice'), makeMember('bob')];
    const query = buildTeamGraphQLQuery(members, 'myorg', 'myrepo');

    expect(query).toContain('u_alice_assigned: search(');
    expect(query).toContain('u_alice_prs: search(');
    expect(query).toContain('u_alice_merged: search(');
    expect(query).toContain('u_alice_closed: search(');
    expect(query).toContain('u_bob_assigned: search(');
    expect(query).toContain('u_bob_prs: search(');
  });

  it('replaces hyphens with underscores in aliases', () => {
    const members = [makeMember('alice-bob')];
    const query = buildTeamGraphQLQuery(members, 'org', 'repo');

    // Alias should use underscore with u_ prefix, but query string keeps original handle
    expect(query).toContain('u_alice_bob_assigned: search(');
    expect(query).toContain('assignee:alice-bob');
  });

  it('interpolates owner/name directly into search strings', () => {
    const query = buildTeamGraphQLQuery([makeMember('alice')], 'myorg', 'myrepo');
    expect(query).toContain('repo:myorg/myrepo');
    // Should NOT use GraphQL variable syntax for owner/name
    expect(query).not.toContain('$owner');
    expect(query).not.toContain('$name');
  });

  it('filters out invalid GitHub handles', () => {
    const members = [makeMember('alice'), makeMember('-invalid')];
    const query = buildTeamGraphQLQuery(members, 'org', 'repo');

    expect(query).toContain('u_alice_assigned');
    expect(query).not.toContain('invalid_assigned');
  });

  it('returns empty query body for no valid members', () => {
    const query = buildTeamGraphQLQuery([makeMember('-invalid')], 'org', 'repo');
    // Should not contain any search fragments
    expect(query).not.toContain('_assigned: search(');
  });

  it('includes date filter for merged/closed queries', () => {
    const query = buildTeamGraphQLQuery([makeMember('alice')], 'org', 'repo');
    expect(query).toMatch(/merged:>=\d{4}-\d{2}-\d{2}/);
    expect(query).toMatch(/closed:>=\d{4}-\d{2}-\d{2}/);
  });

  it('handles digit-starting handles with u_ prefix', () => {
    const members = [makeMember('42user')];
    const query = buildTeamGraphQLQuery(members, 'org', 'repo');
    // Should have u_ prefix, not start alias with digit
    expect(query).toContain('u_42user_assigned: search(');
    expect(query).not.toMatch(/^\s+42user_assigned/m);
  });
});

// =============================================================================
// parseTeamGraphQLResponse
// =============================================================================

describe('parseTeamGraphQLResponse', () => {
  it('parses a complete response into member data', () => {
    const members = [makeMember('alice')];
    const data = {
      u_alice_assigned: {
        nodes: [{ number: 1, title: 'Bug fix', url: 'https://github.com/org/repo/issues/1' }],
      },
      u_alice_prs: {
        nodes: [{ number: 10, title: 'Feature PR', url: 'https://github.com/org/repo/pull/10' }],
      },
      u_alice_merged: {
        nodes: [{ number: 5, title: 'Old PR', url: 'https://github.com/org/repo/pull/5', mergedAt: '2026-03-07T10:00:00Z' }],
      },
      u_alice_closed: {
        nodes: [{ number: 2, title: 'Done issue', url: 'https://github.com/org/repo/issues/2', closedAt: '2026-03-06T15:00:00Z' }],
      },
    };

    const result = parseTeamGraphQLResponse(data, members);
    expect(result.size).toBe(1);

    const alice = result.get('alice')!;
    expect(alice.assignedIssues).toHaveLength(1);
    expect(alice.assignedIssues[0]).toEqual({ number: 1, title: 'Bug fix', url: 'https://github.com/org/repo/issues/1' });
    expect(alice.openPRs).toHaveLength(1);
    expect(alice.recentActivity.mergedPRs).toHaveLength(1);
    expect(alice.recentActivity.closedIssues).toHaveLength(1);
  });

  it('handles missing data keys gracefully (empty arrays)', () => {
    const members = [makeMember('alice')];
    const data = {}; // No data at all

    const result = parseTeamGraphQLResponse(data, members);
    const alice = result.get('alice')!;
    expect(alice.assignedIssues).toEqual([]);
    expect(alice.openPRs).toEqual([]);
    expect(alice.recentActivity.mergedPRs).toEqual([]);
    expect(alice.recentActivity.closedIssues).toEqual([]);
  });

  it('handles empty nodes arrays', () => {
    const members = [makeMember('bob')];
    const data = {
      u_bob_assigned: { nodes: [] },
      u_bob_prs: { nodes: [] },
      u_bob_merged: { nodes: [] },
      u_bob_closed: { nodes: [] },
    };

    const result = parseTeamGraphQLResponse(data, members);
    const bob = result.get('bob')!;
    expect(bob.assignedIssues).toEqual([]);
    expect(bob.openPRs).toEqual([]);
  });

  it('parses multiple members', () => {
    const members = [makeMember('alice'), makeMember('bob')];
    const data = {
      u_alice_assigned: { nodes: [{ number: 1, title: 'A', url: 'u1' }] },
      u_alice_prs: { nodes: [] },
      u_alice_merged: { nodes: [] },
      u_alice_closed: { nodes: [] },
      u_bob_assigned: { nodes: [] },
      u_bob_prs: { nodes: [{ number: 20, title: 'B', url: 'u2' }] },
      u_bob_merged: { nodes: [] },
      u_bob_closed: { nodes: [] },
    };

    const result = parseTeamGraphQLResponse(data, members);
    expect(result.size).toBe(2);
    expect(result.get('alice')!.assignedIssues).toHaveLength(1);
    expect(result.get('bob')!.openPRs).toHaveLength(1);
  });

  it('handles hyphenated handles with underscore aliases', () => {
    const members = [makeMember('alice-bob')];
    const data = {
      u_alice_bob_assigned: { nodes: [{ number: 3, title: 'Issue', url: 'u3' }] },
      u_alice_bob_prs: { nodes: [] },
      u_alice_bob_merged: { nodes: [] },
      u_alice_bob_closed: { nodes: [] },
    };

    const result = parseTeamGraphQLResponse(data, members);
    expect(result.size).toBe(1);
    // Key in map uses original handle (with hyphens)
    const member = result.get('alice-bob')!;
    expect(member.assignedIssues).toHaveLength(1);
  });

  it('skips members with invalid GitHub handles', () => {
    const members = [makeMember('alice'), makeMember('-invalid')];
    const data = {
      u_alice_assigned: { nodes: [] },
      u_alice_prs: { nodes: [] },
      u_alice_merged: { nodes: [] },
      u_alice_closed: { nodes: [] },
    };

    const result = parseTeamGraphQLResponse(data, members);
    expect(result.size).toBe(1);
    expect(result.has('alice')).toBe(true);
    expect(result.has('-invalid')).toBe(false);
  });
});

// =============================================================================
// fetchTeamGitHubData — graceful degradation
// =============================================================================

describe('fetchTeamGitHubData', () => {
  it('returns empty map with no error for empty members list', async () => {
    const result = await fetchTeamGitHubData([]);
    expect(result.data.size).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('returns empty map with no error when all members have invalid handles', async () => {
    const result = await fetchTeamGitHubData([makeMember('-bad'), makeMember('-also-bad')]);
    expect(result.data.size).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('returns gracefully when gh CLI succeeds or fails', async () => {
    // In CI, gh may not be authenticated; in dev, it may work.
    // Either way, fetchTeamGitHubData should not throw.
    const result = await fetchTeamGitHubData([makeMember('alice')]);
    // Should always return a result object (never throw)
    expect(result).toHaveProperty('data');
    expect(result.data).toBeInstanceOf(Map);
  });
});
