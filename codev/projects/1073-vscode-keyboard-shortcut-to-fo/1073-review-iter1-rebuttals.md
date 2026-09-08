# PIR #1073 — Rebuttal to iteration-1 3-way review

**Verdicts:** Gemini APPROVE · Claude APPROVE · Codex REQUEST_CHANGES

## Codex (REQUEST_CHANGES): terminal focus contradicts "focus stays in the diff editor"

> `forwardToBuilder` explicitly focuses the terminal (`openBuilderByRoleOrId(..., true)`
> and `terminal.show()`), contradicting the plan and review's claim that focus remains
> in the diff editor. Fix focus handling and re-verify/update the review file.

**The observation is factually correct.** The shared inject path does focus the
builder terminal: `codev.forwardToBuilder` → `openBuilderByRoleOrId(builderId, true)`
→ `openBuilder(..., focus=true)` → `existing.terminal.show(!focus)` = `show(false)`
(takes focus), and `injectBuilderText` calls `entry.terminal.show()` (also takes
focus). So focus does move off the diff editor.

**Disposition: no code change to focus behavior; documentation corrected instead.**
Reasoning:

1. **This is the exact shared path the codelens click and `Cmd/Ctrl+K B` already
   use.** `codev.forwardToBuilder` and `codev.forwardSelectionToBuilder` both call
   `openBuilderByRoleOrId(entry.builderId, true)` then `injectBuilderText`. The issue
   defines this command as *"the keyboard equivalent of one existing codelens click"*
   and plan-gate decision #5 locked *"inherit the same resolver the existing codelens
   uses."* A true equivalent of the codelens click must focus the terminal exactly as
   the click does.

2. **Focusing the terminal is the feature's purpose, not a bug.** The inject path
   types the reference *without Enter* specifically "so the reviewer keeps typing
   feedback before hitting Enter" (the #789 `forwardToBuilder` contract). That
   requires the terminal to hold keyboard focus. Preserving diff-editor focus would
   defeat the inject-then-type flow and would diverge this command from every sibling
   forward action.

3. **A focus-preserving fix would be out of scope and wrong.** The only ways to keep
   the diff editor focused are (a) change the shared `injectBuilderText` /
   `openBuilder` to pass `preserveFocus` — which alters the codelens and `Cmd/Ctrl+K B`
   behavior too (explicitly out of scope: "Changing how the existing codelens or
   `Cmd/Ctrl+K B` resolve their targets"), or (b) bounce focus back in this handler
   only — which diverges from siblings and breaks the type-feedback purpose.

4. **The human already approved the actual running behavior** at the `dev-approval`
   gate, having exercised the real focus behavior.

**What I changed** (commit `df1e58e38`):
- Corrected the inaccurate "focus stays on the diff editor" wording in the review's
  Test Results and How-to-Test sections to accurately state that the builder terminal
  is revealed and focused (matching a codelens click / `Cmd/Ctrl+K B`).
- Documented Codex's finding and this disposition in the review's "Things to Look At"
  section.

**Escalation:** acceptance-criterion #5's literal wording ("focus stays on the diff
editor") is in genuine tension with the codelens-parity goal it sits beside — they
cannot both hold given the shared inject path. That is the human's decision at the
`pr` gate, and I am escalating it there rather than resolving it unilaterally. Since
PIR is single-pass, the human is the only remaining reviewer of this disposition.

## Claude (APPROVE) — optional non-blocking suggestion, adopted

Claude suggested a one-line comment documenting the inherited line-0 symbol skip in
`resolveCursorRef`. Adopted in commit `df1e58e38` (`diff-inject-ref.ts`) — cheap,
improves clarity, no behavior change. Claude's second note (silent palette no-op)
is intentional and consistent with the sibling `forwardCurrentFileToBuilder` /
`forwardCurrentHunkToBuilder` commands; no change.

## Gemini (APPROVE) — no action required

Gemini's summary states the command delegates "without ... stealing editor text
focus"; that specific phrasing is inaccurate for the same reason Codex identified
(the terminal is focused). No action beyond the documentation correction above.
