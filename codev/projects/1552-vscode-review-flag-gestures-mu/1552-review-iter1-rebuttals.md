# Rebuttal — review iteration 1 (#1552)

Verdicts: **Gemini APPROVE**, **Codex REQUEST_CHANGES**, **Claude COMMENT**. Codex and Claude converged
on the same substantive findings; all four are legitimate and I **fixed all of them** (no
disagreement). Summary below, then per-point.

## Codex REQUEST_CHANGES

**1. `isBuilderComposerOpen()` treats any focused `comment`/`commentinput` editor as a builder
composer → a hunk/selection gesture could submit a plan-review / PR / other-extension comment via
`editor.action.submitComment`. "Track builder-owned composer state specifically and add a
cross-controller regression test."**

FIXED. `isBuilderComposerOpen()` now reads **only this controller's own `composerOpen` flag** (set
solely when *we* open a box in `openCommentInput`). Removed the `isCommentInputFocused()` focus probe
from the union — the URI (`commentinput-<threadUUID>` under the shared extension authority) cannot
distinguish our `codev-builder-review` controller from `plan-review.ts`'s `codev-review` controller, so
the probe was the leak. Submit stays reliable: the normal open→dictate→submit flow keeps the box
focused, and `editor.action.submitComment` is focus-gated host-side (a stale flag yields a no-op submit
or an extra open — never a phantom submit). Added a regression test in `builder-review-submit.test.ts`:
a focused `commentinput-…` editor with our flag clear now reads composer-CLOSED (a diff dial will not
submit a foreign plan/spec box). Residual, documented: an extremely narrow sequence (our box opened
*then* dismissed by native Escape leaving the flag stale-true, *then* a plan box focused, *then* a diff
dial pressed) could still submit the focused box — non-destructive (commits the user's own prose to its
intended place) and the same bounded native-Escape edge already recorded; #1560's thread-owning rework
removes it entirely.

**2. Artifacts contradictory (plan says file=cancel/selection=inert; impl ships file=no-op/
selection=submit; obsolete cancel comments; forward-mode button still says "Queue Comment for
Builder"). "Update the plan/review/source text and use a mode-neutral Submit label."**

FIXED across the board:
- **Plan** (`codev/plans/1552-*.md`): added **Delta 2** to the scope-delta block recording ruling B —
  dial cancel dropped (`open | submit | noop`, file dial = no-op), selection = open-or-submit, and the
  `hideComment`/`closeActiveEditor` dead-ends. The plan no longer contradicts what shipped.
- **Source comments**: `feedback.test.ts` header rewritten (it still read "file = cancel, selection =
  inert"); the `SUBMIT_FOCUSED_COMMENT` doc block no longer references the removed
  `isCommentInputFocused()`; no obsolete cancel-executor references remain (grep-clean).
- **Button label**: `"Queue Comment for Builder"` → **`"Send to Builder"`** (mode-neutral; the
  placeholder likewise), since in the default `forward` mode Submit forwards to the PTY rather than
  queueing.

## Claude COMMENT (non-blocking; all addressed anyway)

1. **Submit mislabeled in default forward mode** — FIXED (mode-neutral "Send to Builder" + placeholder).
2. **`isBuilderComposerOpen()` can't tell which comment controller is focused** — FIXED (Codex #1 above).
3. **Stale doc comment `feedback.test.ts:8-9`** — FIXED (header rewritten to the shipped vocabulary).
4. **Plan file doesn't record ruling B** — FIXED (plan Delta 2 above).

## Verification

`pnpm check-types` ✓, `eslint` ✓, `node esbuild.js` (build) ✓, `pnpm test:unit` ✓ (951 tests; +1 the new
cross-controller regression). `grep` for the removed symbols (`isCommentInputFocused`,
`cancelActiveBuilderComposer`, `DECK_FLAG_BODY`, `Queue Comment for Builder`) is empty. Gemini's APPROVE
stands; Codex's REQUEST_CHANGES and Claude's four items are all resolved in code and artifacts.
