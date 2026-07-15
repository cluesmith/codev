/**
 * Builder-grouping strategies — the swappable axis the Builders tree groups by
 * (#952). Each axis (`stage` | `area`) is one `BuilderGrouping` instance that
 * owns everything that varies per axis: how builders bucket into groups, the
 * complementary-axis row prefix, and whether a lone `Uncategorized` group
 * flattens. The provider holds one strategy per axis and delegates to the
 * active one, so there is no per-mode branching smeared across the view —
 * adding an axis is one more strategy object.
 *
 * Pure / vscode-free, so the strategies are unit-testable under the vitest
 * harness.
 */

import type { OverviewBuilder } from '@cluesmith/codev-types';
import { UNCATEGORIZED_AREA } from '@cluesmith/codev-core/constants';
import { groupByArea } from '@cluesmith/codev-core/area-grouping';
import { groupByStage, stageForPhase } from '@cluesmith/codev-core/phase-grouping';

/** The grouping axes the Agents view offers. Persisted as `codev.buildersGroupBy`. */
export type BuildersGroupBy = 'stage' | 'area' | 'architect';

/** A display group: a header key (an area name or a stage name) and its builders. */
export interface BuilderGroup {
  key: string;
  items: OverviewBuilder[];
}

/**
 * One grouping axis, bundling the things that vary per axis so they can't
 * drift out of sync.
 */
export interface BuilderGrouping {
  /** Axis id, matching the `codev.buildersGroupBy` setting value. */
  readonly id: BuildersGroupBy;
  /**
   * Bucket already-ordered builders into display groups (header order preserved).
   *
   * `roster` is the set of registered architect names (from `OverviewData.architects`),
   * used only by the architect axis to emit a header for every architect — including
   * childless ones (Issue 1174). The stage and area axes ignore it: their groups are
   * builder-intrinsic (a phase / an area only exists as a property of a builder), so
   * there is no "empty stage" or "empty area" to seed.
   */
  group(ordered: OverviewBuilder[], roster?: readonly string[]): BuilderGroup[];
  /**
   * The row prefix for this axis — the COMPLEMENTARY axis to the group header,
   * already bracketed with a trailing space (or `''` when omitted). Stage mode
   * shows the `area/*` label; area mode shows the coarse `protocolPhase`.
   */
  rowPrefix(b: OverviewBuilder): string;
  /**
   * Whether a single `Uncategorized` group should flatten to root rows. True for
   * area mode (a repo not using `area/*` labels gains nothing from one header);
   * false for stage mode (the stage axis always applies).
   */
  readonly flattenLoneUncategorized: boolean;
}

/**
 * Stage axis (the action axis, default): groups are canonical lifecycle stages;
 * the row prefix carries the complementary `area/*` label (Uncategorized omitted).
 */
export function stageGrouping(): BuilderGrouping {
  return {
    id: 'stage',
    group: ordered =>
      groupByStage(ordered, b => b.protocolPhase).map(g => ({ key: g.stage, items: g.items })),
    rowPrefix: b => (b.area && b.area !== UNCATEGORIZED_AREA ? `[${b.area}] ` : ''),
    flattenLoneUncategorized: false,
  };
}

/**
 * Area axis (the domain axis, matching the Backlog view): groups are `area/*`
 * labels; the row prefix carries the complementary coarse `protocolPhase`
 * (empty phase omitted) — the original #810 row form.
 */
export function areaGrouping(): BuilderGrouping {
  return {
    id: 'area',
    group: ordered =>
      groupByArea(ordered, b => b.area).map(g => ({ key: g.area, items: g.items })),
    rowPrefix: b => (b.protocolPhase ? `[${b.protocolPhase}] ` : ''),
    flattenLoneUncategorized: true,
  };
}

/**
 * Architect axis (Issue 1104): groups are the workspace's architects, `main`
 * first, then the rest alphabetically. Every registered architect in `roster`
 * gets a header even when it currently owns no builders (Issue 1174) — a
 * childless architect renders as `MAIN (0)` with the same click-to-open-terminal
 * affordance the populated headers carry, so cleaning up an architect's last
 * builder no longer makes its row vanish out from under the user mid-session.
 * (The `roster` reflects live-session architects from `OverviewData.architects`;
 * when it is absent — e.g. pre-roster callers — only architects owning builders
 * appear, the pre-1174 behavior.)
 *
 * Every builder has an owner: `afx spawn` always records one, defaulting to
 * `main` (spawn.ts). A null `spawnedByArchitect` is only a data-integrity edge
 * (a discovered worktree with no `state.db` row, or a pre-#755 legacy row), so
 * there is no "unassigned" group — a null owner folds into `main`, matching the
 * affinity router's same fallback (`lookupBuilderSpawningArchitect`). A builder
 * whose owner isn't in `roster` (stale / non-live architect) still gets that
 * owner's header from the builder loop, so no builder is ever dropped.
 *
 * The row prefix carries the complementary lifecycle stage (`[implement]`, etc.)
 * so a row still reads "where in the lifecycle" under its owner. A lone group is
 * never flattened — the architect name is information worth a header.
 */
export function architectGrouping(): BuilderGrouping {
  return {
    id: 'architect',
    group: (ordered, roster = []) => {
      const buckets = new Map<string, OverviewBuilder[]>();
      // Seed an empty bucket for every registered architect first, so childless
      // architects still produce a header (Issue 1174).
      for (const name of roster) {
        if (!buckets.has(name)) { buckets.set(name, []); }
      }
      for (const b of ordered) {
        const key = b.spawnedByArchitect || 'main';
        const bucket = buckets.get(key);
        if (bucket) { bucket.push(b); } else { buckets.set(key, [b]); }
      }
      const keys = [...buckets.keys()];
      const ordering = [
        ...(buckets.has('main') ? ['main'] : []),
        ...keys.filter(k => k !== 'main').sort(),
      ];
      return ordering.map(k => ({ key: k, items: buckets.get(k)! }));
    },
    rowPrefix: b => {
      const stage = stageForPhase(b.protocolPhase);
      return stage && stage !== 'unknown' ? `[${stage}] ` : '';
    },
    flattenLoneUncategorized: false,
  };
}
