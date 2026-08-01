# Plan iteration 1 response — Spec 1280

Codex REQUEST_CHANGES (HIGH, 8) · Claude REQUEST_CHANGES (HIGH, 7). **All accepted; no
disputes.** Both reviewers verified the plan's decision arithmetic independently and both
reproduced 67 — the accounting held; what failed was the *supporting* work riding alongside the
decisions, which the first draft under-specified because it drew boundaries purely by inspection
load.

Two findings were **blocking mechanism gaps** that would have surfaced mid-implementation as
adopter breakage rather than as clean failures.

---

## Blocking mechanism gaps (both reviewers, verified)

### 1. P6's `protocol.json` reference had no adopter-resolvable mechanism

Verified against source: `protocol.md` is inlined at spawn via `{{protocol_reference}}`
(`spawn-roles.ts:112-124`); **`protocol.json` is inlined nowhere** — `spawn-roles.ts:267` reads it
only for validation. In a fresh adopter project `codev/protocols/<p>/protocol.json` does not
exist on disk. So "read `protocol.json`" is exactly the fetch-by-path of a framework file that
CLAUDE.md forbids and the spec's own constraint restates — and it was carrying the largest single
cut in the project.

**Resolved by verifying the resolver rather than guessing**: `resolveCodevIncludes`
(`skeleton.ts:108-119`) is **extension-agnostic**, so `protocol.md` carries a fenced ```json
block containing `{{> protocols/<p>/protocol.json}}`. Resolves through all four tiers, works in
fresh installs, needs **no porch change**, and is the literal expression of P6. Cost stated
honestly (spir +570 words back) — acceptable because size is reporting-only under the amended
charter. New **T18** tests both **strict** and **soft** mode, because the asymmetry is real:
strict-mode builders get checks/gates as porch tasks, soft-mode builders have only the prompt.

### 2. Skill relocation is a FOUR-tree sync the instrument could only see one quarter of

Claude's finding, verified: skills exist in `.claude/skills` (10), `.codex/skills` (10,
**byte-identical**), `codev-skeleton/.claude/skills` (7), `codev-skeleton/.codex/skills` (7) —
with **existing drift** (`afx`, `porch` differ repo-vs-skeleton; `forge`, `skill-creator`, `team`
skeleton-absent). M0(g) counted only `.claude/skills`, so relocating content there would have
left Codex agents and adopters without it **and reported it as deleted** by M0c/T15 — inverting
the project's honesty artifact.

Fixed: Phase 0 widens M0(g) to all four trees; Phase 1 adds **T17** (skills parity) and treats
every relocation as a four-copy write. Pre-existing drift is recorded as known state rather than
silently "fixed" — with the scope question raised for the architect at the gate.

---

## Codex

**Pre-rewrite capability inventory never created — ACCEPTED.** Phase 2 asserted T5 while Phase 9
first extracted the inventory. M5 requires a *committed pre-rewrite* baseline. Moved into Phase 0
(PR-1) and frozen there; every later phase asserts against it.

**Post-merge work has no executable home — ACCEPTED.** Added an explicit **verify phase**
section covering M7, M8, M12, T13, T14, `1280-ab-results.md`, and the SHIP/HOLD/ROLLBACK verdict.

**T3, T13, T14, T16 unhomed — ACCEPTED.** T3 and **T16** into Phase 0 — T16 especially, since it
is the mechanical guard on M11 and must exist *before* Phase 1 produces the first manifest. T13
and T14 into verify. Manifest format and location now specified.

**"≤12 batches" didn't count supporting changes — ACCEPTED, and it would have broken the
architect's own mandate.** Added an explicit definition: a **review batch** is every distinct file
the architect reads, including tests, registry and retirements. Phases 4 and 9 now declare **two
batches each**.

**Scar-test sequencing contradictory — ACCEPTED.** Phase 1 asserted T4 while Phase 8 created it.
Phase 1 now verifies the eight canonicals byte-for-byte against the ratified
`builder/spir-1252:scar-rules.yaml` directly; T4 is created in Phase 9 and applies from there.

**Grouped rollback not achievable from the proposed commits — ACCEPTED** (Claude found the same
from the mapping side). Resolved with a commit-level invariant: **every commit is group-pure**;
phases may span groups and now declare them. M6's dead-tree deletion assigned to **G4**. T10
rehearses **every** group touched, not a sample.

**PR-1 mechanics unstated — ACCEPTED.** Added: branch cut, merge wait, re-branch via
`git fetch origin main && git checkout -b … origin/main` (never `git checkout main` from a
worktree), `porch done --pr` / `--merged` recording, and a duplicate-commit check.

---

## Claude

**Rollback mapping contradicted the spec — ACCEPTED.** Phase 1 claimed G2/G6 while rewriting
`roles/builder.md` (spec G3) and `roles/consultant.md` (spec G5); a G3 revert would have pulled
Phase 1 work out and T10 would have rehearsed the wrong map. Roles now live in their own phase
with **three group-pure commits** (G6/G3/G5).

**M10 concentrated in one phase but collisions are spread — one misassigned — ACCEPTED,
verified.** `spec-1273-wait-discipline-docs.test.ts:26` targets `codev/roles/builder.md` + its
skeleton twin → breaks in the **roles** phase, not the builder-prompt phase; line 31 targets
`.claude`/`.codex` `afx/SKILL.md` → breaks in **Phase 1** on relocation.
`bugfix-742-consult-templates.test.ts:25-28` pins spir *and* bugfix consult-types → Phases 7 and
8. M10 is now a per-phase deliverable, assigned where each collision actually lands.

**No per-phase green-suite requirement — ACCEPTED.** The branch could have sat red across eight
review batches while the architect inspected diffs on a broken tree. Every phase now ends green,
and it is in Success Metrics.

**Reconcile "~66" vs 67 — ACCEPTED.** The plan states 67 is correct and notes both reviewers
reproduced it.

**Phase 9 folded review-phase deliverables into an implement phase — ACCEPTED.** Review document
and PR moved out to porch's `review` phase, which would otherwise re-run over them.

---

## Net

Fifteen findings, none disputed. The plan's decision accounting survived both reviews intact;
everything that failed was work that *accompanies* the decisions — tests, inventories, group
purity, sync obligations — which is exactly what a plan drawn by inspection load will
under-specify if nobody checks. Phase count 10 → 11, with two phases now carrying explicit
double batches.
