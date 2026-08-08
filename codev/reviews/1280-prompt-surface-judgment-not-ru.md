# Review: Spec 1280 — prompt-surface, judgment not rules

Closes #1280

## Summary

Rewrote Codev's always-on prompt surface from *rules* to *judgment*, following the seven principles
of the "judgment not rules" blog post. Ten implement phases across both trees (`codev/` +
`codev-skeleton/`): CLAUDE/AGENTS + skills, the three roles, ten `protocol.md`, nine
`builder-prompt.md`, the SPIR/ASPIR/PIR phase prompts, the light-protocol phase prompts + SPIR
templates, all consult-types, the scar-rule registry, and the deletion of the dead
`porch/prompts/` tree. The always-on builder surface (spir, I=10) fell **34,231 → 18,233 words
(−47%)** and the total authored surface **153,205 → 106,032 (−31%)**, with **every capability
preserved** (M5) and **every principle conformance inspected** by the architect (M11).

**Acceptance basis (charter amendment, 2026-08-01): principle conformance is pass/fail; size is
reporting-only.** No word target was chased. A file conformant at more words passes.

## Spec Compliance

- **P1 (rules → contract)** — procedure narration became "what must be true when you finish"
  contracts across every prompt. Every remaining rule is one a frontier model would get wrong
  without it (scope restrictions, single-pass consultation semantics, gate-not-prose merge auth).
- **P2 (examples → interfaces)** — annotated example templates became heading interfaces
  (spec.md 632→246, plan.md 649→201, review.md 641→293); "include examples" lines deleted.
- **P3 / P4 (progressive disclosure / stop repeating)** — CLI how-tos and worktree recipes relocated
  to skills; repeated prohibitions (git-add, flaky tests, consult, status.yaml) dropped from prompts
  where `roles/builder.md` now owns them. **Proven relocation, not deletion (M0c):** the skills
  component *grew* 42→46 files (+4,516w) while everything else shrank.
