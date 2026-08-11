/**
 * Unit tests for the pure helpers behind the Search Backlog Quick Pick (#918):
 * - `orderForSearch` (full spawnable backlog, mine-first, NO mine-only filter)
 * - `toQuickPickItems` (label / description projection, deterministic age)
 *
 * Lives in `__tests__/` (vitest harness) rather than `src/test/` (vscode-test
 * Electron harness) because the helpers touch no `vscode` APIs.
 */

import { describe, it, expect } from 'vitest';
import type { OverviewBacklogItem, OverviewData } from '@cluesmith/codev-types';
import {
  orderForSearch,
  toQuickPickItems,
  parseSearchDynamicQuery,
  toDynamicQuickPickItems,
} from '../views/backlog-search.js';

function item(
  id: string,
  over: Partial<OverviewBacklogItem> = {},
): OverviewBacklogItem {
  return {
    id,
    title: `t${id}`,
    area: 'vscode',
    hasBuilder: false,
    assignees: [],
    createdAt: '2026-05-30T00:00:00.000Z',
    ...over,
  } as unknown as OverviewBacklogItem;
}

function dataFrom(
  backlog: OverviewBacklogItem[],
  currentUser?: string | null,
): Pick<OverviewData, 'backlog' | 'currentUser'> {
  return { backlog, currentUser: currentUser ?? undefined };
}

describe('orderForSearch', () => {
  it('drops items that already have an active builder', () => {
    const out = orderForSearch(dataFrom([
      item('1'),
      item('2', { hasBuilder: true }),
      item('3'),
    ]));
    expect(out.map(i => i.id)).toEqual(['1', '3']);
  });

  it('puts current-user-assigned items first, preserving order within segments', () => {
    const out = orderForSearch(dataFrom([
      item('1', { assignees: ['bob'] }),
      item('2', { assignees: ['alice'] }),
      item('3', { assignees: ['carol'] }),
      item('4', { assignees: ['alice', 'dave'] }),
    ], 'alice'));
    // mine (2, 4) first in input order, then rest (1, 3) in input order
    expect(out.map(i => i.id)).toEqual(['2', '4', '1', '3']);
  });

  it('does NOT apply the mine-only filter — the full set is retained', () => {
    const out = orderForSearch(dataFrom([
      item('1', { assignees: ['alice'] }),
      item('2', { assignees: ['bob'] }),
    ], 'alice'));
    expect(out.map(i => i.id)).toEqual(['1', '2']);
  });

  it('falls back to plain Tower order when currentUser is unavailable', () => {
    const out = orderForSearch(dataFrom([
      item('1', { assignees: ['alice'] }),
      item('2', { assignees: ['bob'] }),
    ], null));
    expect(out.map(i => i.id)).toEqual(['1', '2']);
  });
});

describe('toQuickPickItems', () => {
  const now = Date.parse('2026-05-30T00:00:00.000Z');

  it('formats label as "#<id> <title>"', () => {
    const [row] = toQuickPickItems([item('909', { title: 'webview thing' })], now);
    expect(row.label).toBe('#909 webview thing');
    expect(row.issueId).toBe('909');
  });

  it('formats description as "<area> · <age>" with a relative age', () => {
    const created = '2026-05-27T00:00:00.000Z'; // 3 days before `now`
    const [row] = toQuickPickItems([item('1', { area: 'tower', createdAt: created })], now);
    expect(row.description).toBe('tower · 3d ago');
  });

  it('appends "· @<assignee>" when an assignee is present', () => {
    const created = '2026-05-29T22:00:00.000Z'; // 2 hours before `now`
    const [row] = toQuickPickItems(
      [item('1', { area: 'docs', createdAt: created, assignees: ['alice', 'bob'] })],
      now,
    );
    expect(row.description).toBe('docs · 2h ago · @alice');
  });
});

describe('parseSearchDynamicQuery (type-ahead grammar, #1179)', () => {
  it('offers both targets for a bare number, issue first', () => {
    expect(parseSearchDynamicQuery('1350')).toEqual([
      { kind: 'issue', id: '1350' },
      { kind: 'pr', id: '1350' },
    ]);
  });

  it('tolerates a leading # on the bare form', () => {
    expect(parseSearchDynamicQuery('#1350')).toEqual([
      { kind: 'issue', id: '1350' },
      { kind: 'pr', id: '1350' },
    ]);
  });

  it('trims surrounding whitespace', () => {
    expect(parseSearchDynamicQuery('  1350  ')).toHaveLength(2);
  });

  it('narrows to issue for "issue N" and "view issue N"', () => {
    expect(parseSearchDynamicQuery('issue 1350')).toEqual([{ kind: 'issue', id: '1350' }]);
    expect(parseSearchDynamicQuery('view issue 1350')).toEqual([{ kind: 'issue', id: '1350' }]);
  });

  it('narrows to pr for "pr N" and "view pr N"', () => {
    expect(parseSearchDynamicQuery('pr 1350')).toEqual([{ kind: 'pr', id: '1350' }]);
    expect(parseSearchDynamicQuery('view pr 1350')).toEqual([{ kind: 'pr', id: '1350' }]);
  });

  it('is case-insensitive and tolerates # on the typed form', () => {
    expect(parseSearchDynamicQuery('ISSUE #1350')).toEqual([{ kind: 'issue', id: '1350' }]);
    expect(parseSearchDynamicQuery('View PR #1350')).toEqual([{ kind: 'pr', id: '1350' }]);
  });

  it('yields nothing for plain text searches', () => {
    expect(parseSearchDynamicQuery('')).toEqual([]);
    expect(parseSearchDynamicQuery('tower')).toEqual([]);
    expect(parseSearchDynamicQuery('12a3')).toEqual([]);
  });

  it('yields nothing when extra text follows the number', () => {
    expect(parseSearchDynamicQuery('1350 fix')).toEqual([]);
    expect(parseSearchDynamicQuery('view pr 1350 now')).toEqual([]);
  });

  it('yields nothing for a bare keyword without a number', () => {
    expect(parseSearchDynamicQuery('issue')).toEqual([]);
    expect(parseSearchDynamicQuery('view pr')).toEqual([]);
    expect(parseSearchDynamicQuery('#')).toEqual([]);
  });
});

describe('toDynamicQuickPickItems', () => {
  it('labels rows "View Issue #N" / "View PR #N" and always shows them', () => {
    const rows = toDynamicQuickPickItems('1350');
    expect(rows.map(r => r.label)).toEqual(['View Issue #1350', 'View PR #1350']);
    for (const row of rows) {
      expect(row.alwaysShow).toBe(true);
      expect(row.description).toBe('Open in browser');
      expect(row.id).toBe('1350');
    }
  });

  it('projects a single row for the typed form', () => {
    const rows = toDynamicQuickPickItems('view pr 1350');
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe('View PR #1350');
    expect(rows[0].kind).toBe('pr');
  });
});
