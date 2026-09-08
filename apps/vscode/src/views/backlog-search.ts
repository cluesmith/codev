import type { OverviewBacklogItem, OverviewData } from '@cluesmith/codev-types';
import { spawnableBacklog } from './backlog-filter.js';

/**
 * A backlog row projected for the Search Backlog Quick Pick.
 *
 * Structurally a `vscode.QuickPickItem` (`label` + optional `description`)
 * plus the `issueId` we need to open the selection. Defined here — in a
 * vscode-free file — so the projection logic can be unit-tested from the
 * vitest harness without dragging in the `vscode` module, mirroring the
 * `backlog-filter.ts` pattern.
 */
export interface BacklogQuickPickItem {
  label: string;
  description: string;
  issueId: string;
}

/**
 * Spawnable backlog items in the same display order the Backlog tree uses —
 * items assigned to the current user first, then the rest, preserving Tower's
 * order within each segment.
 *
 * Unlike `BacklogProvider.orderedSpawnable`, this deliberately does NOT apply
 * the mine-only filter: search is a discovery affordance over the FULL backlog
 * (issue #918, decision 1). When `currentUser` is unavailable the mine-first
 * split is a no-op, so the list degrades to plain Tower order — same as the
 * tree behaves in that state.
 */
export function orderForSearch(
  data: Pick<OverviewData, 'backlog' | 'currentUser'>,
): OverviewBacklogItem[] {
  const me = data.currentUser?.toLowerCase();
  const isMine = (item: OverviewBacklogItem) =>
    !!me && !!item.assignees?.some(a => a.toLowerCase() === me);

  const items = spawnableBacklog(data.backlog);
  const mine = items.filter(isMine);
  const rest = items.filter(item => !isMine(item));
  return [...mine, ...rest];
}

/**
 * Project ordered backlog items into Quick Pick rows.
 *
 * - `label`: `#<id> <title>`
 * - `description`: `<area> · <age>` and, when the issue has an assignee,
 *   ` · @<assignee>`.
 *
 * `now` is injected so the relative-age string is deterministic in tests.
 */
export function toQuickPickItems(
  items: OverviewBacklogItem[],
  now: number,
): BacklogQuickPickItem[] {
  return items.map(item => {
    const parts = [item.area, relativeAge(item.createdAt, now)];
    const assignee = item.assignees?.[0];
    if (assignee) { parts.push(`@${assignee}`); }
    return {
      label: `#${item.id} ${item.title}`,
      description: parts.join(' · '),
      issueId: item.id,
    };
  });
}

/** Target of a dynamic type-ahead row in the Search Backlog Quick Pick. */
export type DynamicPickTarget = 'issue' | 'pr';

/**
 * A dynamic `View Issue #N` / `View PR #N` row (issue #1179), prepended to the
 * Quick Pick when the typed value matches the numeric grammar. `alwaysShow`
 * exempts the row from VS Code's fuzzy filter: the label is synthesized from
 * the input, so filtering it against that same input is meaningless and (for
 * forms like `view pr 1350`) would hide it. The discriminator is named
 * `target` because `QuickPickItem` reserves `kind` for its separator enum.
 */
export interface DynamicQuickPickItem {
  label: string;
  description: string;
  alwaysShow: true;
  target: DynamicPickTarget;
  id: string;
}

const BARE_ID = /^#?(\d+)$/;
const TYPED_ID = /^(?:view\s+)?(issue|pr)\s+#?(\d+)$/i;

/**
 * Parse the Quick Pick's typed value against the dynamic type-ahead grammar:
 *
 * - `1350` / `#1350` (bare id) is ambiguous, so both targets are offered,
 *   issue first.
 * - `issue 1350` / `view issue 1350` names the target explicitly; likewise
 *   `pr 1350` / `view pr 1350`. Case-insensitive, leading `#` on the number
 *   tolerated (the `parseIssueId` convention).
 * - Anything else (non-numeric, trailing text, bare keyword) yields no
 *   dynamic rows: the input is an ordinary text search over the static rows.
 */
export function parseSearchDynamicQuery(
  value: string,
): Array<{ target: DynamicPickTarget; id: string }> {
  const trimmed = value.trim();
  const bare = BARE_ID.exec(trimmed);
  if (bare) {
    return [{ target: 'issue', id: bare[1] }, { target: 'pr', id: bare[1] }];
  }
  const typed = TYPED_ID.exec(trimmed);
  if (typed) {
    return [{ target: typed[1].toLowerCase() as DynamicPickTarget, id: typed[2] }];
  }
  return [];
}

/** Project the parsed dynamic grammar into ready-to-insert Quick Pick rows. */
export function toDynamicQuickPickItems(value: string): DynamicQuickPickItem[] {
  return parseSearchDynamicQuery(value).map(({ target, id }) => {
    let noun: string;
    if (target === 'issue') {
      noun = 'Issue';
    } else {
      noun = 'PR';
    }
    return {
      label: `View ${noun} #${id}`,
      description: 'Open in browser',
      alwaysShow: true,
      target,
      id,
    };
  });
}

/**
 * Relative age of an ISO timestamp, e.g. `3d ago`. Same granularity ladder as
 * `commands/view-artifact.ts`'s helper. Returns an empty string for an
 * unparseable / missing timestamp so the description degrades gracefully.
 */
function relativeAge(createdAt: string | undefined, now: number): string {
  if (!createdAt) { return ''; }
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) { return ''; }
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) { return `${seconds}s ago`; }
  if (seconds < 3600) { return `${Math.floor(seconds / 60)}m ago`; }
  if (seconds < 86400) { return `${Math.floor(seconds / 3600)}h ago`; }
  return `${Math.floor(seconds / 86400)}d ago`;
}
