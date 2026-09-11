# pir-1563 — Cycle agent terminals from keyboard and Stream Deck

## Context
PIR protocol, issue #1563. Two new VS Code commands (`codev.focusNextAgentTerminal` /
`codev.focusPreviousAgentTerminal`) that cycle agent terminals in the exact rendered order of the
sidebar Agents section (grouping-aware, wrap-around), plus a Stream Deck motion (dial rotation +
key-pair fallback) via the established command-relay path.

## Log

### PLAN phase — started
- Investigating: (1) Agents tree provider rendered order + grouping, (2) terminal open/focus
  commands, (3) Stream Deck relay path + face.ts. Two Explore agents dispatched.
- Key constraint from issue: single source of truth for ordering (shared-function lesson #818) —
  derive roster from the same data the Agents tree renders, do not build a parallel order.

### PLAN phase — findings & plan written
Two Explore agents mapped both sides. Key facts:
- Rendered order = `orderForDisplay(builders)` + `active().group(...)` (builder-grouping.ts),
  flattened by `rootChildren()`/`architectRootChildren()` in `views/builders.ts`.
- Axis matters: stage/area render builders only (architects not shown); architect axis renders
  architect headers (openable) interleaved with their builders, main-first then populated then
  idle. So the cycle roster is axis-dependent by design ("mirror sidebar exactly").
- Terminal registry: `TerminalManager.terminals` keyed `builder-<id>` / `architect:<name>` /
  `dev-<id>` / `shell-<n>`. `getActiveBuilderId()` exists; need to add `getActiveArchitectName()`.
- Deck relay: `VERB_COMMANDS` allowlist in `command-relay.ts`; add `focus-next-agent`/`focus-prev-agent`.
  Dial = SingletonAction + setFeedback (like ScrollNav); keys = VerbKey. face.ts has `labelFaceSvg`
  + glyphs 'terminal'/'switch'.
- Deck-follow is builder-only (`builder-active` activity hook on terminal focus); no architect-focus
  signal → deck face can show builder id natively but not architect name without extra work.

Plan: Phase 1 = VS Code commands + shared `agentCycleOrder()` (extract `partitionArchitectGroups`
to share architect-axis order with the renderer, anti-drift test) + `getActiveArchitectName` +
keybindings. Phase 2 = Stream Deck dial + key-pair + relay verbs + face. Both commits in one PR.

4 decision points surfaced for the reviewer: keybinding chord (cmd+k ]/[ pending verification),
deck surface, deck-face architect support, and confirming the axis-dependent roster.
Plan written to `codev/plans/1563-cycle-agent-terminals-from-key.md`. Awaiting plan-approval gate.

### PLAN revised — Stream Deck surface (reviewer question: "4 dials already occupied?")
Verified the shipped `Codev.streamDeckProfile` (Stream Deck+, DeviceType 7 = 4 dials + 8 keys):
BOTH populated pages are full. Page 1 dials = Zoom/Review-Files/Review-Hunk/Scroll; keys = 4x
Builder Action + Open-Architect/Open-Builder/Approve-Gate/Run-Dev. Page 2 dials = same; keys = 8x
Architect Action. NO free dial or key in the default profile. Precedent: PrNav & SpawnNav dials
exist in the manifest but are NOT placed in the shipped profile → accepted pattern is
"manifest palette action, user places it." Revised Phase 2: key-pair is PRIMARY (works on all deck
models), dial offered; default profile unchanged (option 2a, recommended) unless reviewer picks 2b
(dedicated Page 3) or 2c (displace a dial). Keyboard commands remain the always-available primary
path. Decision point 2 rewritten with 2a/2b/2c. Recommitted.

### PLAN gate dialogue (owner) — keybinding LOCKED + deck direction
Rebased branch onto main (was 280 behind), clean, force-pushed.
Discussed deck-first-dial reuse: rejected — the Zoom/first dial's selection is builder-only and
drives the Review dials/diff, so it can't own architects; #1563's cycle must include architects
(architect grouping), so the deck should be a pure VS Code trigger (VS Code owns the roster).
Owner leaning key-pair for the deck (not locked; decision point 2 still open: 2a manifest-only rec).
Keybinding: explored prefix (cmd+k n/p) vs single-modifier; owner wants fewest presses for a repeated
motion → LOCKED to `ctrl+alt+n` / `ctrl+alt+p` (mac `cmd+alt+n`/`p`), hold-modifier tap-to-repeat.
Verify-no-shadow at implement; fall back to another ctrl+alt letter pair only on a real conflict
(never the diff-nav bracket keys). Plan updated (keybinding section, decision point 1, test bullet).
Still at plan-approval gate. Reminder: feature is ~80% VS Code (the whole keyboard motion stands
alone); deck is a thin additive trigger layer.

### IMPLEMENT phase — plan-approval approved by Amr (relayed by main), implemented both phases
Phase 1 (VS Code, commit 523a1ffc3):
- builders.ts: `AgentTarget` type + exported pure `partitionArchitectGroups` (shared by
  architectRootChildren AND agentCycleOrder — #818 single source) + `agentCycleOrder()` (axis-aware
  flatten: stage/area = builders only; architect = interleaved headers+builders, idle last).
- terminal-manager.ts: `getActiveArchitectName()` mirroring getActiveBuilderId.
- extension.ts: `cycleAgentTerminal(direction)` helper + focusNext/PreviousAgentTerminal commands.
- package.json: command contributions + keybindings ctrl+alt+n / ctrl+alt+p (mac cmd+alt), when
  codev.hasWorkspace.
- Tests: new __tests__/agent-cycle-order.test.ts (11 tests, incl. anti-drift vs rendered order).
- FIXED a brittle pre-existing test (terminal-manager.test.ts) my new method broke: it split the
  WHOLE file on `type === 'architect'` to find openTerminal's else-branch; scoped it to
  openTerminal's body. My method is correct; the test heuristic was too broad.

Phase 2 (Stream Deck, commit 22d3107af):
- command-relay.ts: focus-next-agent / focus-prev-agent verbs (allowlist).
- actions.ts: FocusNextAgentKey / FocusPrevAgentKey (VerbKey, switch glyph) + AgentNav dial
  (rotate=next/prev, press=open selected builder). plugin.ts registers all three.
- manifest.json: 2 Keypad + 1 Encoder action (reuse existing icons/switch, icons/list/switch).
- README.md documents the keys + dial (deck out of default slots → manifest-palette, like
  PrNav/SpawnNav; not pre-placed).
- Tests: +7 in actions.test.ts, +1 in command-relay.test.ts.

Checks: vscode check-types+lint+test:unit (993) green; streamdeck check-types+validate+test (257)
green. Running root `npm run build` + `npm test` (porch checks) next.

DEVIATION from plan (will flag at gate): SKIPPED the in-PR changelog updates (apps/vscode/CHANGELOG.md
+ docs/releases/UNRELEASED.md). Repo convention — documented in UNRELEASED.md's own template — is
that VS Code changelog + release notes are accumulated on the docs/vscode-changelog branch
post-merge by the architect (referencing the PR#), NOT in feature branches. Git log confirms
(e.g. "docs(changelog): ... (#1592, PR #1616)" landed separately). Adding them here would conflict.

DECK DEFAULTS taken (plan's recommended options, since approved as-is): 2a manifest-only (no profile
change), builder-centric deck face (DP3 deferred), architects cycle only in Architect grouping (DP4).

### dev-approval gate — deviation RATIFIED by architect (main), 2026-09-09
main ratified the changelog-skip as an architect ruling: skipping in-PR changelog edits IS the
documented convention (per-PR accumulation on docs/vscode-changelog post-merge; UNRELEASED.md's
template says exactly that); the plan's mention was stale. TODO for REVIEW phase: record this
deviation + ratification in codev/reviews/1563-*.md per protocol. Holding at dev-approval; Amr's
word comes next (do NOT run porch approve until Amr's approval is relayed).

### dev-approval — BUG found by Amr in testing, FIXED (commit f393b5a47)
Symptom: cycle only moved main <-> #3816 (main's builder), never reached app/#1330/idle architects.
Root cause: id-space mismatch. agentCycleOrder builds builder targets from OverviewBuilder.id (bare,
e.g. '3816'); getActiveBuilderId() returns Tower's CANONICAL id (e.g. 'bugfix-3816'). My matcher used
plain ===, so focus on any builder → currentIndex -1 → next snapped to index 0 (main). Everything past
the first builder was unreachable. My earlier unit tests covered agentCycleOrder (the roster) but NOT
the cycleAgentTerminal matching — that's the gap that let it ship.
Fix: (1) extracted pure agentTargetIsFocused() using resolveAgentName tail-match (both directions),
the same resolver the open path uses; (2) made the walk skip-on-failure (unopenable entry can't wedge
the cycle); (3) 5 regression tests pinning bare-vs-canonical id. vscode suite 998 green, VSIX rebuilt.
Still holding at dev-approval; Amr re-testing.

### Fix accepted at architect level (main, 2026-09-10)
main reviewed + accepted the fix shape (tolerant both-direction match + skip-on-failure + regression
tests). REVIEW-PHASE TODOs for codev/reviews/1563-*.md:
  1. Deviation + ratification: in-PR changelog SKIP (docs/vscode-changelog convention) — ratified by main.
  2. LESSON (main asked to name it): OverviewBuilder.id (sidebar/overview bare id) vs Tower-canonical
     terminal id (getActiveBuilderId / builder-<id> registry key) is a SYSTEMIC SEAM. Any feature that
     matches "the focused terminal" against "an overview-derived roster" must bridge the two id spaces
     with resolveAgentName (tail-match), never ===. This one collapsed the whole cycle to index 0 and
     slipped past unit tests because the roster (agentCycleOrder) was tested but the MATCHING was not —
     test the focus->roster matching, not just the roster.

### dev-approval — sidebar selection follow-up (Amr, 2026-09-10), commit 62bd85894
Amr: cycling opened+focused the terminal but the sidebar row stayed on the old agent (click selects
natively; keyboard path never touched the tree). Added revealTargetForAgent() on the provider +
buildersView.reveal(item, {select:true, focus:false}) after each open. Builder → the versioned
BuilderTreeItem (reveal matches by id, expands group ancestor); architect → BuilderGroupTreeItem with
stable id builder-group:<name>. Known edge: idle architects inside the collapsed "Idle Architects"
container can't be highlighted while collapsed (row not rendered); terminal still opens. +3 tests,
1001 vscode unit green, VSIX rebuilt. Still holding at dev-approval.

### REVIEW phase — dev-approval approved by Amr (relayed by main), 2026-09-11
Rebased onto origin/main (was 19 behind), clean, force-pushed. Set aside an unrelated tower-cron
append to codev/team/messages.md (not mine) during rebase; reset it to HEAD, not in my PR.
Wrote codev/reviews/1563-*.md (Summary, Files, Commits, Test Results, Architecture Updates, Lessons
Learned Updates, Things to Look At, How to Test, Notes). Recorded BOTH logged TODOs: changelog-skip
ratification (Notes section) + the id-space seam LESSON (added to COLD lessons-learned.md Architecture
+ referenced in review). Next: open PR, porch done --pr, porch done (triggers single-pass CMAP), then
hold at pr gate.

### REVIEW phase — CMAP done (Gemini APPROVE, Claude COMMENT, Codex REQUEST_CHANGES), all addressed
Single-pass 3-way. Non-approvals converged; fixed in-branch before pr gate:
- (real edge, Claude) skip-on-failure didn't prevent a wedge for builders — openBuilderByRoleOrId
  awaited a STICKY recovery prompt. Added `quiet` param (skips prompt/warning); cycle passes quiet=true.
- (Codex+Claude) walk untested → extracted pure agentCycleAttemptOrder(order,current,dir) + 5 tests
  (wrap-around, <=1 no-op, nothing-focused start, skip order).
- (Codex) AgentNav dial missing progress bar → added (matches ZoomNav + plan). Updated face test.
- (Codex) review said keys show current builder → corrected (only dial does; keys static labels).
- (Claude) stale comment in revealTargetForAgent → updated. (Claude) ambiguity-guard bypass → comment.
- (Claude) AltGr note → no change (owner-locked, matches existing ctrl+alt+* family).
vscode 1009 tests, streamdeck 257, types+lint green. Rebuild VSIX + update PR body + porch next → pr gate.
