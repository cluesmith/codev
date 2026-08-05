import { UNCATEGORIZED_AREA } from './constants.js';

/**
 * Render an area name as a human-readable group-header label.
 *
 * Display-only. The raw `area` value (the wire string from
 * `OverviewBacklogItem.area` / `OverviewBuilder.area`, or the
 * `UNCATEGORIZED_AREA` sentinel) MUST continue to be used for
 * bucketing (`groupByArea`), id stability, and `===` matchers.
 *
 * Rule: uppercase the entire string. Separators (`-`, `_`) are
 * preserved as-is so the header reads as a single visual token
 * matching VSCode's own container-label convention (EXPLORER,
 * SOURCE CONTROL, etc.). Examples:
 *   'vscode'        -> 'VSCODE'
 *   'cross-cutting' -> 'CROSS-CUTTING'
 *   'front_end'     -> 'FRONT_END'
 *   'Uncategorized' -> 'UNCATEGORIZED'
 *
 * Purely structural: no hardcoded list of "known acronyms". Teams
 * using Codev decide their own labeling semantics; a per-repo
 * override map can be layered on top as a non-breaking extension.
 */
export function uppercaseAreaName(area: string): string {
  return area.toUpperCase();
}

/**
 * Bucket items by their resolved area, returning groups in canonical
 * Codev order: alphabetical specific areas first, then `Uncategorized`
 * last. Within each group, the input order is preserved (the caller
 * has already applied any sort policy — display-order for builders,
 * mine-first for backlog).
 *
 * Pure, generic over the item type. Both `views/backlog.ts` and
 * `views/builders.ts` in the VSCode extension consume this directly,
 * keying off each item's resolved `area` (already projected on the
 * server via `parseArea`; see #819). Future consumers (dashboard
 * equivalents, etc.) reuse the same function so the grouping rule
 * stays byte-shared, not merely prose-described.
 */
export function groupByArea<T>(
  items: T[],
  getArea: (item: T) => string,
): Array<{ area: string; items: T[] }> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const area = getArea(item);
    const bucket = buckets.get(area);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(area, [item]);
    }
  }

  const result: Array<{ area: string; items: T[] }> = [];
  const uncategorized = buckets.get(UNCATEGORIZED_AREA);
  const specifics = [...buckets.keys()]
    .filter(a => a !== UNCATEGORIZED_AREA)
    .sort();
  for (const area of specifics) {
    result.push({ area, items: buckets.get(area)! });
  }
  if (uncategorized) {
    result.push({ area: UNCATEGORIZED_AREA, items: uncategorized });
  }
  return result;
}