- **P5 (auto-memory)** — declared N/A project-wide (no auto-memory surface in Codev's prompts).
- **P6 (rich references)** — prose restating machine-readable truth became references: the plan
  template points at its phases-JSON, `spec-review` points at the delivered spec template instead of
  hardcoding its heading list.
- **P7 (unhobbling) + the scar exception** — defensive padding for weaker models deleted, **except
  the eight ratified scar rules**, kept verbatim and now enforced by the rebuilt registry + T4.
- **M5 (no capability lost)** — `extract-capability-inventory.sh` vs the frozen Phase-0 inventory:
  no gate/check/signal present in the Phase-0 served prompts is absent post-rewrite. See
  `codev/resources/1280-measurement-report.md`.
- **M6 (dead-tree removal)** — `codev-skeleton/porch/prompts/` (10 files) deleted after an
  untruncated repo-wide search confirmed no runtime consumer.
- **M10 (retirements)** — six retirements, each with an originating spec, a behaviour-survival
  analysis, a replacement guard, and architect/human approval, in `codev/resources/1280-retirements.md`.
- **M11 (per-file manifest inspection)** — a manifest per implement phase; the architect inspected
  the old-vs-new diff of every changed file.

## Consultation Feedback

This project ran under **architect M11 inspection + a human-gated retirement model**, not porch's
per-phase 3-way consultation. The architect inspected each phase's manifest and independently
re-ran the guard suite; Waleed made every retirement decision. The equivalent adversarial pressure
came from the test suite: ~4,180 assertions, including per-file guards (bugfix-685 close-keywords,
bugfix-742 protocol divergence, #335 CMAP ordering, template-delivery, review-prompt-routing,
baked-decisions, and the T4 scar registry), each of which caught real regressions during the
rewrite (documented in the phase manifests and the thread).

### Integration review (PR #1362, 2-way CMAP — codex REQUEST_CHANGES / claude COMMENT)

The architect ran a 2-way CMAP at the PR and verified each finding against the worktree. Four
pre-merge findings, all **Addressed** (commit `f81d4720`):

- **Addressed** — merge-ownership contradiction: `spir/aspir review.md` said "do not merge your own
  PR (the architect integrates)", contradicting `roles/architect.md`. Reconciled to "merge your own
  PR only after the human approves the `pr` gate".
- **Addressed** — gate-ownership scoping: `builder.md`'s "you run `porch approve`" now defers to the
  protocol's prompts on who types it (PIR routes it to the human reviewer).
- **Addressed** — RESEARCH json/md disagreement: `protocol.json` runs `models: ["codex"]` for
  investigation while the prose promised three; the prose now defers to the embedded state machine as
  authoritative and states the current reduced reality (agy/hermes lanes degraded).
- **Addressed** — `CLAUDE.md`/`AGENTS.md` named `team` + `forge` skills that don't ship (#1318 drift);
  dropped, so the new prose stops making an active false claim to adopters.

The T9/T10 deferrals were **ruled acceptable** as documented (they run at integration / local-install,
alongside 1307's verify probes). The codex "replacement-guard recreates a freeze" critique was
accepted-by-design: the freeze now ships *with* its documented retirement path. Non-blocking
follow-ups filed: `release/protocol.md` staleness and a maintain/templates two-tree divergence.

## Retirements (M10)

Six, all in `codev/resources/1280-retirements.md`:
- **R1** — pure-addition guard on the three builder-prompts (Spec 746). Approved 2026-08-01.
- **R2** — same guard on the two SPIR/ASPIR `specify.md`. Approved by Waleed 2026-08-04.
- **R3** — same on `air/implement.md` (last PHASE_2 file). Approved by Waleed; the approval also
  **pre-approved the class** for the remaining PHASE_3 retirements on three binding invariants
  (behaviour grep green, replacement guard shipped, full audit trail).
- **R4** — spir `spec-review`/`plan-review` (first PHASE_3 files). Class-approved.
- **R6** — the last four PHASE_3 files (aspir spec/plan-review, air impl/pr-review). Class-approved.
- **R5** — the repo-wide manifest-completeness CI scan (T16), removed by Waleed's ruling because it
  taxed concurrent PRs (it forced #1330 to strip edits). The manifests and the M11 inspection
  contract survive; only the CI tripwire is gone.

Each baked-decisions retirement shipped a **replacement guard** (`spec-1280-prompt-deletion-guard.test.ts`,
post-1280 baselines + inverted anti-vacuity), mutation-verified in both directions.

## Measurement

Full before/after, per-audience, and the M0c relocation proof in
`codev/resources/1280-measurement-report.md`. Headline: builder always-on −47%, architect −66%,
total authored −31%, dead tree −4,009.

## Architecture Updates

No architecture updates needed — Spec 1280 rewrote prompt *content* under a fixed structure; it did
not change any module boundary, the four-tier resolver, porch's planner/executor split, or the
state model. The system-shape facts in `arch-critical.md` are unchanged and still accurate.

## Lessons Learned Updates

Routed **cold** (`codev/resources/lessons-learned.md`): "trust the authoritative source, not the
convenient signal" — a concrete catalog of ~a dozen instances in this project where a convenient
signal (a vacuous green tick, a `pipefail`+`grep -q` pipe, a silent `git checkout`, a case-sensitive
grep, an annotation-in-the-path-cell) disagreed with the authoritative one and was wrong, plus the
two mechanical corollaries (commit→run→read→claim quoting the SHA; mutation-test guards both ways).
The hot tier already carries the principle ("summaries are evidence, not ground truth"), so the
project-specific instances went to cold, respecting the hot-tier cap.

## Deferred to integration (cannot run from a builder worktree)

- **T9 — live spawn probe.** Spawning a builder must happen from the **main workspace root**; doing
  it from inside this worktree would nest builders (a scar rule). Run at integration:
  `afx spawn <id>` on the rewritten surface, confirm the spawn prompt carries the full artifact
  contract and `porch next` returns a well-formed task.
- **T10 — full rollback rehearsal.** Group purity is verified structurally (each phase's rewrite
  commit is `.md`-only, retirements are register + test, replacement guards are baseline + test — no
  commit mixes groups). Actually reverting each rollback group G1–G7 and re-running the suite green
  needs multi-commit reverts across phases and destructive git in the active worktree; run it at
  integration on a throwaway checkout.

## Flaky Tests

No flaky tests encountered. The `packages/codev` suite is deterministic and green at HEAD
(4,184 passed / 48 skipped). The broader monorepo has pre-existing unrelated failures (e.g.
`artifact-canvas` DOMPurify) untouched by this markdown-and-tests-only work.
