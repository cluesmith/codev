# Phase 8, iteration 2: rebuttal

Gemini lane skipped (agy exit 3). Claude: APPROVE, withdrawing its iteration-1 e2e blocker. Codex: REQUEST_CHANGES on one point, which is accepted and fixed.

## Codex

**The ignored claim-less turn end did not advance the ordering watermark (SC17).** Correct. After `Stop@100` with background work and `idle_prompt@160`, a delayed report at `130` was accepted, because `reportedAt` stayed at `100`.

Fixed in `servers/agent-state/store.ts` by splitting the two roles that `reportedAt` was carrying:
- `latestHookAt` is the ordering watermark. It advances on every accepted report, including the ignored claim-less turn end. Both ordering checks (older hook time, and a different session at an equal hook time) now read it.
- `reportedAt` stays the served `at`. That keeps the sdk's 30-minute background-work bound anchored to the `Stop` that started the hold, as Claude's iteration-2 review asked.

New test: "an ignored claim-less turn end still advances the ordering watermark (SC17)". It asserts that the delayed `tool-activity@-70` is `stale`, that the hold and its `reportedAt` are kept, that `latestHookAt` is `-40`, and that a newer `turn-started` is still accepted. The arch.md Store bullet names the watermark.

## Claude (APPROVE), non-blocking notes

1. The e2e suite on Linux CI is settled at the PR gate. Agreed; it will be checked on the PR's required checks.
2. SC1's extension surfaces were verified headless. The review will state that residual plainly, not claim SC1 fully verified.
3. Applied: one clause on the existing `arch-critical.md` global.db fact ("Exception: harness-reported agent state (Spec 1595) is Tower-memory only, never global.db."). It adds no new fact, so the cap is unchanged.
4. Applied: the arch.md known limitation now frames #1851 as a false "needs input" while the agent is working.
