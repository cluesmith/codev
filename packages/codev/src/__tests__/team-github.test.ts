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
  deriveReviewBlocking,
  type OpenPrNode,
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
    // Verify merged/closed fragments request url
    expect(query).toMatch(/on PullRequest \{[^}]*url[^}]*mergedAt/);
    expect(query).toMatch(/on Issue \{[^}]*url[^}]*closedAt/);
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

  it('requests isDraft, createdAt, reviewDecision, and reviewRequests on the open-PR fragment', () => {
    const query = buildTeamGraphQLQuery([makeMember('alice')], 'org', 'repo');
    // These fields live inside the ${alias}_prs search only.
    const openPrSegment = query.split('u_alice_prs: search(')[1].split('u_alice_merged: search(')[0];
    expect(openPrSegment).toContain('isDraft');
    expect(openPrSegment).toContain('createdAt');
    expect(openPrSegment).toContain('reviewDecision');
    expect(openPrSegment).toContain('reviewRequests(first: 20)');
    expect(openPrSegment).toContain('requestedReviewer');
    expect(openPrSegment).toContain('... on User');

    // Other fragments must NOT accidentally receive these fields.
    const mergedSegment = query.split('u_alice_merged: search(')[1].split('u_alice_closed: search(')[0];
    expect(mergedSegment).not.toContain('reviewDecision');
    expect(mergedSegment).not.toContain('reviewRequests');
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
    expect(alice.recentActivity.mergedPRs[0]).toEqual({ number: 5, title: 'Old PR', url: 'https://github.com/org/repo/pull/5', mergedAt: '2026-03-07T10:00:00Z' });
    expect(alice.recentActivity.closedIssues).toHaveLength(1);
    expect(alice.recentActivity.closedIssues[0]).toEqual({ number: 2, title: 'Done issue', url: 'https://github.com/org/repo/issues/2', closedAt: '2026-03-06T15:00:00Z' });
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

// =============================================================================
// deriveReviewBlocking — the core review-blocking derivation (spec 694)
// =============================================================================

function makePr(overrides: Partial<OpenPrNode> & { number: number }): OpenPrNode {
  return {
    number: overrides.number,
    title: overrides.title ?? `PR ${overrides.number}`,
    url: overrides.url ?? `https://github.com/org/repo/pull/${overrides.number}`,
    isDraft: overrides.isDraft ?? false,
    createdAt: overrides.createdAt ?? '2026-04-01T10:00:00Z',
    reviewDecision: overrides.reviewDecision ?? 'REVIEW_REQUIRED',
    reviewRequests: overrides.reviewRequests ?? { nodes: [] },
  };
}

function reviewReq(login: string | undefined) {
  return { requestedReviewer: login ? { login } : {} };
}

describe('deriveReviewBlocking', () => {
  it('happy path: requested team reviewer generates both-direction relationship', () => {
    const members = [makeMember('amr', 'Amr'), makeMember('waleed', 'Waleed')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({ number: 688, reviewRequests: { nodes: [reviewReq('waleed')] } })]],
      ['waleed', []],
    ]);

    const result = deriveReviewBlocking(prs, members);

    expect(result.get('amr')).toHaveLength(1);
    expect(result.get('amr')![0]).toMatchObject({
      direction: 'authored',
      otherName: 'Waleed',
      otherGithub: 'waleed',
      pr: { number: 688 },
    });
    expect(result.get('waleed')).toHaveLength(1);
    expect(result.get('waleed')![0]).toMatchObject({
      direction: 'reviewing',
      otherName: 'Amr',
      otherGithub: 'amr',
      pr: { number: 688 },
    });
  });

  it('approved PR: no relationship even when team reviewer still in requests', () => {
    const members = [makeMember('amr'), makeMember('waleed')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({ number: 1, reviewDecision: 'APPROVED', reviewRequests: { nodes: [reviewReq('waleed')] } })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    expect(result.get('amr') ?? []).toHaveLength(0);
    expect(result.get('waleed') ?? []).toHaveLength(0);
  });

  it('changes requested with requester removed: no relationship', () => {
    const members = [makeMember('amr'), makeMember('waleed')];
    // GitHub auto-removes Waleed from reviewRequests when he requests changes.
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({ number: 2, reviewDecision: 'CHANGES_REQUESTED', reviewRequests: { nodes: [] } })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    expect(result.get('amr') ?? []).toHaveLength(0);
    expect(result.get('waleed') ?? []).toHaveLength(0);
  });

  it('draft PR: no relationship', () => {
    const members = [makeMember('amr'), makeMember('waleed')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({ number: 3, isDraft: true, reviewRequests: { nodes: [reviewReq('waleed')] } })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    expect(result.get('amr') ?? []).toHaveLength(0);
    expect(result.get('waleed') ?? []).toHaveLength(0);
  });

  it('external reviewer only: no relationship on any team card', () => {
    const members = [makeMember('amr'), makeMember('waleed')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({ number: 4, reviewRequests: { nodes: [reviewReq('external-bot')] } })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    expect(result.get('amr') ?? []).toHaveLength(0);
    expect(result.get('waleed') ?? []).toHaveLength(0);
  });

  it('multiple team reviewers on one PR: each reviewer sees one entry; author sees both', () => {
    const members = [makeMember('amr'), makeMember('waleed'), makeMember('younes')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({
        number: 5,
        reviewRequests: { nodes: [reviewReq('waleed'), reviewReq('younes')] },
      })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    expect(result.get('amr')).toHaveLength(2);
    expect(result.get('waleed')).toHaveLength(1);
    expect(result.get('younes')).toHaveLength(1);
  });

  it('multiple blocked PRs for one author with different reviewers', () => {
    const members = [makeMember('amr'), makeMember('waleed'), makeMember('younes')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [
        makePr({ number: 10, reviewRequests: { nodes: [reviewReq('waleed')] }, createdAt: '2026-04-01T00:00:00Z' }),
        makePr({ number: 11, reviewRequests: { nodes: [reviewReq('younes')] }, createdAt: '2026-04-02T00:00:00Z' }),
        makePr({ number: 12, reviewRequests: { nodes: [reviewReq('waleed')] }, createdAt: '2026-04-03T00:00:00Z' }),
      ]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    expect(result.get('amr')).toHaveLength(3);
  });

  it('no relationships: no entry in the result map for that member', () => {
    const members = [makeMember('amr'), makeMember('waleed')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', []],
      ['waleed', []],
    ]);
    const result = deriveReviewBlocking(prs, members);
    // The map may simply not contain keys for members with zero entries.
    expect(result.get('amr') ?? []).toHaveLength(0);
    expect(result.get('waleed') ?? []).toHaveLength(0);
  });

  it('case-insensitive match on author and reviewer logins', () => {
    const members = [makeMember('waleedkadous', 'Waleed'), makeMember('amr')];
    const prs = new Map<string, OpenPrNode[]>([
      // Note: author key mimics what GitHub returns (mixed case).
      ['AmR', [makePr({ number: 6, reviewRequests: { nodes: [reviewReq('WaleedKadous')] } })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    expect(result.get('amr')).toHaveLength(1);
    expect(result.get('waleedkadous')).toHaveLength(1);
    expect(result.get('waleedkadous')![0].otherName).toBe('amr');
  });

  it('mixed: reviewer who requested changes is absent; other still-pending reviewer generates a relationship', () => {
    const members = [makeMember('amr'), makeMember('waleed'), makeMember('younes')];
    // Waleed requested changes (GitHub removed him from requests).
    // Younes is still pending.
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({
        number: 7,
        reviewDecision: 'CHANGES_REQUESTED',
        reviewRequests: { nodes: [reviewReq('younes')] },
      })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    expect(result.get('amr')).toHaveLength(1);
    expect(result.get('amr')![0].otherGithub).toBe('younes');
    expect(result.get('waleed') ?? []).toHaveLength(0);
    expect(result.get('younes')).toHaveLength(1);
  });

  it('team-based review request (no login): silently skipped, no error', () => {
    const members = [makeMember('amr'), makeMember('waleed')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({
        number: 8,
        reviewRequests: { nodes: [
          { requestedReviewer: {} }, // Team: no login on the User inline fragment.
          reviewReq('waleed'),       // Plus one real User request.
        ] },
      })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    // Team is skipped; Waleed still produces an entry.
    expect(result.get('amr')).toHaveLength(1);
    expect(result.get('waleed')).toHaveLength(1);
  });

  it('empty state: members with zero entries are absent or empty-listed', () => {
    const members = [makeMember('amr'), makeMember('waleed')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({ number: 9, reviewDecision: 'APPROVED', reviewRequests: { nodes: [reviewReq('waleed')] } })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    expect(result.get('amr') ?? []).toHaveLength(0);
    expect(result.get('waleed') ?? []).toHaveLength(0);
  });

  it('sorts each member\'s entries oldest-first, with PR number as tiebreaker', () => {
    const members = [makeMember('amr'), makeMember('waleed')];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [
        makePr({ number: 30, createdAt: '2026-04-05T00:00:00Z', reviewRequests: { nodes: [reviewReq('waleed')] } }),
        makePr({ number: 10, createdAt: '2026-04-01T00:00:00Z', reviewRequests: { nodes: [reviewReq('waleed')] } }),
        makePr({ number: 20, createdAt: '2026-04-03T00:00:00Z', reviewRequests: { nodes: [reviewReq('waleed')] } }),
        // Tied createdAt; PR 21 > PR 20 so order is [20, 21]
        makePr({ number: 21, createdAt: '2026-04-03T00:00:00Z', reviewRequests: { nodes: [reviewReq('waleed')] } }),
      ]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    const amrNumbers = result.get('amr')!.map(e => e.pr.number);
    expect(amrNumbers).toEqual([10, 20, 21, 30]);
  });

  it('falls back to github handle when member has no display name', () => {
    const members = [
      { github: 'amr', name: '', role: 'dev', filePath: '' } as TeamMember,
      makeMember('waleed', 'Waleed'),
    ];
    const prs = new Map<string, OpenPrNode[]>([
      ['amr', [makePr({ number: 40, reviewRequests: { nodes: [reviewReq('waleed')] } })]],
    ]);
    const result = deriveReviewBlocking(prs, members);
    // Waleed's card should say "amr is waiting for you" — use handle as fallback.
    expect(result.get('waleed')![0].otherName).toBe('amr');
  });
});

// =============================================================================
// parseTeamGraphQLResponse — reviewBlocking end-to-end
// =============================================================================

describe('parseTeamGraphQLResponse with reviewBlocking', () => {
  it('populates reviewBlocking on both author and reviewer from a raw GraphQL response', () => {
    const members = [makeMember('amr', 'Amr'), makeMember('waleed', 'Waleed')];
    const data = {
      u_amr_assigned: { nodes: [] },
      u_amr_prs: { nodes: [{
        number: 688,
        title: 'local-install consolidation',
        url: 'https://github.com/org/repo/pull/688',
        isDraft: false,
        createdAt: '2026-04-10T12:00:00Z',
        reviewDecision: 'REVIEW_REQUIRED',
        reviewRequests: { nodes: [{ requestedReviewer: { login: 'waleed' } }] },
      }] },
      u_amr_merged: { nodes: [] },
      u_amr_closed: { nodes: [] },
      u_waleed_assigned: { nodes: [] },
      u_waleed_prs: { nodes: [] },
      u_waleed_merged: { nodes: [] },
      u_waleed_closed: { nodes: [] },
    };

    const result = parseTeamGraphQLResponse(data, members);
    expect(result.get('amr')!.reviewBlocking).toHaveLength(1);
    expect(result.get('amr')!.reviewBlocking[0].direction).toBe('authored');
    expect(result.get('amr')!.reviewBlocking[0].otherName).toBe('Waleed');
    expect(result.get('waleed')!.reviewBlocking).toHaveLength(1);
    expect(result.get('waleed')!.reviewBlocking[0].direction).toBe('reviewing');
    expect(result.get('waleed')!.reviewBlocking[0].otherName).toBe('Amr');
    expect(result.get('waleed')!.reviewBlocking[0].pr.number).toBe(688);
  });

  it('leaves reviewBlocking empty when there are no qualifying PRs', () => {
    const members = [makeMember('alice')];
    const result = parseTeamGraphQLResponse({}, members);
    expect(result.get('alice')!.reviewBlocking).toEqual([]);
  });
});
