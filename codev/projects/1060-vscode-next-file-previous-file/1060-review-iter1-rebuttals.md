# PIR #1060 — Consultation rebuttals (iteration 1, single advisory pass)

Verdicts: **Claude APPROVE**, **Codex REQUEST_CHANGES**, **Gemini REQUEST_CHANGES** (recorded by porch; in practice the Gemini run misfired — see below).

PIR consultation is a single advisory pass (`max_iterations: 1`) — there is no automated re-review. Dispositions below; the human is the remaining reviewer at the `pr` gate.

## Codex — REQUEST_CHANGES (HIGH)

### Finding 1: Keybindings deviate from the approved plan (decision #1 said palette-only)
**Disposition: authorized deviation, not a defect. Plan amended; no code change.**

The `Ctrl+Alt+]` / `Ctrl+Alt+[` keybindings were added at the **human architect's explicit direction during the dev-approval gate** — they asked for shortcut keys and to avoid function keys. The dev-approval gate was then approved *with* the keybindings in place, so the running code the human signed off on already included them. Codex (correctly) flagged the plan↔code divergence without the conversation context that authorized it; Claude reviewed the same divergence and judged it sound ("good deviation").

To make the artifact self-consistent (Codex's suggested remedy was "plan amendment or revert"), I amended **plan decision #1** to record the reversal and the rationale (Ctrl+Alt+] / [, function-keys avoided, scoped to `codev.activeEditorIsBuilderFile`). No code change warranted.

### Finding 2: Navigation cannot be *initiated* from a deleted/binary file diff
**Disposition: real defect. Fixed + regression test.**

Confirmed: deleted/binary files have a `codev-diff:` placeholder right side, not a `file:` document, so `registerFileInjectSession` skips them (`view-diff.ts`) and `getDiffInjectEntry` can't resolve them. With `lastPosition` unset (no prior navigation this session), opening such a file directly from the sidebar and pressing next/prev bailed with "open a builder file diff first." Deletions *are* in the changed-file list, so they should be navigable.

**Fix:** seed the nav anchor on **every** open, not just after a navigation step. Added `recordDiffNavPosition(builderId, relPath)` to `diff-nav.ts` and call it from the `codev.openBuilderFileDiff` command handler (`extension.ts`) after the diff opens. So a deleted/binary file opened from the sidebar now seeds `lastPosition`, and the subsequent next/prev resolves through the fallback. `navigateDiff` uses the same setter internally (no behavior change there). No circular import: `extension.ts` already imports from `diff-nav.ts`; `view-diff.ts` is untouched by this wiring.

**Regression test** (`diff-nav.test.ts`): the record/peek/reset anchor state machine, plus a case asserting a deleted file (status `D`) resolves in the list and steps forward. Build + 442 unit tests green (4 new).

(Residual edge, noted for transparency: focusing a deleted file *inside the multi-file View Diff editor* without a prior open/nav still can't seed the anchor — viewDiff registers only `file`-kind right sides. The sidebar-open path Codex called out is fixed; this narrower case is documented, low-frequency, and a candidate for follow-up if it matters.)

## Gemini — REQUEST_CHANGES (recorded), but the run misfired
**Disposition: no actionable feedback — the consultation did not review the diff.**

The Gemini (`agy`) output (`1060-review-iter1-gemini.txt`) shows the session went off investigating a "--sandbox" prompt and never inspected the PR or produced a structured verdict. There is no finding to address. Porch recorded the non-APPROVE as REQUEST_CHANGES, but there is nothing to act on. Flagged for the human at the `pr` gate; not re-run (single-pass advisory).

## Claude — APPROVE (HIGH)
No issues. Verified behavior-preservation of the refactor and test coverage of the pure-logic surface.

## Net
- One real defect fixed (deleted/binary nav-start) with a regression test.
- One divergence reconciled by amending the plan (human-authorized at dev-approval).
- One misfired model run with nothing to act on.
- The fix is pushed to PR #1067; the human verifies at the `pr` gate (PIR does not re-review).
