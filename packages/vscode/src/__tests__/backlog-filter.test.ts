/**
 * Unit tests for the pure helpers that back the Backlog view:
 * - `filterMine` (mine-only / show-all toggle, from #809)
 * - `spawnableBacklog` (excludes issues with active builders)
 * - `visibleBacklogCount` and `formatBacklogTitle` (title-count, from #911)
 *
 * Lives in `__tests__/` (vitest harness) rather than `src/test/` (vscode-test
 * Electron harness) because the helpers touch no `vscode` APIs.
 */

import { describe, it, expect } from 'vitest';
import type { OverviewBacklogItem, OverviewBuilder, OverviewData, IssueSearchItem } from '@cluesmith/codev-types';
import {
  filterMine,
  spawnableBacklog,
  activeBuilderCountByArea,
  visibleBacklogCount,
  formatBacklogTitle,
  searchBacklog,
  clampCriteriaToDataset,
  formatAge,
  ASSIGNEE_ME,
  ASSIGNEE_UNASSIGNED,
  AUTHOR_ME,
} from '../views/backlog-filter.js';

function assignedItem(id: string, assignees: string[]): OverviewBacklogItem {
  return { id, title: `t${id}`, hasBuilder: false, assignees } as unknown as OverviewBacklogItem;
}

function spawnableItem(id: string, hasBuilder: boolean, assignees: string[] = []): OverviewBacklogItem {
  return { id, title: `t${id}`, hasBuilder, assignees } as unknown as OverviewBacklogItem;
}

function dataFrom(
  backlog: OverviewBacklogItem[],
  currentUser?: string | null,
): Pick<OverviewData, 'backlog' | 'currentUser'> {
  return { backlog, currentUser: currentUser ?? undefined };
}

describe('filterMine', () => {
  it('keeps only items assigned to currentUser', () => {
    const out = filterMine([
      assignedItem('1', ['alice']),
      assignedItem('2', ['bob']),
      assignedItem('3', ['alice', 'carol']),
    ], 'alice');
    expect(out.map(i => i.id)).toEqual(['1', '3']);
  });

  it('returns input unchanged when currentUser is null (gh-unavailable fallback)', () => {
    const items = [
      assignedItem('1', ['alice']),
      assignedItem('2', []),
    ];
    expect(filterMine(items, null).map(i => i.id)).toEqual(['1', '2']);
    expect(filterMine(items, undefined).map(i => i.id)).toEqual(['1', '2']);
    expect(filterMine(items, '').map(i => i.id)).toEqual(['1', '2']);
  });

  it('matches logins case-insensitively', () => {
    const out = filterMine([
      assignedItem('1', ['Alice']),
      assignedItem('2', ['BOB']),
    ], 'alice');
    expect(out.map(i => i.id)).toEqual(['1']);
  });

  it('returns empty for empty input', () => {
    expect(filterMine([], 'alice')).toEqual([]);
  });

  it('drops items with missing assignees field when filtering', () => {
    const noAssignees = { id: 'x', title: 'tx', hasBuilder: false } as unknown as OverviewBacklogItem;
    const out = filterMine([noAssignees, assignedItem('y', ['alice'])], 'alice');
    expect(out.map(i => i.id)).toEqual(['y']);
  });
});

describe('spawnableBacklog', () => {
  it('drops items that already have an active builder', () => {
    const out = spawnableBacklog([
      spawnableItem('1', false),
      spawnableItem('2', true),
      spawnableItem('3', false),
    ]);
    expect(out.map(i => i.id)).toEqual(['1', '3']);
  });

  it('returns empty for empty input', () => {
    expect(spawnableBacklog([])).toEqual([]);
  });

  it('preserves order of the kept items', () => {
    const out = spawnableBacklog([
      spawnableItem('a', false),
      spawnableItem('b', true),
      spawnableItem('c', false),
      spawnableItem('d', false),
    ]);
    expect(out.map(i => i.id)).toEqual(['a', 'c', 'd']);
  });
});

