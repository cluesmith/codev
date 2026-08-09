<!-- Spec 1280 Phase 10 — post-rewrite measurement report. Reproduce: scripts/measure-prompt-surface.sh
     Baseline: codev/resources/1280-word-baseline.md (Phase 0, commit 5c962b7a, pre-rewrite).
     Size is REPORTING-ONLY under the 2026-08-01 charter amendment — acceptance is principle
     conformance (M11) + capability preservation (M5), not any word target. This report exists to
     make the change visible and to prove relocation (M0c), not to claim a number was hit. -->
# Spec 1280 — prompt-surface measurement: before / after

## Headline audience loads (these overlap by design — never summed)

| Audience | Phase 0 | Post-rewrite | Δ | |
|---|---:|---:|---:|---|
| **Builder (spir, I=10)** — the headline | 34,231 | **18,233** | −15,998 | **−47%** |
| Architect (per session) | 8,599 | 2,960 | −5,639 | −66% |
| Consultant (per review, spir) | 682 | 589 | −93 | −14% |

## Exclusive buckets

| Bucket | Phase 0 | Post-rewrite | Δ |
|---|---:|---:|---:|
| SHARED (CLAUDE.md + transcluded hot tier) | 6,551 | 2,153 | −4,398 |
| ARCHITECT (roles/architect.md) | 2,048 | 807 | −1,241 |
| DEAD (`codev-skeleton/porch/prompts`) | 4,009 | 0 | −4,009 (deleted, M6) |

## Total authored surface — and the relocation proof (M0c)

| Component | Phase 0 | Post-rewrite | Δ |
|---|---:|---:|---:|
| CLAUDE.md + AGENTS.md | 11,630 | 2,834 | −8,796 |
| protocols (both trees) | 88,461 | 50,028 | −38,433 |
| roles (both trees) | 8,274 | 3,814 | −4,460 |
| **skills (all four trees)** | 44,840 (42 files) | **49,356 (46 files)** | **+4,516** |
| **TOTAL_AUTHORED** | 153,205 | **106,032** | −47,173 (−31%) |

**The skills component GREW while everything else shrank.** That is the M0c signal working as
designed: content that left the always-on surface under P3/P4 (CLI walkthroughs, worktree recipes,
tool how-tos) was *relocated* into on-demand skills — four new skill files, +4,516 words — not
deleted. An always-on-only metric would score that relocation identically to a deletion; the
total-authored basis distinguishes them. So the −47% always-on reduction is a mix of genuine prose
deletion (procedure → contract, examples → interfaces) and relocation to look-it-up surfaces.

## Per-protocol (resolved per file, four-tier)

| Protocol | BUILDER_SPAWN (0 → now) | PHASE mean | CONSULT mean |
|---|---|---|---|
| spir | 6,360 → 2,590 | 1,396 → 613 | 430 → 337 |
| aspir | 3,467 → 2,188 | 1,396 → 613 | 430 → 337 |
| pir | 4,801 → 2,107 | 1,435 → 1,411 | 491 → 384 |
| bugfix | 2,965 → 1,812 | 377 → 275 | 683 → 562 |
| air | 3,017 → 1,858 | 456 → 326 | 437 → 374 |
| maintain | 4,158 → 1,730 | 356 → 358 | 406 → 323 |

(PIR's PHASE mean barely moved — its phase prompts were recently rewritten to a similar standard
and were largely load-bearing contract already; a conformant file passes unchanged.)

## Capability preservation (M5)

`scripts/extract-capability-inventory.sh` re-run post-rewrite and compared against the frozen
Phase-0 inventory (`codev/resources/1280-capability-inventory.json`, commit 5c962b7a):
**no gate, check, or signal present in the Phase-0 served prompts is absent post-rewrite.** Every
capability the rewrite preserved is provable in the served text; nothing was silently gutted. The
`{{artifact_name}}` substitution, the `{{> }}` template includes, the phases-JSON plan capability,
the `VERDICT:` consult contract, the PR-body close-keyword heredocs, and all `<signal>` tags survive.
