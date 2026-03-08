/**
 * Unit tests for lib/team-github.ts — GitHub data enrichment.
 *
 * Tests the pure functions (query builder, response parser) directly.
 * The async fetch functions depend on `gh` CLI and are not unit-tested here.
 *
 * Spec 587: Team Tab in Tower Right Panel.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTeamGraphQLQuery,
  parseTeamGraphQLResponse,
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
    const query = buildTeamGraphQLQuery(members);

    expect(query).toContain('alice_assigned: search(');
    expect(query).toContain('alice_prs: search(');
    expect(query).toContain('alice_merged: search(');
    expect(query).toContain('alice_closed: search(');
    expect(query).toContain('bob_assigned: search(');
    expect(query).toContain('bob_prs: search(');
  });

  it('replaces hyphens with underscores in aliases', () => {
    const members = [makeMember('alice-bob')];
    const query = buildTeamGraphQLQuery(members);

    // Alias should use underscore, but query string keeps original handle
    expect(query).toContain('alice_bob_assigned: search(');
    expect(query).toContain('assignee:alice-bob');
  });

  it('includes $owner/$name variables', () => {
    const query = buildTeamGraphQLQuery([makeMember('alice')]);
    expect(query).toContain('query($owner: String!, $name: String!)');
    expect(query).toContain('repo:$owner/$name');
  });

  it('filters out invalid GitHub handles', () => {
    const members = [makeMember('alice'), makeMember('-invalid')];
    const query = buildTeamGraphQLQuery(members);

    expect(query).toContain('alice_assigned');
    expect(query).not.toContain('invalid_assigned');
  });

  it('returns empty query body for no valid members', () => {
    const query = buildTeamGraphQLQuery([makeMember('-invalid')]);
    // Should still have the query wrapper but no search fragments
    expect(query).toContain('query($owner: String!, $name: String!)');
    expect(query).not.toContain('_assigned: search(');
  });

  it('includes date filter for merged/closed queries', () => {
    const query = buildTeamGraphQLQuery([makeMember('alice')]);
    // Should have a date in YYYY-MM-DD format
    expect(query).toMatch(/merged:>=\d{4}-\d{2}-\d{2}/);
    expect(query).toMatch(/closed:>=\d{4}-\d{2}-\d{2}/);
  });
});

// =============================================================================
// parseTeamGraphQLResponse
// =============================================================================

describe('parseTeamGraphQLResponse', () => {
  it('parses a complete response into member data', () => {
    const members = [makeMember('alice')];
    const data = {
      alice_assigned: {
        nodes: [{ number: 1, title: 'Bug fix', url: 'https://github.com/org/repo/issues/1' }],
      },
      alice_prs: {
        nodes: [{ number: 10, title: 'Feature PR', url: 'https://github.com/org/repo/pull/10' }],
      },
      alice_merged: {
        nodes: [{ number: 5, title: 'Old PR', mergedAt: '2026-03-07T10:00:00Z' }],
      },
      alice_closed: {
        nodes: [{ number: 2, title: 'Done issue', closedAt: '2026-03-06T15:00:00Z' }],
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
      bob_assigned: { nodes: [] },
      bob_prs: { nodes: [] },
      bob_merged: { nodes: [] },
      bob_closed: { nodes: [] },
    };

    const result = parseTeamGraphQLResponse(data, members);
    const bob = result.get('bob')!;
    expect(bob.assignedIssues).toEqual([]);
    expect(bob.openPRs).toEqual([]);
  });

  it('parses multiple members', () => {
    const members = [makeMember('alice'), makeMember('bob')];
    const data = {
      alice_assigned: { nodes: [{ number: 1, title: 'A', url: 'u1' }] },
      alice_prs: { nodes: [] },
      alice_merged: { nodes: [] },
      alice_closed: { nodes: [] },
      bob_assigned: { nodes: [] },
      bob_prs: { nodes: [{ number: 20, title: 'B', url: 'u2' }] },
      bob_merged: { nodes: [] },
      bob_closed: { nodes: [] },
    };

    const result = parseTeamGraphQLResponse(data, members);
    expect(result.size).toBe(2);
    expect(result.get('alice')!.assignedIssues).toHaveLength(1);
    expect(result.get('bob')!.openPRs).toHaveLength(1);
  });

  it('handles hyphenated handles with underscore aliases', () => {
    const members = [makeMember('alice-bob')];
    const data = {
      alice_bob_assigned: { nodes: [{ number: 3, title: 'Issue', url: 'u3' }] },
      alice_bob_prs: { nodes: [] },
      alice_bob_merged: { nodes: [] },
      alice_bob_closed: { nodes: [] },
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
      alice_assigned: { nodes: [] },
      alice_prs: { nodes: [] },
      alice_merged: { nodes: [] },
      alice_closed: { nodes: [] },
    };

    const result = parseTeamGraphQLResponse(data, members);
    expect(result.size).toBe(1);
    expect(result.has('alice')).toBe(true);
    expect(result.has('-invalid')).toBe(false);
  });
});
