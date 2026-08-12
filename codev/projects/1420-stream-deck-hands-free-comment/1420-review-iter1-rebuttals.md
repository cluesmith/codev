# PIR #1420 — Review iteration 1 rebuttals

Verdicts: **Gemini APPROVE, Claude APPROVE, Codex REQUEST_CHANGES**. PIR consultation is a single
advisory pass (`max_iterations: 1`); there is no automated re-review, so the Codex finding and this
response are escalated to the human at the `pr` gate.

## Codex (REQUEST_CHANGES) — ACCEPTED and fixed

**Finding:** Replace `Fixes #1420` with `Refs #1420`; requirements 3–4 (deck dial remap, touchstrip
legibility) remain for the Stream Deck follow-on lane, so merging this PR must not auto-close the
issue.

**Assessment:** Correct. This PR is the bridge-extension lane and lands requirements 1, 2, and 5;
requirements 3 and 4 are explicitly out of scope for this lane (per main's scoping comment on the
issue) and belong to streamdeck's follow-on. `Fixes #1420` would close the issue on merge and drop
that remaining work. The PIR review-phase prompt itself prescribes `Refs` for a partial PR.

**What changed:** Review file `Fixes #1420` → `Refs #1420` (commit `1c14cb651`), PR #1424 body updated
to match (verified: body now reads `Refs #1420`). Documented in the review's "Things to Look At"
section, including the explicit **human decision at the `pr` gate**: if the follow-on is tracked under
its own issue / #1410 and #1420 should close with this merge, switch back to `Fixes` or close the
issue manually.

## Claude (APPROVE) — non-blocking notes, no code change

1. **Duplicated open-branch body could be a shared helper.** Acknowledged; left as-is. The five-line
   body mirrors the existing `composer-open` action verbatim and matches the approved plan; extracting
   a helper for one reused branch adds indirection without removing a real maintenance hazard.
2. **No test for the edit-composer press path.** The edit path shares `composingLine`, so
   `composer-open-or-submit` while editing routes to `submit()` (submit-the-edit) through the same
   branch the "submits on second press" test already exercises; the routing is state-driven, not
   path-specific. Flagged in the review as a spot for the human to exercise at the gate rather than
   adding a redundant unit test.
3. **`composerHandleRef` null-while-open is a pre-existing silent no-op shared with `composer-submit`.**
   Correct, and pre-existing — not introduced here. Out of scope for this lane.

## Gemini (APPROVE)

No issues raised.
