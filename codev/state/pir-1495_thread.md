# Builder thread — pir-1495

**Issue:** #1495 — Stream Deck: Architect Action key (scope the fleet to one architect's builders)
**Protocol:** PIR (plan-approval + dev-approval gates before PR)

## Plan phase (done, awaiting plan-approval)

Wrote `codev/plans/1495-stream-deck-architect-action-k.md`.

Key design decisions, all confirmed against the code:

- **Scope, not a mode.** The selection is always a builder. Scope only narrows *which builders
  are listed/navigable*. Row 2 + dials keep acting on the selected builder.
- **Store carries the scope.** `builders()` becomes scope-aware (filters `allBuilders()` by
  `spawnedByArchitect`); every existing consumer (Row 1 window, selection, cursor bounds, zoom
  dial) narrows for free because they already read through `builders()`. New: `allBuilders()`,
  `architects()` (distinct non-null `spawnedByArchitect`, sorted), `toggleArchitectScope()`.
- **Selection preserved by id across a scope toggle** (falls back to 0) so the dials keep
  reviewing the same builder — matches the issue's language.
- **Reuse #1465, don't reimplement.** Extract the positional-ordering core out of `SlotKey`
  into a shared `PlacedKeys` base; `SlotKey` and the new `ArchitectAction` both extend it. The
  #1465 tests are the regression guard for the extraction.
