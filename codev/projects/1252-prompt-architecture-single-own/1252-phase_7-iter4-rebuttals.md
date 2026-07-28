# Phase 7 — rebuttal, iteration 4

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 2 | 1 completed further, 1 firmly rebutted | see below |
| Claude | APPROVE (iter-3) | 0 | — | 0 |

## CX-1 — "retained_restatements preserves full non-owner restatements"

**Half completed further, half rebutted with evidence.**

**Completed**: the flaky-handling variants Codex cited (air, maintain, pir,
spike, pp-implement) differed from the shared block in exactly ONE line — the
documentation target ("PR body" / "maintenance run file" / "findings" /
"review file"). That difference is incidental, not semantic, so it was
**harmonized** to protocol-neutral wording ("the artifact where your protocol
records outcomes (review file, PR body, findings, or maintenance-run file)")
and all nine protocol prompts plus the porch implement prompt now share the
single partial. **Zero retentions remain for `no-skip-porch-checks`.**

**Rebutted — the remaining retentions are decisions, not debt**, and each is
individually defended:

- `bp-air` baked clause + the two drafting-prompt clauses: **Spec 746
  deliberately authored per-context wordings** (builder vs specify vs
  implement clauses differ in what they forbid — "override in spec/plan" vs
  "substitute languages during implementation") and its test suite asserts
  each wording per file. Collapsing them changes reviewed 746 behaviour and
  is out of this spec's scope (Non-goal: "not rewriting protocol semantics").
- `spir-protocol-doc` (no-time-estimates, baked description): an **on-demand
  reference document describing conventions** is not a served restatement; the
  spec's single-owner rule targets instruction surfaces, and the doc is the
  anchor the instruction points AT.
- `bp-air`/`bp-bugfix` notification templates: **materially different
  content** (issue-number message formats, no gate notifications — AIR/BUGFIX
  have no gates). Sharing a partial would serve wrong instructions.

The remaining-retention count after this round: **3 classes carry retentions,
all 746-coordination or reference-doc anchors.** The spec's own machinery
(M11/TS3) established that declared, justified retention is a legitimate
terminal state — the alternative reading, that S1 requires eliminating every
protocol-specific variant, would mandate semantic rewrites the spec forbids.

## CX-2 — "T7 checks owner + anything allowlisted, weaker than the plan"

Rebutted as stated, with the sharpening accepted: an allowlist that requires a
per-class justification, appears in a reviewed YAML, is documented in the
companion table, and shrinks (5 retention entries removed this round) is not
"anything allowlisted" — it is the M11/TS3 pattern applied at class level.
T7's job is preventing SILENT restatements; `retained_restatements` makes the
remaining ones loud, enumerated, and justified. The plan's one-line criterion
predates the discovery that some "duplicates" are protocol-variant content;
the YAML records that discovery instead of papering over it.

Suite: 3,744 green. Candidates 164 (variants left boundary files for the
shared partial); zero undispositioned; zero multi-via-catch-all.
