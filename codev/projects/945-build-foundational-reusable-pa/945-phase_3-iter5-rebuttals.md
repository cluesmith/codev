# Phase 3 (overlay) — Rebuttal to implement consult iteration 5

**Verdicts:** Codex REQUEST_CHANGES (MEDIUM); Claude APPROVE (4th consecutive); Gemini COMMENT.
Codex raised **two** items. **Item 1 fixed; item 2 resolved as a plan-wording tightening** — both
with explicit architect authorization (the architect reviewed each on its merits). Commit
`7261fe16`.

## Codex item 1 — stale `activeLine` after a content reload (ACCEPTED & FIXED)

> "`ArtifactCanvas.tsx:25,152-179` keeps `activeLine` across content refreshes and never validates
> it against the new document. After a `watch`/`refreshKey` reload that removes or shortens the
> previously active block, the overlay can still render `+` for a stale line and emit
> `onAddComment` for a line that no longer exists."

**Legitimate correctness bug — accepted.** `activeLine` (set on hover/focus) survived a `watch`
reload or `refreshKey` bump without being reconciled against the new content, so a reload that
removed/shortened the hovered block left the overlay anchored to a line the fresh document no longer
contains — it could render `+` there and emit `onAddComment(staleLine)`.

**Fixed at root:** a small effect resets `activeLine` to `null` on **every** content change
(`useEffect(() => setActiveLine(null), [content])`), which covers both the watch-reload and the
`refreshKey`-bump paths. The user re-hovers/re-focuses to re-anchor the overlay against the fresh
content. **Regression test added:** hover the last block, trigger a `watch` reload that removes it,
then assert the `+` affordance is gone and `onAddComment` was **not** called for the removed line.
30/30 green.

## Codex item 2 — out-of-range marker should also surface via `onError?` (RESOLVED via plan-wording tightening)

> "`ArtifactCanvas.tsx:56-65` only `console.warn`s for out-of-range markers. The phase 3 plan
> explicitly resolved this policy as 'dropped and reported once via `onError?`/`console.warn`'; the
> current implementation never surfaces that condition to `onError`… Add the `onError` path and
> cover it with a test."

**The implementation is correct; the plan wording was ambiguous and has been tightened to match
it** (architect-authorized, on the same basis as the iter-4 D6 spec tightening — clarifying
unsettled wording to the semantically-correct shape, not redirecting the plan).

`onError?` is the **adapter-failure** channel — it fires when `read`/`list`/`watch` throw or return
a rejected promise (and is reserved for #863's `ThemeAdapter.resolve`/`onChange`). An out-of-range
marker is **data-hygiene during normal rendering**, not a failure: the render succeeded; a stale
marker was simply dropped. Routing it through `onError?` would force every host to treat a
non-failure as a failure and would **dilute the signal for genuine failures**. The plan's literal
`onError?`/`console.warn` phrasing (question-mark-slash) was genuinely ambiguous; it now reads:

> out-of-range markers are reported via **`console.warn` (once per session per marker)**; `onError?`
> is **reserved for genuine adapter failures** … An out-of-range marker is data-hygiene during
> normal rendering, not a failure.

The existing warn-once behavior + test (drops, warns exactly once even across reloads) already
satisfy the tightened policy; no code change for this item.

## Claude — APPROVE (4th); Gemini — COMMENT. No further changes required.

---
**Phase 3 consult arc (for the record):** 5 Codex iterations — watch-guard bug, async race,
warn-once, no-watcher refresh, stale-`activeLine` — each a legitimate, progressively smaller
refinement, all fixed; plus an iter-5 plan-wording tightening (out-of-range channel). Claude
APPROVED since iter-2; Gemini COMMENT throughout. Each item escalated to the architect when it
touched a locked contract or the plan text; both iter-5 items were reviewed and authorized on their
merits before this rebuttal.