describe('visibleBacklogCount', () => {
  it('returns full spawnable count for both visible and total when showAll is true', () => {
    const data = dataFrom([
      spawnableItem('1', false, ['alice']),
      spawnableItem('2', false, ['bob']),
      spawnableItem('3', false, []),
    ], 'alice');
    expect(visibleBacklogCount(data, true)).toEqual({ visible: 3, total: 3 });
  });

  it('filters visible to currentUser-assigned when showAll is false', () => {
    const data = dataFrom([
      spawnableItem('1', false, ['alice']),
      spawnableItem('2', false, ['bob']),
      spawnableItem('3', false, ['alice', 'carol']),
    ], 'alice');
    expect(visibleBacklogCount(data, false)).toEqual({ visible: 2, total: 3 });
  });

  it('falls through to total when mine-only is on but currentUser is null', () => {
    const data = dataFrom([
      spawnableItem('1', false, ['alice']),
      spawnableItem('2', false, ['bob']),
    ], null);
    // filterMine is a no-op here, so visible == total — matches BacklogProvider's safety branch.
    expect(visibleBacklogCount(data, false)).toEqual({ visible: 2, total: 2 });
  });

  it('excludes items with active builders from both visible and total', () => {
    const data = dataFrom([
      spawnableItem('1', false, ['alice']),
      spawnableItem('2', true,  ['alice']),  // has a builder — out
      spawnableItem('3', false, ['bob']),
      spawnableItem('4', true,  ['bob']),    // has a builder — out
    ], 'alice');
    // total = spawnable count (2); visible = spawnable + filterMine = 1.
    expect(visibleBacklogCount(data, false)).toEqual({ visible: 1, total: 2 });
    expect(visibleBacklogCount(data, true)).toEqual({ visible: 2, total: 2 });
  });

  it('returns zeros for empty backlog', () => {
    const data = dataFrom([], 'alice');
    expect(visibleBacklogCount(data, false)).toEqual({ visible: 0, total: 0 });
    expect(visibleBacklogCount(data, true)).toEqual({ visible: 0, total: 0 });
  });

  it('returns visible: 0, total > 0 when nothing is assigned to the current user', () => {
    const data = dataFrom([
      spawnableItem('1', false, ['bob']),
      spawnableItem('2', false, ['carol']),
    ], 'alice');
    expect(visibleBacklogCount(data, false)).toEqual({ visible: 0, total: 2 });
  });
});

describe('formatBacklogTitle', () => {
  it('returns plain "Backlog" when counts are unknown (no data)', () => {
    expect(formatBacklogTitle(undefined, undefined)).toBe('Backlog');
  });

  it('returns "Backlog (N)" when visible == total', () => {
    expect(formatBacklogTitle(5, 5)).toBe('Backlog (5)');
    expect(formatBacklogTitle(0, 0)).toBe('Backlog (0)');
  });

  it('returns "Backlog (V of T)" when mine-only is hiding rows', () => {
    expect(formatBacklogTitle(3, 47)).toBe('Backlog (3 of 47)');
    expect(formatBacklogTitle(0, 5)).toBe('Backlog (0 of 5)');
  });

  it('treats partial undefined counts as the no-data case', () => {
    expect(formatBacklogTitle(undefined, 5)).toBe('Backlog');
    expect(formatBacklogTitle(5, undefined)).toBe('Backlog');
  });
});

// --- Backlog search (#920) ---

function searchItem(over: Partial<IssueSearchItem> & { id: string }): IssueSearchItem {
  return {
    title: `Issue ${over.id}`,
    url: `https://example.test/${over.id}`,
    area: 'Uncategorized',
    createdAt: '2026-05-01T00:00:00Z',
    body: '',
    ...over,
  };
}

