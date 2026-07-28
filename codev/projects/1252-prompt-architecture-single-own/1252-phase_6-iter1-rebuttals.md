# Phase 6 — rebuttal, iteration 1

| Model | Verdict | Issues | Accepted | Disputed |
|---|---|---|---|---|
| Gemini | APPROVE | 0 | — | 0 |
| Codex | REQUEST_CHANGES | 3 | 3 | 0 |
| Claude | (pending at fix time) | — | — | — |

## CX-1 — extractor under-collected (case-sensitive pattern)

Accepted, with Codex's exact example confirmed: lowercase "must stay compliant
with the protocol" was invisible to the extractor. Widened to case-insensitive
must/never/always/do-not/don't. Candidates rose 134 → **190**, surfacing four
new multi-file texts that the catch-all guard immediately flagged — including
three new instruction classes (`multi-pr-mechanics`,
`notify-architect-key-moments`, `soft-mode-protocol-compliance`; classes now
10) and one additional match route into `baked-decisions-handling`. The guard
doing its job on its first real widening is the machinery working as designed.

## CX-2 — companion .md could drift silently from the YAML

Accepted. The companion now carries a machine-readable parity marker
(`<!-- t12-parity: total= mapped= scar= out-of-scope= classes= -->`) asserted
against the LIVE extractor and map — plus an assertion that every class id
appears in the companion. Any boundary or map change now forces the human doc
to update or CI fails.

## CX-3 — seeded-duplicate test didn't exercise the real guard

Accepted — the test re-implemented the grouping locally instead of calling the
function under test. `checkCompleteness` was split into a thin loader plus
`computeCompleteness(map, candidates)`, and the seeded test now runs the REAL
function over a catch-all-only fixture map, asserting both seeds surface via
`multiFileViaCatchAll`.

Counts: 190 = 37 mapped + 39 scar + 114 file-local; zero undispositioned; zero
multi-file via catch-all. Full suite: 3,745 passed, 0 failures.

---

## Claude (COMMENT, arrived after the Codex fixes) — both points accepted

1. **References data inaccuracies** — verified by grep before correcting
   (reviewer claims are evidence, not ground truth — but both held):
   `no-skip-3way-review` actually lives on spir/aspir/bugfix/experiment (my
   list wrongly had pir/research); `no-skip-porch-checks` lives on 8 files,
   not 9 — research lacks it. Both reference lists corrected against grep,
   with the verification noted in the justifications so Phase 7 consumes
   accurate data.
2. **Script-location deviation** — acknowledged and deliberate: the same
   js-yaml/workspace-resolution constraint that moved the behavioural-metrics
   logic into `src/lib/` (Phase 1, documented plan deviation) applies here;
   the extractor is a tested library rather than a loose script. The plan's
   Phase 6 text already anticipated this shape after the Phase 1 amendment.
