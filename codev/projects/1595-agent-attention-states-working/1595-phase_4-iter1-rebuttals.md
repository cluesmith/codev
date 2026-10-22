# Phase 4, iteration 1: rebuttal

## Codex (REQUEST_CHANGES)

**A failed census could still advance agents toward dead.** Accepted and fixed (4961afb34). `observe()` now checks for a failed census before anything else, so every agent reads `alive: null` on a failed census, including agents with no session, an exited session, or an architect in restart wait. No confirmation counter moves. New test: "a failed census publishes null even for agents decided by session facts alone". It covers all three cases and shows that two failed sweeps count for nothing.

## Claude (APPROVE, non-blocking notes)

1. **Builder key-space join between liveness and the store.** Deferred to phase 5 by design, as the reviewer recommends. Phase 5 owns the overview join and its key-join test, which uses a role-shaped row and a legacy row. If the keys diverge, the result is graceful: the PTY-silence fallback applies. Recorded in the thread.
2. **Counter not reset on unknown.** Intentional: an unknown sweep should neither erase evidence nor add to it. Now stated in the module header.
3. **`since` of a dead flip is the confirming sweep.** Documented in the header, for phase 5's rendering.
4. **Shell-wrapped direct architect.** In spec: unrecognized shapes are accepted. Will be noted in phase 8.
5. **Untested dedupe.** Added a test: the first entry under a shared key wins.

## Gemini (COMMENT)

The lane was skipped because `agy` exited with code 3. No review content to address.
