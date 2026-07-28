# Phase 6 — rebuttal, iteration 2

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 2 | 2 | 0 |
| Claude | (pending at fix time) | — | — | — |

## CX-1 — T7's `references` exemption defeats single-owner enforcement

Accepted, and it clarifies Phase 7's contract usefully: a well-formed
reference points at the owner **without reproducing the rule text**, so it
never trips the class pattern. Exempting `references` surfaces from the
pattern check therefore had it exactly backwards — a full restatement on a
referenced surface (the thing T7 exists to catch) would have passed. The
exemption is removed; automated non-scar classes now match on exactly the
owner. Consequence recorded for Phase 7: reference lines must be phrased so
they don't reproduce the pattern (or patterns chosen to match the full form
only) — the enforcement now makes that a hard requirement rather than a style
preference.

## CX-2 — missing boundary/surface files skipped silently

Accepted — a fail-fast violation on my part. A typo'd, renamed, or deleted
boundary file would have quietly shrunk the scan while T12 stayed green,
which is precisely the completeness guarantee M1 exists to give. Fixed twice
over: `extractCandidates` now throws loudly on any missing boundary file
(with a message naming the fix), and `validateMap(map, root)` verifies every
boundary and surface path exists. A new test seeds a nonexistent boundary
entry and asserts the loud failure.

Full suite: 3,746 passed, 0 failures.