describe('searchBacklog — text', () => {
  const items = [
    searchItem({ id: '1', title: 'Add webview panel', body: 'rich search UI' }),
    searchItem({ id: '2', title: 'Fix tree toggle', body: 'mentions WEBVIEW in body' }),
    searchItem({ id: '3', title: 'Unrelated', body: 'nothing here' }),
  ];

  it('matches title substring, case-insensitively', () => {
    expect(searchBacklog(items, { text: 'PANEL' }).map(i => i.id)).toEqual(['1']);
  });

  it('matches body substring', () => {
    expect(searchBacklog(items, { text: 'webview' }).map(i => i.id).sort()).toEqual(['1', '2']);
  });

  it('empty text returns everything', () => {
    expect(searchBacklog(items, { text: '' })).toHaveLength(3);
    expect(searchBacklog(items, {})).toHaveLength(3);
  });

  it('whitespace-only text is treated as empty', () => {
    expect(searchBacklog(items, { text: '   ' })).toHaveLength(3);
  });
});

describe('searchBacklog — scopes AND together', () => {
  const items = [
    searchItem({ id: '1', area: 'area/vscode', assignees: ['alice'], author: 'bob' }),
    searchItem({ id: '2', area: 'area/vscode', assignees: ['carol'], author: 'alice' }),
    searchItem({ id: '3', area: 'area/tower', assignees: ['alice'], author: 'alice' }),
    searchItem({ id: '4', area: 'area/vscode', assignees: [], author: 'dave' }),
  ];

  it('filters by exact area', () => {
    expect(searchBacklog(items, { area: 'area/tower' }).map(i => i.id)).toEqual(['3']);
  });

  it('resolves the "me" assignee sentinel via currentUser', () => {
    expect(searchBacklog(items, { assignee: ASSIGNEE_ME, currentUser: 'alice' }).map(i => i.id).sort())
      .toEqual(['1', '3']);
  });

  it('resolves the "unassigned" sentinel', () => {
    expect(searchBacklog(items, { assignee: ASSIGNEE_UNASSIGNED }).map(i => i.id)).toEqual(['4']);
  });

  it('filters by author "me"', () => {
    expect(searchBacklog(items, { author: AUTHOR_ME, currentUser: 'alice' }).map(i => i.id).sort())
      .toEqual(['2', '3']);
  });

  it('ANDs area + assignee', () => {
    expect(searchBacklog(items, { area: 'area/vscode', assignee: 'alice' }).map(i => i.id)).toEqual(['1']);
  });

  it('"me" sentinel with unknown currentUser is a no-op (does not hide everything)', () => {
    expect(searchBacklog(items, { assignee: ASSIGNEE_ME }).map(i => i.id)).toEqual(['1', '2', '3', '4']);
  });
});

describe('searchBacklog — sort', () => {
  const items = [
    searchItem({ id: '10', title: 'Beta', area: 'area/tower', createdAt: '2026-05-20T00:00:00Z' }),
    searchItem({ id: '2', title: 'alpha', area: 'area/vscode', createdAt: '2026-05-01T00:00:00Z' }),
    searchItem({ id: '7', title: 'Gamma', area: 'area/docs', createdAt: '2026-05-10T00:00:00Z' }),
  ];

  it('sorts by id numerically (asc)', () => {
    expect(searchBacklog(items, { sort: 'id', direction: 'asc' }).map(i => i.id)).toEqual(['2', '7', '10']);
  });

  it('sorts by title case-insensitively (asc)', () => {
    expect(searchBacklog(items, { sort: 'title', direction: 'asc' }).map(i => i.title))
      .toEqual(['alpha', 'Beta', 'Gamma']);
  });

  it('default sort is age desc — oldest first', () => {
    expect(searchBacklog(items, {}).map(i => i.id)).toEqual(['2', '7', '10']);
  });

  it('age asc surfaces newest first', () => {
    expect(searchBacklog(items, { sort: 'age', direction: 'asc' }).map(i => i.id)).toEqual(['10', '7', '2']);
  });

  it('does not mutate the input array', () => {
    const before = items.map(i => i.id);
    searchBacklog(items, { sort: 'id', direction: 'asc' });
    expect(items.map(i => i.id)).toEqual(before);
  });
});

