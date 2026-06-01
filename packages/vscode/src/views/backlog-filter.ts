import type { OverviewBacklogItem, OverviewData, IssueSearchItem } from '@cluesmith/codev-types';

/**
 * Backlog rows the user can act on — exclude issues that already have an
 * active builder. Mirrors the dashboard's BacklogList
 * (`items.filter(i => !i.hasBuilder)`) so the extension and web show the
 * same "available work" set and you can't double-spawn from the Backlog.
 *
 * Lives in this file (vscode-free) so both `BacklogProvider` and the
 * title-count helper can share the same primitive without dragging the
 * vscode module into the vitest harness.
 */
export function spawnableBacklog(items: OverviewBacklogItem[]): OverviewBacklogItem[] {
  return items.filter(i => !i.hasBuilder);
}

/**
 * Filter a backlog list to items assigned to `currentUser`. If
 * `currentUser` is empty / null / undefined (gh unavailable, not
 * authenticated), returns the input unchanged so the view doesn't
 * collapse to empty when we can't tell who "mine" is. Login matching
 * is case-insensitive.
 *
 * Lives in its own file (not in `backlog.ts`) so vitest unit tests can
 * import it without dragging in the `vscode` module. Same pattern the
 * codebase uses for any pure helper unit-tested from `__tests__/`.
 */
export function filterMine(
  items: OverviewBacklogItem[],
  currentUser: string | null | undefined,
): OverviewBacklogItem[] {
  const me = currentUser?.toLowerCase();
  if (!me) { return items; }
  return items.filter(item => !!item.assignees?.some(a => a.toLowerCase() === me));
}

/**
 * Compute the visible-vs-total counts the Backlog view's title should
 * display. Mirrors `BacklogProvider.orderedSpawnable`'s filter chain
 * (`spawnableBacklog` → conditionally `filterMine`) but only counts —
 * cheap to recompute on every title refresh and independent of the
 * provider's lifecycle.
 *
 * `total` is the full spawnable count (mode-independent). `visible` is
 * what the tree actually renders given `showAll` and `data.currentUser`.
 * When mine-only is active but `currentUser` is unavailable, `filterMine`
 * is a no-op so `visible == total` — matching the safety branch in
 * `orderedSpawnable`.
 */
export function visibleBacklogCount(
  data: Pick<OverviewData, 'backlog' | 'currentUser'>,
  showAll: boolean,
): { visible: number; total: number } {
  const spawnable = spawnableBacklog(data.backlog);
  const visible = showAll ? spawnable : filterMine(spawnable, data.currentUser);
  return { visible: visible.length, total: spawnable.length };
}

/**
 * Format the Backlog view's title. Renders `Backlog` when counts are
 * unknown (disconnected / loading — falls back to the plain base name,
 * no misleading "(0)"), `Backlog (N)` when the visible set is the full
 * set, and `Backlog (V of T)` when the user has the mine-only filter on
 * and there's more available behind the toggle.
 */
export function formatBacklogTitle(
  visible: number | undefined,
  total: number | undefined,
): string {
  if (typeof visible !== 'number' || typeof total !== 'number') { return 'Backlog'; }
  if (visible === total) { return `Backlog (${total})`; }
  return `Backlog (${visible} of ${total})`;
}

// =============================================================================
// Backlog search (#920) — pure host-side filter/sort over IssueSearchItem
//
// The "Search Backlog" webview posts criteria; the extension host runs these
// helpers against the dataset fetched from /api/issue-search and posts the
// rows back. Kept vscode-free (this file already is) so vitest can exercise
// every branch without the editor runtime. The webview itself never filters —
// body never crosses into it.
// =============================================================================

/** Sentinel selected in the Assignee dropdown to mean "current user". */
export const ASSIGNEE_ME = 'me';
/** Sentinel selected in the Assignee dropdown to mean "no assignees". */
export const ASSIGNEE_UNASSIGNED = 'unassigned';
/** Sentinel selected in the Author dropdown to mean "current user". */
export const AUTHOR_ME = 'me';

export type BacklogSortColumn = 'id' | 'title' | 'area' | 'assignee' | 'age';
export type BacklogSortDirection = 'asc' | 'desc';

export interface BacklogSearchCriteria {
  /** Substring matched (case-insensitive) against title + body. Empty = match all. */
  text?: string;
  /** Exact `area/*` value to keep. Empty/undefined = all areas. */
  area?: string;
  /**
   * `''` = any assignee; `ASSIGNEE_ME` = the current user; `ASSIGNEE_UNASSIGNED`
   * = items with no assignees; any other value = that login (case-insensitive).
   */
  assignee?: string;
  /**
   * `''` = anyone; `AUTHOR_ME` = the current user; any other value = that login.
   */
  author?: string;
  /** Sort column (default `age`). */
  sort?: BacklogSortColumn;
  /** Sort direction (default `desc`). For `age`, `desc` surfaces oldest first. */
  direction?: BacklogSortDirection;
  /** Current user's login — resolves the `me` sentinels. */
  currentUser?: string;
}

