# Rebuttal — #1563 review iteration 1

Verdicts: Gemini **APPROVE**, Claude **COMMENT**, Codex **REQUEST_CHANGES**. All actionable points (Codex's three, plus Claude's real edge defect and minors) were **addressed in-branch** before the pr gate. Fix commit: `a0e4d7151`.

## Codex (REQUEST_CHANGES)

**1. `AgentNav.renderTo()` omits the plan-required selected-builder progress `bar`.**
Agreed — fixed. `AgentNav.renderTo` now sets `bar: Math.round(builder.progress ?? 0)` (0 when nothing is selected), matching the Zoom navigator dial and the plan. The face test was updated to assert the bar (`bar: 70` for the fixture). (Note: the review/scroll dials deliberately drop the bar per #1498; `AgentNav` is a *navigation* dial like ZoomNav, which keeps it — so the bar is the consistent choice here.)

**2. No unit tests exercise `cycleAgentTerminal()` wrap-around, empty/singleton no-op, unfocused start, failed-target skipping.**
Agreed — this was the right call, and it echoes the `open-architect.ts` precedent (extract the pure logic out of the untestable `activate()` closure). Extracted `agentCycleAttemptOrder(order, currentIndex, direction)` — the pure walk that returns the ordered attempt list — and added tests for: forward/backward wrap-around (current visited last), nothing-focused start at the ends (both directions), the ≤1-agent empty result (the no-op), and the skip order (the command opens the first attempt that succeeds). `cycleAgentTerminal` now consumes it, so the arithmetic is pinned.

**3. Review line inaccurately says dial/key faces show the current builder; both keys use static Next/Prev labels.**
Agreed — corrected. The review's Deck-face bullet now states that only the **dial** (`AgentNav`) shows the current builder (id + bar); the **keys** carry static `Next Agent` / `Prev Agent` labels.

## Claude (COMMENT) — addressed too

**Real edge defect: skip-on-failure did NOT prevent a wedge for builders.** Correct and important. `openBuilderByRoleOrId` awaited `promptNoTerminalRecovery`'s button-bearing (sticky) `showWarningMessage`, so a stale roster row blocked the walk. Added a `quiet` parameter to `openBuilderByRoleOrId` that suppresses the recovery prompt and the ambiguity/error toasts, returning `undefined` silently; the cycle passes `quiet = true`. A non-live *architect* still shows a transient (non-sticky) warning as it is skipped — noted honestly in the review; its roster is the live-session set, so it is uncommon. The review's "can't wedge" claim was corrected and a "test with a stale row" line added to How-to-Test.

**Stale comment in `revealTargetForAgent`.** Fixed — it now points to `idleArchitectsContainerParent`/`getParent` expanding the container, consistent with commit `68976603f` and the test.

**Ambiguity-guard bypass in `agentTargetIsFocused` (minor).** Documented with a comment: each `resolveAgentName` call passes a one-element list so the multi-match return can't fire; `findIndex` takes the first tail-match, which is unambiguous for the bare-numeric / `<protocol>-<n>` ids builders carry in one workspace.

**AltGr ≡ Ctrl+Alt on some layouts (note only).** No change — the chord was owner-locked at the plan gate and is consistent with the extension's existing `ctrl+alt+r/s/v/c` family.

## Net

vscode 1009 unit tests (+5 walk), streamdeck 257, `check-types` + `lint` + manifest `validate` green. No point was rejected; nothing is left as a disagreement.