describe('clampCriteriaToDataset', () => {
  // Regression for the #920 Codex finding: a refresh/Status change that drops a
  // selected facet value must clear it from criteria, so the host's filter
  // matches the dropdown (which resets the vanished option to "All").
  const items = [
    searchItem({ id: '1', area: 'area/vscode', assignees: ['alice'], author: 'bob' }),
  ];

  it('clears an area no longer present in the dataset', () => {
    expect(clampCriteriaToDataset({ area: 'area/tower' }, items).area).toBe('');
  });

  it('keeps an area still present', () => {
    expect(clampCriteriaToDataset({ area: 'area/vscode' }, items).area).toBe('area/vscode');
  });

  it('clears a vanished assignee login but keeps the me / unassigned sentinels', () => {
    expect(clampCriteriaToDataset({ assignee: 'carol' }, items).assignee).toBe('');
    expect(clampCriteriaToDataset({ assignee: ASSIGNEE_ME }, items).assignee).toBe(ASSIGNEE_ME);
    expect(clampCriteriaToDataset({ assignee: ASSIGNEE_UNASSIGNED }, items).assignee).toBe(ASSIGNEE_UNASSIGNED);
  });

  it('clears a vanished author but keeps the me sentinel', () => {
    expect(clampCriteriaToDataset({ author: 'dave' }, items).author).toBe('');
    expect(clampCriteriaToDataset({ author: AUTHOR_ME }, items).author).toBe(AUTHOR_ME);
  });

  it('keeps a present assignee/author and does not mutate the input', () => {
    const crit = { area: 'area/vscode', assignee: 'alice', author: 'bob' };
    const out = clampCriteriaToDataset(crit, items);
    expect(out).toEqual({ area: 'area/vscode', assignee: 'alice', author: 'bob' });
    expect(crit.assignee).toBe('alice'); // input untouched
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-05-30T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const H = 3600_000, D = 86_400_000;

  it('renders "today" for under an hour', () => {
    expect(formatAge(ago(30 * 60_000), now)).toBe('today');
  });
  it('renders hours under a day', () => {
    expect(formatAge(ago(5 * H), now)).toBe('5h');
  });
  it('renders days under a week', () => {
    expect(formatAge(ago(3 * D), now)).toBe('3d');
  });
  it('renders weeks under a month', () => {
    expect(formatAge(ago(14 * D), now)).toBe('2w');
  });
  it('renders months under a year', () => {
    expect(formatAge(ago(70 * D), now)).toBe('2mo');
  });
  it('renders years', () => {
    expect(formatAge(ago(400 * D), now)).toBe('1y');
  });
  it('returns empty string for an unparseable date', () => {
    expect(formatAge('not-a-date', now)).toBe('');
  });
});

describe('activeBuilderCountByArea', () => {
  // The helper reads only `.area`; the rest of the shape is irrelevant.
  const builderIn = (area: string): OverviewBuilder => ({ area } as unknown as OverviewBuilder);

  it('empty builders → empty map', () => {
    expect(activeBuilderCountByArea([]).size).toBe(0);
  });

  it('counts one builder under its area', () => {
    const counts = activeBuilderCountByArea([builderIn('vscode')]);
    expect(counts.get('vscode')).toBe(1);
    expect(counts.get('tower')).toBeUndefined();
  });

  it('sums multiple builders in the same area', () => {
    const counts = activeBuilderCountByArea([builderIn('vscode'), builderIn('vscode'), builderIn('vscode')]);
    expect(counts.get('vscode')).toBe(3);
  });

  it('keeps per-area counts separate across areas', () => {
    const counts = activeBuilderCountByArea([
      builderIn('vscode'),
      builderIn('tower'),
      builderIn('vscode'),
    ]);
    expect(counts.get('vscode')).toBe(2);
    expect(counts.get('tower')).toBe(1);
  });

  it('counts Uncategorized builders under the raw area value', () => {
    const counts = activeBuilderCountByArea([builderIn('Uncategorized'), builderIn('Uncategorized')]);
    expect(counts.get('Uncategorized')).toBe(2);
  });
});
