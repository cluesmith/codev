# Phase 7 — rebuttal, iteration 3

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 2 | 2 | 0 |
| Claude | (iter-1 re-run raced the fixes; current-round verdict pending) | — | — | — |

## CX-1 — partials excluded from the inventory boundary

Accepted — a completeness hole of exactly the shape M1 exists to close: the
phase moved canonical text into `codev-skeleton/partials/` and then didn't
scan them, so new normative text added to a partial would have bypassed
extraction entirely. All ten partials are now in `inventory_boundary`; their
lines route through the existing class dispositions (169 candidates, zero
undispositioned, zero multi-file-via-catch-all).

## CX-2 — cap-only guard lets a vanished rule pass (n=0)

Accepted — the worst failure mode (a broken `{{> ...}}` silently deleting a
rule from served prompts) was exactly the one not covered. The guard now
asserts **presence derived from the include graph**: for each automated class
owned by a partial, every protocol whose builder-prompt reaches that partial
(directly or one nested level) must serve the pattern in at least one mode
render. Both modes are rendered because conditional blocks
(`{{#if mode_soft}}`) legitimately gate content per mode — presence holds over
the union, the over-serve cap per render. A broken include now fails with a
message naming the suspicion.

Note on the Claude column: the iteration-1 re-run completed after this round's
fixes were already committed and reviewed a mid-fix snapshot (its two issues —
served-guard multiplicity and a stale manifest — were the very things fixed in
iteration 2). The current-round Claude verdict is in flight against HEAD.

Full suite: 3,744 passed, 0 failures.
