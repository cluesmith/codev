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
import { groupByStage } from '@cluesmith/codev-core/phase-grouping';

/** The grouping axes the Builders view offers. Persisted as `codev.buildersGroupBy`. */
export type BuildersGroupBy = 'stage' | 'area';

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
  /** Bucket already-ordered builders into display groups (header order preserved). */
  group(ordered: OverviewBuilder[]): BuilderGroup[];
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
