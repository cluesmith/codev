/**
 * Unit tests for activity feed logic — relativeDate and buildActivityFeed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { relativeDate, buildActivityFeed } from '../src/components/TeamView.js';
import type { TeamApiMember } from '../src/lib/api.js';

function makeMember(github: string, data: TeamApiMember['github_data'] = null): TeamApiMember {
  return { name: github, github, role: 'developer', filePath: '', github_data: data };
}

describe('relativeDate', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('returns "just now" for timestamps less than 1 hour ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T12:00:00Z'));
    expect(relativeDate('2026-04-01T11:30:00Z')).toBe('just now');
    expect(relativeDate('2026-04-01T11:59:59Z')).toBe('just now');
  });

  it('returns "Xh ago" for timestamps 1-23 hours ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T12:00:00Z'));
    expect(relativeDate('2026-04-01T11:00:00Z')).toBe('1h ago');
    expect(relativeDate('2026-04-01T06:00:00Z')).toBe('6h ago');
    expect(relativeDate('2026-03-31T13:00:00Z')).toBe('23h ago');
  });

  it('returns "Xd ago" for timestamps 24+ hours ago', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T12:00:00Z'));
    expect(relativeDate('2026-03-31T12:00:00Z')).toBe('1d ago');
    expect(relativeDate('2026-03-25T12:00:00Z')).toBe('7d ago');
  });
});

describe('buildActivityFeed', () => {
  it('returns empty array when no members have activity', () => {
    const members = [makeMember('alice', {
      assignedIssues: [], openPRs: [],
      recentActivity: { mergedPRs: [], closedIssues: [] },
      reviewBlocking: [],
    })];
    expect(buildActivityFeed(members)).toEqual([]);
  });

  it('returns empty array when github_data is null', () => {
    expect(buildActivityFeed([makeMember('alice')])).toEqual([]);
  });

  it('aggregates merged PRs and closed issues from multiple members', () => {
    const members = [
      makeMember('alice', {
        assignedIssues: [], openPRs: [], reviewBlocking: [],
        recentActivity: {
          mergedPRs: [{ number: 10, title: 'PR A', url: 'https://github.com/org/repo/pull/10', mergedAt: '2026-04-01T10:00:00Z' }],
          closedIssues: [],
        },
      }),
      makeMember('bob', {
        assignedIssues: [], openPRs: [], reviewBlocking: [],
        recentActivity: {
          mergedPRs: [],
          closedIssues: [{ number: 5, title: 'Issue B', url: 'https://github.com/org/repo/issues/5', closedAt: '2026-04-01T08:00:00Z' }],
        },
      }),
    ];
    const entries = buildActivityFeed(members);
    expect(entries).toHaveLength(2);
    expect(entries[0].author).toBe('alice');
    expect(entries[0].type).toBe('merged');
    expect(entries[1].author).toBe('bob');
    expect(entries[1].type).toBe('closed');
  });

  it('sorts entries reverse chronologically', () => {
    const members = [
      makeMember('alice', {
        assignedIssues: [], openPRs: [], reviewBlocking: [],
        recentActivity: {
          mergedPRs: [
            { number: 1, title: 'Old', url: 'u1', mergedAt: '2026-03-30T10:00:00Z' },
            { number: 2, title: 'New', url: 'u2', mergedAt: '2026-04-01T10:00:00Z' },
          ],
          closedIssues: [
            { number: 3, title: 'Mid', url: 'u3', closedAt: '2026-03-31T10:00:00Z' },
          ],
        },
      }),
    ];
    const entries = buildActivityFeed(members);
    expect(entries.map(e => e.number)).toEqual([2, 3, 1]);
  });

  it('correctly attributes entries to their member', () => {
    const members = [
      makeMember('alice', {
        assignedIssues: [], openPRs: [], reviewBlocking: [],
        recentActivity: {
          mergedPRs: [{ number: 1, title: 'X', url: 'u', mergedAt: '2026-04-01T10:00:00Z' }],
          closedIssues: [],
        },
      }),
    ];
    const entries = buildActivityFeed(members);
    expect(entries[0]).toMatchObject({
      type: 'merged', number: 1, title: 'X', url: 'u', author: 'alice',
    });
  });
});
