# Iteration 2 response — Spec 1280 (CMAP round 2)

**No disputes filed.** All nine findings verified and accepted. Both arithmetic claims were
independently recomputed before acceptance rather than taken on trust.

Round 2 existed because the architect directed it — porch had advanced to the gate after the
round-1 rebuttal without re-reviewing. It found two arithmetic errors that would otherwise
have shipped, which settles the question of whether it was worth running.

---

## Codex

**C1. Segment arithmetic underspecified** — ACCEPTED. Audience loads overlap (SHARED rides in
both architect and builder) and use different multipliers, so T11's "subtotals sum to the
total" was false as written. Current State now separates **exclusive buckets** (a partition —
these sum) from **derived audience loads** (overlap by design), with the explicit
`ALWAYS_ON_WORDS` formula. M0(f) and T11 restated accordingly.

**C2. "All ten protocols in both trees" is impossible** — ACCEPTED, verified on disk.
`codev/protocols/` has ten; `codev-skeleton/protocols/` has nine (`release` is project-local
by design). `experiment`/`research`/`spike`/`release` have no `prompts/`;
`experiment`/`research`/`spike`/`release` have no `consult-types/`. Coverage restated as
per-**surface**, enumerated from disk across both trees and unioned: absence never fails,
unmeasured presence does. M2/M3/T6 rewritten.

**Consequence I owe you separately**: this exposed that `codev/protocols/release/protocol.md`
(1,626w) was missing from my inventory entirely, because I enumerated
`codev-skeleton/protocols/*/` and `release` lives only in `codev/`. Now in M3 and Current
State, with the cause recorded. Same root cause as round 1's truncated grep: enumerating from
a convenient source rather than the authoritative one.

**C3. M5 does not prove prompt capability preservation** — ACCEPTED, and the sharpest finding
of the round. Gate and check names extracted from an unchanged `protocol.json`, and
notification names from unchanged call sites, remain present even if every corresponding
instruction disappears from the served prompts — the inventory would have reported success
while measuring files I am not touching. M5 now inventories the **resolved, expanded prompt
surface**, with a contract-presence assertion per capability, and is named as the primary
defence for the most aggressive row in the table (`protocol.md` −81%).

**C4. M5 internally contradictory on removals** — ACCEPTED (Claude raised this independently).
Resolved on M10's pattern: hard fail unless the retired name is listed in a committed
`codev/resources/1280-retirements.md` in the same commit, with the reason and architect
approval. An approved listed retirement passes; anything else fails.

**C5. O3 timing ambiguous** — ACCEPTED. "Any post-merge defect" cannot be evaluated at a
pre-merge SHIP decision. Split: pre-merge architect findings gate SHIP; post-merge defects are
a **14-day rollback signal**. Which arm merges is now answered under C5's sibling finding
below.

---

## Claude

**L1. Nothing distinguishes deleted words from relocated words** — ACCEPTED, and the most
important finding of the round. Principle 4 authorizes relocation to skills, and relocating
3,900 words scores identically to deleting them under an always-on-only metric. A −53.2%
headline is equally consistent with −30% deleted + −23% relocated, and only *deleted* content
satisfies Problem Statement claim 1 — relocated content still enters context when looked up.
This is the phantom-savings class T2 catches on the include axis, unmonitored on the
relocation axis, and my own principle 7 requires the instrument to show it. Added **M0(g)**
(report total authored surface), **M0c** (decompose the cut into deleted vs relocated), and
**T15** (fixture: moving a block to a skill must show always-on falling while total-authored
holds steady).

**L2. A/B execution model undefined** — ACCEPTED. Three unanswered operational questions, now
answered in a new **Execution and sequencing** subsection:
- **M7 gates `verify-approval`, not the PR merge** — matching where the rollback triggers
  already point, keeping a 12-run trial off the PR's critical path, and making "treatment arm
  = what builders actually get" literally true. Consequence stated plainly: a SHIP failure
  means rolling back a merged change, which is what the grouped rollback plan is for.
- **Arm disposition** — the treatment arm's PR is the merge candidate; the control arm's
  closes unmerged after its outcomes are recorded. The cost defence is corrected: **~6 of 12
  runs produce merged work, not 12.**
- **Architect load** — ~24 gate approvals + 12 PR reviews by one person, each SPIR gate
  requiring O1 rubric scoring at approval time. Named as the trial's binding scheduling
  constraint and the reason the pair count is the architect's call.

**L3. M5 severity contradiction** — same as C4.

**L4. M1's HOLD branch is arithmetically unreachable** — ACCEPTED, verified by recomputation.
Meeting every ceiling yields ≤16,016 (−53.2%); the 50–52% band requires a total of
16,442–17,128, i.e. ceilings already exceeded and M2 already failing. The branch was dead
prose. Withdrawn and replaced with the *reachable* contingency: **denominator movement** — if
correcting the instrument surfaces always-on content not yet found (as it has twice), the
baseline and every ceiling are re-derived to preserve >50%, and that goes to the architect
rather than being absorbed silently.

**Smaller notes, all adopted**: M2b added (nothing protected CLAUDE.md's human readability at
5,815 → 1,900 — humans are named stakeholders with no criterion behind them; the architect now
reviews usability at the gate); the fleet-wide consultant figure stated (≈20,500 words/project,
comparable to the entire builder load, so "−33.8% on 683" does not read as negligible); and the
hot-tier exemption quantified as a ceiling on the project (7,360 of 16,016 post-rewrite builder
words = 46%).

---

## Net effect

Nine findings, none disputed, two of them arithmetic errors caught only because the architect
insisted on a round the machinery had skipped. The spec's own principle 7 — instruments get
reviewed against what they claim to measure — has now caught four errors in this spec, three
sharing one root cause: enumerating from a convenient source instead of the authoritative one.
That pattern belongs in the review's lessons learned, and it is the argument for M3's
"enumerate from disk" requirement being a test rather than an instruction.
