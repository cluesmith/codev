# Phase 3 — `protocol.md` ×10 with the P6 include mechanism (G3)

**Decisions**: 10 · **Rollback group**: G3, commit-pure
**Suite**: green · **Build**: rerun (`copy-skeleton`) before testing

## Batch 1 — 10 decisions (19 files; twins are byte-identical, so inspection is per DECISION and T7 verifies the sync)

| File (both trees unless noted) | Old | New | Principles | Rationale |
|---|---:|---:|---|---|
| `{codev,codev-skeleton}/protocols/spir/protocol.md` | 3699 | 671 | **P6**, P1, P7 | Largest cut in the project. State machine delivered as JSON; deleted the 40-line MANDATORY checklist, four BLOCKING banners, the 13-step workflow, When-to-Use, Best Practices, Protocol Evolution. Kept artifact contract, spec-vs-plan boundary, no-time-estimates, consultation, gates, commit/branch formats. |
| `{codev,codev-skeleton}/protocols/pir/protocol.md` | 2066 | 551 | **P6**, P1, P7 | Kept the three gates with `dev-approval` named as PIR's distinctive one, the merge-trigger-is-structured-state rationale, the no-`porch reject` iteration model, PTY session semantics, and the CMAP-2 config-precedence trap. |
| `{codev,codev-skeleton}/protocols/maintain/protocol.md` | 1765 | 285 | **P6**, P1 | Kept since-marker discipline, `.trash/` 30-day recovery, tier routing, the explicit-`git add` canonical, and the maintenance-run template include. |
| `{codev,codev-skeleton}/protocols/research/protocol.md` | 1278 | 238 | **P6**, P1 | Kept independence-of-investigation and preserve-disagreement — the two properties that make a 3-way pass worth its cost. |
| `{codev,codev-skeleton}/protocols/aspir/protocol.md` | 810 | 248 | **P6**, P1 | Now says spec/plan are **ungated**, not 'auto-approved' — the JSON defines no gate there. Defers shared substance to SPIR. |
| `{codev,codev-skeleton}/protocols/bugfix/protocol.md` | 699 | 488 | **P6**, P1 | Kept the `--delete-branch` worktree warning, net-diff-at-merge-base scope, the self-merge-class gate rationale, and the edge-case table. |
| `{codev,codev-skeleton}/protocols/experiment/protocol.md` | 711 | 191 | **P6**, P1, P7 | Kept hypothesis-before-running, record-negative-results, and the notes template include. |
| `{codev,codev-skeleton}/protocols/spike/protocol.md` | 655 | 223 | **P6**, P1 | Kept the three-verdict table, 'a negative result is a successful spike', and the findings template include. |
| `{codev,codev-skeleton}/protocols/air/protocol.md` | 643 | 275 | **P6**, P1 | Kept the no-artifacts economy and the escalate-early rule. |
| `codev/protocols/release/protocol.md` *(codev-only)* | 1626 | 1626 | none | **Inspected, unchanged** — no `protocol.json` so P6 does not apply, and 36% of it is exact commands where the sequence *is* the contract. |

### Served words (P6 expands the JSON back in)

Authored → served, per protocol: spir 671→1239 · pir 551→926 · aspir 248→816 · bugfix 488→742 ·
research 238→494 · maintain 285→477 · air 275→557 · experiment 191→380 · spike 223→300.

*(Deliberately prose, not a table: a second table of the same shape parses as manifest rows and
inflates the batch count — T16 caught exactly that on this file.)*

- `ALWAYS_ON_WORDS`: 28,844 → **26,384**
- `TOTAL_AUTHORED_WORDS`: 144,465 → **126,155**

**Deleted vs relocated (M0c): all deletion, no relocation.** Nothing moved to a skill; the
structured source was already on disk and is now *delivered* rather than *narrated*. Authored
total falls 18,310 against always-on's 2,460, which is what deletion across both trees looks
like when the deleted prose was not always-on for every protocol.

## `release` — inspected, deliberately unchanged

`release/protocol.md` is **36% code blocks** (594 of 1,626 words) carrying exact `git add` file
lists, the root-`package.json` version-anchor pattern, the pre-release auto-skip for the VS Code
Marketplace, and the backport path. **Here the sequence *is* the contract**: P1 says delete the
procedure and keep the contract, and for a release the procedure is what the agent must not
improvise.

It is also the one protocol with **no `protocol.json`**, so P6 does not apply.

