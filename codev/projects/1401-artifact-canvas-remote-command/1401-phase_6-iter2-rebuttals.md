# Phase 6 (VS Code host wiring) — Iteration 2 Rebuttals

Verdicts: gemini APPROVE · claude APPROVE · codex REQUEST_CHANGES.

Three findings from codex. Two accepted and fixed; the third cannot be closed by a builder and is
escalated to the `pr` gate rather than waved through.

## 1. (Accepted) A malformed `count` was forwarded as a single command instead of rejecting the event

Codex is right on the principle, and I had it backwards. My handler dropped the bad field and ran
the command anyway, which is graceful degradation applied in the wrong place.

Tower validates `count` and answers `invalid-request` before relaying, so a bad one arriving at
the host means the frame cannot be trusted. And the specific degradation was the harmful kind:
running a traversal once when the sender asked for five is a silent change to what the reviewer
requested, which is worse than doing nothing at all. The event is now rejected whole.

Test updated to assert nothing is forwarded for a negative, fractional, or non-numeric count.

## 2. (Accepted) Reconnect discarded the `viewId` without unregistering it

Good catch, and it exposed an assumption I had baked in without stating: I treated every
reconnect as a Tower restart. It is not. A transient SSE drop reconnects to the *same* Tower,
where the old registration is still perfectly live — so dropping the id and registering afresh
left a duplicate view in the registry, competing for MRU and skewing targeting until its lease
lapsed 90 seconds later.

The old id is now released before a new one is taken. Best-effort by design: against a genuinely
restarted Tower that call 404s, which is harmless and exactly what the unknown-view path already
expects. Test added asserting the release happens on reconnect.

## 3. (Escalated, not fixed) The live VS Code end-to-end loop remains unperformed

Unchanged from iteration 1, and unchangeable from here. It requires a real VS Code window with
the extension loaded, a running Tower, and an open canvas panel; a builder in a headless worktree
cannot produce that. Claiming otherwise would be precisely the failure the "tests pass is not it
works" lesson exists to prevent, and it would be a false statement in an artifact people rely on.

What *is* verified, either side of that seam:

- Tower's route, end to end against a real booted Tower (5 e2e tests).
- The canvas seam, by unit tests, Playwright, and the user's own dev-page session.
- The sdk and the host glue, by unit tests against fakes (17 host-glue cases).

What is unverified is only the join in a live VS Code.

It is recorded as an outstanding, blocking-for-sign-off item in
`codev/reviews/1401-artifact-canvas-remote-command.md`, with a four-step script the reviewer can
run in a couple of minutes, and it is called out in the PR body. Claude's iteration-2 review
independently describes this as "properly escalated to the PR gate", which is the intent: the
`pr` gate is a human gate, and a human-only verification is exactly what belongs there.

## Verification after the fixes

- 17/17 host-glue tests, 794/794 vscode unit suite.
- `check-types` clean (both extension configs) and repo-wide; `eslint` clean on
  `src/markdown-preview/`.
- Repo build green; 4847 repo tests pass.
