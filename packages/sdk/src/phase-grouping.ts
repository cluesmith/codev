/**
 * Canonical builder *stages* — the action axis the VSCode Builders tree groups
 * by (#952). Where `area-grouping.ts` buckets by a static domain label, this
 * module buckets by where a builder is in its lifecycle.
 *
 * The key design property is a **closed, fixed stage set**: every protocol's
 * phase ids (the raw `OverviewBuilder.protocolPhase`) fold into one of six
 * canonical stages via `PHASE_TO_STAGE`, rather than each phase id minting its
 * own group. Across the 9 bundled protocols there are ~17 distinct phase ids;
 * mapping them onto six stages caps the Builders tree at seven groups
 * (six stages + `unknown`) **permanently** — a new protocol's phases route into
 * an existing stage (or fall to `unknown` until mapped), so the group count
 * never grows with the protocol catalog.
 *
 * Pure / dependency-free so it can be unit-tested under the vitest harness in
 * the VSCode package, mirroring `area-grouping.ts`.
 */

/**
 * The closed set of canonical lifecycle stages, in the order the action axis
 * reads top-to-bottom. `unknown` is the bounded catch-all for an empty or
 * unmapped `protocolPhase`; it always sorts last.
 */
export type BuilderStage =
  | 'specify'
  | 'plan'
  | 'implement'
  | 'review'
  | 'pr'
  | 'verified'
  | 'unknown';

/**
 * Fixed display order for the stages. `groupByStage` emits groups in exactly
 * this order, skipping stages with no members. NOT alphabetical — the lifecycle
 * sequence (`SPECIFY → PLAN → IMPLEMENT → REVIEW → PR → VERIFIED`) is what makes
 * the view answer "where do I need to act?" at a glance.
 */
export const STAGE_ORDER: readonly BuilderStage[] = [
  'specify',
  'plan',
  'implement',
  'review',
  'pr',
  'verified',
  'unknown',
];

/**
 * Maps every phase id authored across the 9 bundled protocols (spir, aspir,
 * pir, air, bugfix, maintain, experiment, research, spike) onto its canonical
 * stage. Grouping by stage merges same-named phases across protocols (e.g.
 * `implement` from spir/pir/air, `pr` from air/bugfix) into one bucket, which
 * is the intent — "everything at implement" is a protocol-agnostic question.
 *
 * Notable folds:
 *  - `investigate → plan`: treated as pre-build diagnosis (correct for the
 *    common BUGFIX case; RESEARCH's `investigate` approximates here).
 *  - `verify`/`verified`/`complete → verified`: SPIR's in-progress verify phase
 *    and the two terminal synonyms (`complete` is the backward-compat spelling
 *    of `verified`) share one terminal bucket; the row's state icon still
 *    distinguishes an active verify from a finished builder.
 *
 * Adding a protocol with a new phase id: add one entry here. An unmapped id
 * falls through to `unknown` (see `stageForPhase`) rather than expanding the
 * group set — visible under UNKNOWN, never silently dropped.
 */
export const PHASE_TO_STAGE: Record<string, BuilderStage> = {
  // SPECIFY — framing "what are we doing"
  specify: 'specify',
  hypothesis: 'specify',
  scope: 'specify',
  // PLAN — design / diagnosis before building
  plan: 'plan',
  design: 'plan',
  investigate: 'plan',
  // IMPLEMENT — the doing
  implement: 'implement',
  fix: 'implement',
  execute: 'implement',
  maintain: 'implement',
  spike: 'implement',
  // REVIEW — assessing the work
  review: 'review',
  synthesize: 'review',
  analyze: 'review',
  critique: 'review',
  // PR — awaiting merge
  pr: 'pr',
  // VERIFIED — terminal / post-merge (plus SPIR's in-progress verify)
  verify: 'verified',
  verified: 'verified',
  complete: 'verified',
};

/**
 * Canonical stage for a raw `protocolPhase`. Empty string and any unmapped id
 * resolve to `unknown` — the bounded catch-all that keeps the group set fixed.
 */
export function stageForPhase(phase: string): BuilderStage {
  return PHASE_TO_STAGE[phase] ?? 'unknown';
}

/**
 * Bucket items by their canonical stage, returning groups in `STAGE_ORDER`.
 * Empty stages are omitted (a group exists only if ≥1 item maps into it), so
 * the caller renders just the populated stages. Within a group, input order is
 * preserved — the caller has already applied its display-order sort.
 *
 * Pure and generic over the item type, mirroring `groupByArea`. The VSCode
 * Builders tree (`views/builders.ts`) is the first consumer, keying off each
 * builder's `protocolPhase`.
 */
export function groupByStage<T>(
  items: T[],
  getPhase: (item: T) => string,
): Array<{ stage: BuilderStage; items: T[] }> {
  const buckets = new Map<BuilderStage, T[]>();
  for (const item of items) {
    const stage = stageForPhase(getPhase(item));
    const bucket = buckets.get(stage);
    if (bucket) {
      bucket.push(item);
    } else {
      buckets.set(stage, [item]);
    }
  }

  const result: Array<{ stage: BuilderStage; items: T[] }> = [];
  for (const stage of STAGE_ORDER) {
    const bucket = buckets.get(stage);
    if (bucket) {
      result.push({ stage, items: bucket });
    }
  }
  return result;
}