function matchesText(item: IssueSearchItem, text: string): boolean {
  // Title + body, case-insensitive substring. Pure substring by design —
  // fuzzy matching is Quick Pick's job (#918), not this panel's.
  return `${item.title}\n${item.body}`.toLowerCase().includes(text);
}

function matchesAssignee(item: IssueSearchItem, assignee: string, me: string | undefined): boolean {
  if (!assignee) { return true; }
  if (assignee === ASSIGNEE_UNASSIGNED) {
    return !item.assignees || item.assignees.length === 0;
  }
  // 'me' resolves to the current user; if we don't know who that is, degrade
  // to a no-op rather than hiding everything (mirrors `filterMine`).
  const target = (assignee === ASSIGNEE_ME ? me : assignee)?.toLowerCase();
  if (!target) { return true; }
  return !!item.assignees?.some(a => a.toLowerCase() === target);
}

function matchesAuthor(item: IssueSearchItem, author: string, me: string | undefined): boolean {
  if (!author) { return true; }
  const target = (author === AUTHOR_ME ? me : author)?.toLowerCase();
  if (!target) { return true; }
  return !!item.author && item.author.toLowerCase() === target;
}

/** Numeric/string sort key per column; `age` uses negated time so larger = older. */
function sortKey(item: IssueSearchItem, column: BacklogSortColumn): number | string {
  switch (column) {
    case 'id': return Number(item.id) || 0;
    case 'title': return item.title.toLowerCase();
    case 'area': return item.area.toLowerCase();
    case 'assignee': return (item.assignees?.[0] ?? '').toLowerCase();
    case 'age': return -(Date.parse(item.createdAt) || 0);
  }
}

function sortBacklog(
  items: IssueSearchItem[],
  column: BacklogSortColumn,
  direction: BacklogSortDirection,
): IssueSearchItem[] {
  const dir = direction === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const ka = sortKey(a, column);
    const kb = sortKey(b, column);
    if (typeof ka === 'string' || typeof kb === 'string') {
      return String(ka).localeCompare(String(kb)) * dir;
    }
    return (ka - kb) * dir;
  });
}

/**
 * Clear any facet selection (area / assignee / author) that references a value
 * no longer present in `items`. When a refresh or Status change drops the
 * previously-selected option, the webview's `<select>` silently falls back to
 * its default ("All"); clamping the host's criteria the same way keeps the
 * rendered rows consistent with what the dropdowns show — otherwise the table
 * stays filtered by a now-hidden value while the dropdown reads "All" (#920
 * Codex review). The `''` / `me` / `unassigned` sentinels are always valid and
 * never cleared.
 */
export function clampCriteriaToDataset(
  criteria: BacklogSearchCriteria,
  items: IssueSearchItem[],
): BacklogSearchCriteria {
  const areas = new Set(items.map(i => i.area));
  const assignees = new Set(items.flatMap(i => i.assignees ?? []));
  const authors = new Set(items.map(i => i.author).filter((a): a is string => !!a));
  const out = { ...criteria };
  if (out.area && !areas.has(out.area)) { out.area = ''; }
  if (out.assignee
    && out.assignee !== ASSIGNEE_ME
    && out.assignee !== ASSIGNEE_UNASSIGNED
    && !assignees.has(out.assignee)) {
    out.assignee = '';
  }
  if (out.author && out.author !== AUTHOR_ME && !authors.has(out.author)) {
    out.author = '';
  }
  return out;
}

/**
 * Filter + sort a backlog-search dataset by the panel's criteria. Scopes
 * (text / area / assignee / author) AND together; sorting is applied last.
 * Empty criteria → every item, sorted. Pure and synchronous.
 */
export function searchBacklog(
  items: IssueSearchItem[],
  criteria: BacklogSearchCriteria,
): IssueSearchItem[] {
  const text = criteria.text?.trim().toLowerCase() ?? '';
  const me = criteria.currentUser?.toLowerCase();
  const filtered = items.filter(item => {
    if (text && !matchesText(item, text)) { return false; }
    if (criteria.area && item.area !== criteria.area) { return false; }
    if (!matchesAssignee(item, criteria.assignee ?? '', me)) { return false; }
    if (!matchesAuthor(item, criteria.author ?? '', me)) { return false; }
    return true;
  });
  return sortBacklog(filtered, criteria.sort ?? 'age', criteria.direction ?? 'desc');
}

/**
 * Compact relative age for the panel's Age column: `today`, `3h`, `5d`,
 * `2w`, `7mo`, `1y`. `now` is injectable so tests stay deterministic. Returns
 * `''` for an unparseable timestamp.
 */
export function formatAge(createdAt: string, now: number = Date.now()): string {
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) { return ''; }
  const sec = Math.max(0, (now - then) / 1000);
  const days = sec / 86400;
  if (days < 1) {
    const hours = Math.floor(sec / 3600);
    return hours < 1 ? 'today' : `${hours}h`;
  }
  if (days < 7) { return `${Math.floor(days)}d`; }
  if (days < 30) { return `${Math.floor(days / 7)}w`; }
  if (days < 365) { return `${Math.floor(days / 30)}mo`; }
  return `${Math.floor(days / 365)}y`;
}
