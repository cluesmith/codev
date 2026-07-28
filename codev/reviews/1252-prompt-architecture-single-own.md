# Review 1252: Prompt Architecture — Single-Owner Rule for Instruction Content

## Outcome: harvested, not merged

The full implementation (8 phases, unanimous CMAP approval at each phase's
final iteration, PR #1278) reached the pr gate and was **deliberately not
merged**. Waleed's charter-level call at the gate: the structural machinery
(shadow-tree deletion, scar registry + CI enforcement, ownership map,
dedup partials) is not worth carrying for *this* surface, because a successor
project will first shrink the surface radically (blog-principles judgment
rewrite; >50% reduction target; frontier-models-only assumption) and
enforcement should be rebuilt fit-for-purpose around the post-shrink surface.
This was a risk/reward re-scope, not a quality verdict — the audit and
measurement work from this project directly shaped the successor's charter.

**What landed on main (this harvest PR):**

- **The 17-file drift reconciliation** — the one live bug. `codev/`'s shadow
  copies synced to the skeleton content, restoring the served SPIR/ASPIR
  builder prompts' `Multi-PR Mechanics` and `Verify Phase` sections and the
  `"Entering verify phase."` notification; architect rulings E1
  (`max_iterations: 3`, decided on the B2 evidence that review rounds run
  1–2) and E2 (check `cwd`s moved to main's `.codev/config.json`
  `porch.checks`; the forked protocol.json files synced) applied. Spec-746
  pure-addition baselines re-derived for the synced files (a frozen-file
  baseline breaks on any legitimate edit — see Lessons).
- **The knowledge artifacts**: `1252-shadow-tree-audit.md` (the 77-row
  classification with rulings), `1252-word-baseline.md` /
  `1252-word-after-phase7.md` (M6/N1 record), `1252-behavior-baseline.md`
  (M12a — B1 51.88% REQUEST_CHANGES over 160 verdicts, with the B5 snapshot),
  the measurement tooling (`scripts/measure-prompt-surface.sh`,
  `packages/codev/src/lib/prompt-behavior-metrics.ts` + CLI + its
  determinism test), this review, and the builder thread
  (`codev/state/spir-1252_thread.md`).

**What stayed on the branch** (`builder/spir-1252`, PR #1278 closed unmerged,
preserved for reference — do not delete): shadow-tree deletion + equivalence
proofs, scar registry + line-exact T6 enforcement, ownership map + T12
completeness machinery, dedup partials + served-surface guard, CLAUDE.md
restructure, all skeleton edits, and their ~15 test suites. **The scar-registry
concept and the eight ratified rule wordings move into the successor charter**
— they are deferred, not discarded.

## Summary of the full implementation (for the record)

Issue #1252 asked for a single-owner rule with an inventory before
restructuring. Measurement reshaped the problem: the largest duplication axis
was a 77-file shadow tree under `codev/protocols|roles|consult-types` that
outranked the installed skeleton in the resolver and had drifted in 17 files —
including the served SPIR builder prompt, missing its entire `Verify Phase`
section. The project filed to fix prompt drift was itself spawned with a
drifted prompt, and the existing detector (#1210) had been reporting the
problem to `codev doctor`, unread, the whole time.

The eight phases (all on the reference branch): drift CI gate + baselines;
77-row local-unique audit with TS1–TS4 terminal states and 4 architect-ruled
escalations; the 17-file reconciliation; shadow-tree deletion with
three-layer equivalence proof (resolver tier, byte-identical assembly across
nine protocols, spawn wrapper — which had instructed builders to read a
deleted role path, a live #1011-class bug); eight compressed scar rules with
line-exact enforcement; a machine-readable ownership map whose completeness
contract makes new cross-surface duplication fail CI; dedup via shared
partials (served prompts are per-agent delivery — a prose reference would
delete content from agents' context); and governance sync.

**N1, honestly: 21,856 → 20,324 served always-on words = −7.0%** against an
aspirational ≥20%. The repair *added* ~207 served words the prompts were
always supposed to have; D3's promotion of three user-global scar rules added
~120; the remaining surface is single-owned prose whose largest block
(protocol.md, 3,703 words) was protocol semantics — a spec Non-goal. That
decomposition is exactly why the successor pivots to shrinking the surface
itself before rebuilding enforcement.

## Architecture Updates

The harvest changes no architecture: it syncs shadow-copy *content* to what
the skeleton already ships and lands record-keeping artifacts. The
resolver, the shadow tree's existence, and all governance docs remain as on
main. (The branch's arch-doc rewrites — C6 retirement, single-owner
invariant, glossary corrections — apply to a world where the deletion merged;
they stay with the branch and inform the successor.)

One architectural *fact* the audit established that main's docs do not yet
state: `copyProtocols`/`copyRoles` in `scaffold.ts` are vestigial (uncalled by
init/adopt/update), so fresh adopters have no shadow tree — this repo's was a
historical artifact. Recorded here for the successor rather than edited into
arch.md out-of-band.

## Lessons Learned Updates

Not routed into the shared lessons docs (those edits stayed with the branch);
recorded here for the successor and for MAINTAIN to promote as it sees fit:

- **A detector that reports without failing is a detector nobody reads.**
  #1210 saw this drift for months; Spec 746's comments described it
  ("PRE-EXISTING and not Phase 1's responsibility") before stepping around
  it. Detection was never the gap — consequence was.
- **Frozen-file baselines are drift bombs.** Spec 746's pure-addition
  baselines froze then-drifted files; the legitimate reconciliation broke
  them twice (branch and harvest). Derive baselines from current content
  minus the asserted insertion instead of freezing snapshots.
- **The corpus is live — a baseline can measure itself.** This project's own
  review verdicts contaminated its behavioural baseline (160 → 163) and its
  thread file contributed a scar-mining hit; self-exclusion
  (`SELF_PROJECT_DIR` / `SELF_FILE_PREFIXES`) had to be built in.
- **"The data exists" ≠ "the metric resolves."** B2 as first specified
  ("rounds to unanimous approve") could never resolve: 0 of 48 terminal plan
  phases end unanimously — porch advances on rebuttal.
- **Served surfaces dedup by include, not by reference** — each agent sees
  only its own prompt; and the measurement must count expanded words or the
  metric rewards moving text between files.
- **Sweep-scope failures dominated review iterations**: fixing the flagged
  instance instead of the class, grepping for a rule's wording instead of the
  act's, repointing a path while preserving the fetch instruction.
- **Gate-rejection counts are not minable** from committed history (no
  `rejected` state exists; `requested_at` is overwritten) — a porch
  gate-event append-log would fix this (MAINTAIN candidate).

## Deviations from the Plan

The implementation deviations (metrics-script location, B2 redefinition,
escalation-deadline correction, reference→include model, T13(b)
rescheduling) are recorded in the phase rebuttals on the branch. The terminal
deviation is this outcome itself: plan phases 4–8's deliverables were built,
reviewed, and then deliberately left unmerged by the pr-gate decision.

## Flaky Tests

None skipped, in either the branch suite (3,744 green at close) or the
harvest suite.

## Verify Phase

The original verify plan (T13(b) spawn probe + M12b behavioural comparison
with rollback triggers) applied to the unmerged machinery and does not run.
The behavioural baseline remains valid as the **pre-successor** measurement:
the successor project should treat `1252-behavior-baseline.md` (B1 51.88%,
n=160, self-excluded) as its "before" and re-run
`packages/codev/scripts/measure-prompt-behavior.ts` after its rewrite lands.

## Follow-ups

- **Successor project** (charter held by Waleed): radical surface shrink
  (blog-principles judgment rewrite, >50% target, frontier-models-only),
  then fit-for-purpose enforcement; **carries forward the scar-registry
  concept and the eight D3-ratified rule wordings**, the ownership-map
  design, and this project's audit + baselines.
- #1276 (multi-model tiering) and #1277 (controlled A/B eval) — filed during
  Phase 8; both now feed the successor rather than this branch.
- Reference branch: `builder/spir-1252` (PR #1278, closed unmerged) — the
  complete machinery with its review history, preserved until cleanup is
  ordered.
