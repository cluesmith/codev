/**
 * Adjudication allowlist for the shadow-drift CI gate (Spec 1252, M2).
 *
 * The gate (`shadow-drift-gate.test.ts`) fails the build on any `differs`
 * finding from `auditProtocolDrift()` that is not listed here.
 *
 * ## Why this file starts populated
 *
 * At Phase 1 the tree is already dirty: 17 shadow copies drifted from the
 * skeleton, and one of them (`protocols/spir/builder-prompt.md`) is why this
 * project exists — the served SPIR builder prompt lost its `Verify Phase` and
 * `Multi-PR Mechanics` sections. A gate that fails on the commit that
 * introduces it is a gate someone disables, so the known drift is admitted
 * here with an explicit justification and removed in Phase 3.
 *
 * ## Lifecycle (M2, tightened after Gemini's iteration-2 review)
 *
 * Every entry carries a `reason`. Entries whose reason is `PENDING_RECONCILE`
 * MUST be gone once Phase 3 completes — `expectNoPendingReconcileAfterPhase3`
 * in the gate test enforces that, so the allowlist cannot quietly become a
 * permanent exemption. The only residue permitted after Phase 3 is a file with
 * an open M11 escalation (`reason: 'ESCALATED'`), which must cite its
 * adjudication.
 *
 * Do NOT add entries to make a red build green. Adding one is an assertion
 * that a human adjudicated the divergence.
 */

/** Why a drifted shadow copy is temporarily tolerated. */
export type AllowReason =
  /** Known pre-existing drift, to be reconciled in Phase 3 per decision D1. */
  | 'PENDING_RECONCILE'
  /** Local-unique content escalated under M11; awaiting an architect ruling. */
  | 'ESCALATED'
  /** Architect ruled TS3: deliberate codev-only override, kept by decision. */
  | 'TS3_RETAINED';

export interface AllowEntry {
  /** Skeleton-relative path exactly as `DriftFinding.relativePath` reports it. */
  relativePath: string;
  reason: AllowReason;
  /** Free text: for ESCALATED/TS3_RETAINED, cite the adjudication. */
  note: string;
}

/**
 * Phase-1 seeded 17 PENDING_RECONCILE entries (the drift present when the gate
 * was introduced); Phase 3 reconciled 13 of them to the skeleton and removed
 * their entries. What remains is exactly the 4 open M11 escalations.
 *
 * Populated from the audit's own output rather than hand-transcribed from
 * `diff -rq`, because the audit compares against the *installed skeleton*
 * (`getSkeletonDir()`), which is a build-time copy of `codev-skeleton/` — the
 * two can disagree if the skeleton has not been rebuilt.
 */
export const SHADOW_DRIFT_ALLOWLIST: AllowEntry[] = [
  // EMPTY — and staying that way is the point. Phase 3 reconciled 13 rot
  // files; Phase 4 resolved all four escalations by architect ruling
  // (2026-07-28: max_iterations -> skeleton's 3; cwd -> .codev/config.json
  // porch.checks) and deleted the shadow tree. Any future entry requires a
  // human-adjudicated justification.
];

/** Allowlisted paths as a Set, for O(1) gate lookups. */
export const ALLOWLISTED_PATHS: ReadonlySet<string> = new Set(
  SHADOW_DRIFT_ALLOWLIST.map((e) => e.relativePath)
);
