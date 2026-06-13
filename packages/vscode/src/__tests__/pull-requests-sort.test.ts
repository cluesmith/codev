/**
 * Unit tests for the pure PR-sidebar sort helpers (`pull-requests-sort.ts`).
 * Lives in `__tests__/` (vitest harness) rather than `src/test/` (vscode-test
 * Electron harness) because the helpers touch no `vscode` APIs.
 */

import { describe, it, expect } from 'vitest';
import type { OverviewPR } from '@cluesmith/codev-types';
import { comparePendingPRs, sortPendingPRs } from '../views/pull-requests-sort.js';

function pr(overrides: Partial<OverviewPR> & Pick<OverviewPR, 'id' | 'createdAt'>): OverviewPR {
  return {
    title: `PR ${overrides.id}`,
    url: `https://example.com/${overrides.id}`,
    reviewStatus: 'REVIEW_REQUIRED',
    linkedIssue: null,
    reviewRequests: [],
    isDraft: false,
    ...overrides,
  };
}

describe('comparePendingPRs', () => {
  const me = 'alice';

  it('sorts mine before review-requested before others', () => {
    const mine = pr({ id: '1', createdAt: '2026-01-01T00:00:00Z', author: 'alice' });
    const requested = pr({ id: '2', createdAt: '2026-01-01T00:00:00Z', author: 'bob', reviewRequests: ['alice'] });
    const other = pr({ id: '3', createdAt: '2026-01-01T00:00:00Z', author: 'carol' });

    const sorted = [other, requested, mine].sort((a, b) => comparePendingPRs(a, b, me));
    expect(sorted.map(p => p.id)).toEqual(['1', '2', '3']);
  });

  it('treats a PR that is both mine and review-requested as mine (bucket 0)', () => {
    const both = pr({ id: '1', createdAt: '2026-01-01T00:00:00Z', author: 'alice', reviewRequests: ['alice'] });
    const requested = pr({ id: '2', createdAt: '2026-06-01T00:00:00Z', author: 'bob', reviewRequests: ['alice'] });

    const sorted = [requested, both].sort((a, b) => comparePendingPRs(a, b, me));
    // `both` wins despite `requested` being newer — bucket beats createdAt.
    expect(sorted.map(p => p.id)).toEqual(['1', '2']);
  });

  it('sorts createdAt-descending within a bucket', () => {
    const older = pr({ id: '1', createdAt: '2026-01-01T00:00:00Z', author: 'alice' });
    const newer = pr({ id: '2', createdAt: '2026-03-01T00:00:00Z', author: 'alice' });

    const sorted = [older, newer].sort((a, b) => comparePendingPRs(a, b, me));
    expect(sorted.map(p => p.id)).toEqual(['2', '1']);
  });

  it('matches author and reviewer case-insensitively', () => {
    const mine = pr({ id: '1', createdAt: '2026-01-01T00:00:00Z', author: 'Alice' });
    const requested = pr({ id: '2', createdAt: '2026-01-01T00:00:00Z', author: 'bob', reviewRequests: ['ALICE'] });
    const other = pr({ id: '3', createdAt: '2026-01-01T00:00:00Z', author: 'carol' });

    const sorted = [other, requested, mine].sort((a, b) => comparePendingPRs(a, b, me));
    expect(sorted.map(p => p.id)).toEqual(['1', '2', '3']);
  });

  it('falls back to createdAt-desc when me is undefined (no partitioning)', () => {
    const a = pr({ id: '1', createdAt: '2026-01-01T00:00:00Z', author: 'alice' });
    const b = pr({ id: '2', createdAt: '2026-05-01T00:00:00Z', author: 'bob', reviewRequests: ['alice'] });
    const c = pr({ id: '3', createdAt: '2026-03-01T00:00:00Z', author: 'carol' });

    const sorted = [a, b, c].sort((x, y) => comparePendingPRs(x, y, undefined));
    expect(sorted.map(p => p.id)).toEqual(['2', '3', '1']);
  });
});

describe('sortPendingPRs', () => {
  it('returns a new array and lowercases me for the caller', () => {
    const input = [
      pr({ id: '1', createdAt: '2026-01-01T00:00:00Z', author: 'bob' }),
      pr({ id: '2', createdAt: '2026-01-01T00:00:00Z', author: 'Alice' }),
    ];
    const sorted = sortPendingPRs(input, 'ALICE');
    expect(sorted).not.toBe(input);
    expect(sorted.map(p => p.id)).toEqual(['2', '1']);
  });

  it('handles an empty list', () => {
    expect(sortPendingPRs([], 'alice')).toEqual([]);
  });
});
