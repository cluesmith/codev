# Phase 4 — rebuttal to iteration-1 implementation review

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 3 | 3 | 0 |
| Claude | APPROVE | 1 minor (overlaps Codex #3) | 1 | 0 |

**Nothing disputed.** Codex's first finding deserves the plain admission: I
delivered less than my own plan promised — a plan line I myself wrote after
Codex caught exactly this gap at plan review.

## CX-1 — assembled-prompt equivalence was inferred, not exercised

The plan (amended at plan review, at Codex's insistence) says: *"Assemble the
builder spawn prompt for each protocol before deletion, snapshot it, then
assert the post-deletion assembly is byte-identical."* What I shipped instead
was an argument: resolved-content hashes match, `renderTemplate` is pure,
therefore prompts are equal. The argument happens to be sound — but it tests
the premises, not the conclusion, and it would miss exactly the failures M10
exists to catch: `buildPromptFromTemplate` picking a different template path,
`resolveCodevIncludes` behaving differently against the post-deletion tree, or
any assembly-layer change between snapshot and check.

**Fixed — the real path is now exercised.** The pre-deletion tree was
reconstructed from git (`git archive` of the deletion commit's parent), the
genuine `buildPromptFromTemplate` ran against it for all nine protocols with a
fixed `TemplateContext`, and the outputs are committed as
`fixtures/prompt-snapshots/<protocol>.txt` (spir's is 30,593 bytes — the full
inlined protocol reference included). The test re-runs the same assembly
against the live tree and requires byte-identical output.

## CX-2 — resolution tier was not asserted

Correct: I checked *what* content resolves, not *where from*. A content match
served from some unexpected tier would have hidden a resolution bug behind a
green test.

**Fixed**: the equivalence test now asserts
`path.resolve(resolved) === path.resolve(getSkeletonDir() + rel)` for every
deleted path — content AND tier.

## CX-3 — bugfix-685's parity became file-vs-itself (Claude concurring, as "minor")

Correct, and a fair consequence of my mechanical repoint: mapping both sides
of a mirror pair to the skeleton leaves a comparison of a file with itself —
a test that can never fail, which is worse than no test (it *looks* like
coverage).

**Fixed**: bugfix-685's target list collapsed to a single skeleton list and the
parity test was **removed** with a comment explaining why (no second tree
exists; drift of these prompts is now impossible by construction, and the
grep-regression assertions retain all real value). The same treatment was
applied to `baked-decisions.test.ts`'s Baked-Decisions parity describe — not
flagged by Codex, but it had the identical defect, and leaving it would have
been fixing the reported instance rather than the reported class. Suite count
drops accordingly (3,746 from 3,767): vacuous tests deleted, not skipped.

Noted for the review doc: Spec 746's parity comment explicitly described the
skeleton-vs-codev drift ("skeleton has Multi-PR Workflow / Verify Phase
sections that codev/ doesn't … PRE-EXISTING and not Phase 1's responsibility")
— the drift this project fixed was *observed and consciously stepped around*
months ago. Detection was never the problem.

## Status

Full suite green: 3,746 passed, 0 failures.
