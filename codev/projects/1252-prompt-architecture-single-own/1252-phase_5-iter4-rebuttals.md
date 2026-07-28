# Phase 5 — rebuttal, iteration 4

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 3 | 3 | 0 |
| Claude | APPROVE | 0 | — | 0 |

## CX-1/CX-2 — the "bypass checks" variant survived on 11 files; sweep blind to it

Accepted. The flaky-test sections' "**DO NOT** edit `status.yaml` to bypass
checks" is the same prohibition in context clothing, and my convergence sweep
missed it because I grepped for the rule's phrasings, not the *act's*
phrasings. All 11 files converged to the canonical (the numbered-list prefix is
line-exact-compatible), the variant added to the stale sweep, and the newly
canonical-carrying files registered (spike builder-prompt — previously missing
from R5 entirely — plus porch/spir/aspir implement prompts).

## CX-3 — arch-critical exclusion resolved by restructuring, not by defending the exception

Accepted, with a better fix than either keeping or forcing the exception. The
hot tier's "Two trees … Mirror every framework change in BOTH" fact has been
**factually false since Phase 4** (there is no second tree to mirror for
protocols/roles). Rewriting it to the post-1252 truth — skeleton is the single
owner, drift fails CI — and folding the CLAUDE/AGENTS identity invariant into
it freed one slot under the ≤10-fact cap. The porch fact split, and the R5
canonical now stands line-exact on its own fact line. arch-critical is
re-listed under `no-hand-edit-status`; the exclusion comment is gone.

This pulls a sliver of Phase 8's C6 rewrite forward. Justified: Codex forced
the arch-critical structure question now, and the alternative was defending a
registry exception built on a stale fact. Caps verified: 10 facts, 33 lines.

Fixtures re-pinned (manifest ×10, snapshots ×9, baselines ×3).
Full suite: 3,734 passed, 0 failures.