Under the acceptance model a conformant file passes as-is, and a file that is conformant at more
words passes. Cutting it to hit a number would be size-chasing — which the charter amendment
explicitly rejects. Recorded as a decision, not an omission.

## P6 mechanism — delivered, not fetched

`protocol.md` carries a fenced ` ```json ` block containing `{{> protocols/<p>/protocol.json}}`.
Verified rather than assumed:

- `resolveCodevIncludes` is **extension-agnostic** (`skeleton.ts:108-119`), so the JSON expands
  in place.
- The **spawn path** uses the same resolver — `spawn-roles.ts:127` passes `protocol.md` through
  `resolveCodevIncludes` before inlining it as `{{protocol_reference}}`. Both modes benefit.
- **T18** asserts delivery in **both modes**, which are not symmetric: strict-mode builders also
  get gates/checks as porch task JSON, but **soft-mode builders have only this document**. A
  silent expansion failure would leave a soft-mode builder with a protocol doc describing
  nothing.

**A correction to my model of the resolver, found by T18 and worth recording**: tier 4 is
`getSkeletonDir()` — the **installed npm package** — *not* `<root>/codev-skeleton/`. The
repo-local `codev-skeleton/` is a build *source* (`copy-skeleton` copies it into
`packages/codev/skeleton`); the resolver never reads it. My first fresh-install test planted
files in a temp `codev-skeleton/` and "passed" against the real installed package. Rewritten to
assert the actual adopter guarantee: `skeleton` is in the npm `files` allowlist and every P6
protocol's `protocol.json` is in the built skeleton.

## Cross-batch convention diff (the Phase 2 lesson, generalised)

Ten files describing the same gates is ten chances for one stale owner. Diffed conventions
*across* the batch before declaring it:

- **Gates**: every gate defined in `protocol.json` is present in the **served** text of its
  `protocol.md`. The pre-existing gap — five protocols whose prose described *less* than their
  JSON — is **dissolved by construction**, not fixed by hand.
- **Approval actor**: no file claims the architect runs `porch approve`.
- **Merge command**: `--delete-branch` warning preserved where it appears.

Two apparent contradictions surfaced and **both were my diff's crudeness, not the files'**: it
checked *raw* text where T18 checks *served*, and its actor regex matched the **negation**
("You do **not** run `porch approve`"). Verified against the real artifacts before reporting.

## M10 — assertions retired: **none**, but only after repair

**I wrote "none retired / suite green" in this manifest before the suite finished.** It was not
green: 37 failures across three files, all of them real capability loss I had introduced.
Correcting the record rather than the claim:

| Broke | Originating spec | Behaviour survived? | Resolution |
|---|---|---|---|
| `template-delivery` (12) — `maintain/maintenance-run.md`, `spike/findings.md`, `experiment/notes.md` orphaned | **#1279** | **No** — I replaced each protocol's template include with the `protocol.json` include instead of carrying both. Builders would have stopped receiving those artifact structures | Restored all three includes alongside the JSON |
| `baked-decisions` (24) — category hints, amend/rescind hatch, "no-op default" missing from spir/aspir/air | **Spec 746** | **No** — I shortened it in SPIR and dropped it from ASPIR and AIR. Losing "absence is the no-op default" invites a builder to invent constraints where the architect deliberately left them open | Restored to full Spec 746 completeness in all three |
| `framework-ref-audit` (1) | — | consequence of the above | Resolved by the same repair |

**Zero assertions were retired — but by repair, not because nothing broke.** Every failure was
the tests catching capability I had deleted, which is the machinery working exactly as M5/M10
intend.

The process lesson is mine, not the code's: I applied "read the raw thing, don't trust the
summary" to every instrument this project touched, then skipped it on my own completion claim.

## T16 caught three defects in this manifest itself

Worth recording, because the guard was written before any manifest existed and has now earned it:

1. A fifth column (`Served`) I added silently — the parser read `1239` as the principles field.
   **The format is the contract; I conformed the manifest rather than loosening the test.**
2. Listing 19 file-rows instead of 10 decision-rows, which broke the ≤12 batch cap. The plan's
   model is inspection *per decision* with twins verified mechanically by T7 — my "fix" had
   silently abandoned that model.
3. A supplementary table of the same shape parsing as manifest rows and inflating the count.
   Served figures are now prose.

All three were my deviations from a format I defined myself.