- **Derive architects from builders, never `OverviewData.architects`** (architect scoping
  instruction + #1463 rationale).
- Ruling 1 (reset on workspace switch): clear scope in the 3 store workspace-change paths.
  Ruling 2 (empty scope visibly empty): falls out of scoped `builders()` returning `[]`; do NOT
  auto-clear. Ruling 3 (no summoning): press relays no command, deck-local state only.
- New manifest action + icon (`architect-action`, rendered from the existing `architect` glyph
  via `scripts/render-action-icons.mjs` — needs librsvg + imagemagick).

**#1406** stated as impact only (mis-attributed → wrong scope; null → unreachable), NOT fixed.

**Dev-approval is hardware** and needs a board where ≥2 architects own builders — planned the
demo in the Test Plan; will flag if a two-architect board can't be stood up at review time.

Routed the plan to the architect before the gate (architect asked to review pre-gate).

**Plan review — APPROVED WITH TWO ADDITIONS (folded in, commit below):**
1. **Ordering:** `architects()` is `main`-first then alphabetical, twinning
   `sortArchitectsForPicker` (`apps/vscode/src/views/architect-display.ts:31`) with a sync-note.
   Load-bearing because keys are positional — pins `main` to key 1 permanently.
2. **Null-attribution superset test:** a `null`-`spawnedByArchitect` builder must (a) show in
   the unscoped list, (b) be reachable under no scope, (c) be restored on clear — keeps #1406 a
   display bug, not a reachability bug.

Also folded the real fleet into the dev-approval demo: four architects own builders (main,
security, vscode, streamdeck); reviewer + demos own none and must NOT appear — demonstrating
that absence is the derive-from-builders decision made visible.

Architect endorsed keeping scope-through-`builders()` and the id-preserving selection as
written, and the `PlacedKeys` extraction over a copy.

## MAJOR REFRAME (owner decision, Amr, 2026-08-18) — scope model DROPPED

Amr (issue author/owner) reversed the "scope, not a mode" framing in the interactive session:
**no filtering of builders at all.** The feature is two independent boards + a native switch:

- **Builders board** — full fleet, unchanged.
- **Architects board** — self-ordering Architect Action keys (reuse #1465), one per architect;
  press opens that architect's terminal (`open-architect-terminal`, reusing #1463's verb).
- **Switch** — a NATIVE Stream Deck key (Switch Profile, recommended two-profile symmetric, or
  a Folder) carrying a CUSTOM Codev-styled icon we ship (new `switch` glyph). Stream Deck does
  the flip; no plugin switch code. Plugin-driven `switchToProfile` stays deferred (#1381/#1440).

Consequences vs the approved plan:
- `scopedArchitect`, `builders()` filtering, selection preservation → all GONE.
- Store gains ONLY `architects()` (distinct non-null spawnedByArchitect, main-first then
  alphabetical, twinning `sortArchitectsForPicker`).
- Ruling 3 ("no summoning") intentionally lifted — the key opens the terminal.
- Rulings 1 & 2 (scope reset / empty-scope) no longer apply.
- The null-attribution superset test is moot (builders board never filtered) — dropped
  deliberately, noted in the plan so the architect sees why.
- Still reuse #1465: extract `PlacedKeys` base from `SlotKey`; `ArchitectAction` extends it.

Rewrote the plan to this shape. This reverses the plan the architect (main)
approved on the scope model — flagged to main; Amr's word governs. Gate stays pending Amr.

## SECOND REFRAME — architect list SOURCE (owner decision, 2026-08-18)

During implement, Amr reversed the list source: the Architects board enumerates the LIVE
ARCHITECT VIEW (`OverviewData.architects`), NOT distinct `spawnedByArchitect`. Reason: the board
now SUMMONS, so it must list "architects that exist" — a live architect owning no builders
(demos, reviewer) must still get a key or it's permanently unopenable. Verified live: 6 live
architects, only 4 own builders.

Key rulings folded in (plan + code comments):
- Read `OverviewData.architects` (live sessions), NEVER `DashboardState.architects` (its
  "registered" doc comment is wrong — filed #1496; sibling lane #1494 built on the lie).
- Ruling-2 reconciliation: #1463's "deck never consumes the live view" guards a SILENTLY-WRONG
  single-target key; an ENUMERATION board is safe because press → open-architect-terminal →
  VSCode resolves + warns, so a stale list FAILS LOUDLY. Amended OpenArchitectAction's doc
  comment narrowly (don't let a maintainer "restore" the derivation).
- DECLINED pinning main: an explicit 'main' arms VSCode's main-else-first fallback (#1497) → a
  pinned key could open the wrong terminal under main's own unqualified label, wrong-until-next-
  press. So SORT main-first but never INJECT. Cite #1497, don't restate the trace.
- Three failure modes decided in plan: (a) empty board → dim inert "No architect" face,
  self-correcting; (b) missing main → unpinned/absent (safer); (c) dead PTY behind live row →
  VSCode owns the warning, no deck-side pre-validation.
- Inverse test (replaces dropped null-superset): an architect with ZERO builders still appears.

## IMPLEMENT — DONE (awaiting dev-approval)

Built: store.architects() (live view, main-first sort, no pin); extracted PlacedKeys base from
SlotKey (reuses #1465 ordering, non-generic — settings read from event, sidesteps unimportable
JsonObject); ArchitectAction (press → open-architect-terminal, no selection change);
architectKeyFaceSvg; new `switch` glyph; manifest action + architect-action/switch icons (via
render script); registered in plugin.ts; README Design + Actions docs.

Verified in worktree: check-types ✓, build ✓, Elgato validate ✓, 231 tests (+14 new) ✓.
Restored unrelated regenerated icons (render script is non-deterministic) to avoid PR churn.
Dev-approval is hardware — 6-architect fleet is live, demo steps in the plan's Test Plan.

## dev-approval APPROVED → REVIEW phase → PR gate

Owner approved dev-approval after hardware check (relinked plugin to worktree, two-page profile,
swiped to page 2; chose page-SWIPE over a switch button — "swiping is enough"). Along the way,
per owner requests: page-1 layout became all-builders (Row 1 = 4 Builder Action, Row 2 =
OpenArch(bldr)/OpenBldrTerm/Approve/Dev), page-2 = Architect keys across both rows; README
layout rewritten (two stacked vertical diagrams, shared dials).

Review phase: wrote codev/reviews/1495-*.md (retrospective), COLD lessons-learned.md UI/UX entry
(enumerate-vs-resolve; sort-not-pin/#1497), no arch changes (app-local, design lives in README).
PR #1499 opened (body=review, Fixes #1495), recorded with porch.

3-way consultation (single pass): gemini=APPROVE, claude=APPROVE, codex=REQUEST_CHANGES (all
docs/verification, impl "sound"). Dispositions (rebuttals file in codev/projects/1495-*/):
- FIXED: README "Wiring the native switch" steps (which native key gets switch.png).
- FIXED: dropped stale "Main-mode key in Row 1 slot 1" rec contradicting the new layout.
- REBUTTED: "review records swipe not switch button" — swipe was owner's choice; switch button is
  optional NATIVE affordance, not plugin code. Review manual-verify note made explicit.

Now at the **pr gate**. Notified architect (led with REQUEST_CHANGES + disposition). Waiting for
human merge + gate approval; will not merge until porch reports gate_status: approved.

## Pre-gate fixes (architect sanity-check) + MERGED

Architect required two pre-gate fixes (verified at source): (1) the four switch PNGs had NO test
coverage — manifest-icons.test's generic loop only walks manifest.Actions and switch is
manifest-less, so added explicit existence + size assertions; (2) corrected the rebuttal overclaim
"nothing of ours is left unverified" → honest our-vs-platform split (native key BEHAVIOUR is
Elgato's/out-of-scope; the icons + README procedure are OURS, now pinned). 233 tests. Pushed;
porch re-fired pr gate (single-pass, no re-consult).

Amr approved ("approve and merge 1495"); architect minted the porch gate record.

MERGE hit the review-required wall: gh pr merge refused ("base branch policy prohibits the merge",
REVIEW_REQUIRED). Reported + went quiet per merge-window rule. Architect cleared it and MERGED:
PR #1499 merged 2026-08-18T02:17:57Z, merge commit 9129ab81c, 7/7 green on stationary head
c67edf53c. Verified against SHA; ran porch done --merged 1499 (protocol complete).

**#1462 reproduced live** (architect's request, added to the review artifact): two porch
bookkeeping commits (52f88dfe pr gate-approved, c67edf53c protocol complete) bumped the head off
the gate-record SHA and restarted all 7 checks — the protocol wrote its own gate record onto the
branch and invalidated the merge window it had just opened. Clean repro of an inference-filed bug.

NOTE: this review/thread addition is post-merge, so it sits on builder/pir-1495 only — NOT in
main's merged copy. Flagged to architect for a landing decision (follow-up PR vs. branch record).
