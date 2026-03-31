# Review: Porch Gate Notifications via `afx send`

## Summary

Replaced the broken polling-based gate watcher with direct `afx send` calls from porch. When porch sets a gate to `status: pending`, it now immediately calls `afx send architect` to notify the architect terminal. The old gate watcher (10s polling, blind to builder worktrees) has been removed.

## Spec Compliance

- [x] When porch hits any gate, the architect terminal receives a notification within seconds
- [x] Notification works regardless of whether the builder is in a worktree or the main repo
- [x] Gate watcher polling code removed (no more 10s polling)
- [x] If `afx send` fails, porch continues normally (fire-and-forget)
- [x] Message format matches convention: `GATE: {name} (Builder {id})`

## Deviations from Spec

1. **`gate-status.ts` preserved**: The spec said to remove it, but Gemini's plan review caught that it's still used by the dashboard API (`tower-terminals.ts`, `tower-instances.ts`). Only the active poller (`gate-watcher.ts`) was removed; the passive status reader was kept.

2. **Two call sites, not three**: The spec mentioned three gate-pending paths, but the third ("merge-approval gate for bugfix protocol") doesn't exist in the current code — it flows through the same general gate-pending check. The two actual gate-transition points (max-iterations line ~496, post-consultation line ~624) are covered. The re-request path (line ~284) was deliberately excluded per Codex's review — it detects an already-pending gate, not a transition.

3. **Separate `notify.ts` module**: The spec suggested adding to `next.ts` or a new file. We chose a separate module for testability (exported function can be mocked/tested independently).

## Lessons Learned

### What Went Well

- **3-way plan review caught a critical bug**: Gemini identified that `gate-status.ts` is used by the dashboard API. Deleting it would have broken the build. This saved a full iteration.
- **Codex refined notification semantics**: Codex correctly distinguished between gate transitions and re-requests, preventing unnecessary notification spam.
- **Small, focused phases**: Two phases (add + remove) made each step independently verifiable and reviewable.

### Challenges Encountered

- **npm dependencies not installed in worktree**: First `npm run build` failed because `node_modules` wasn't populated. Resolved by running `npm install` first.

### What Would Be Done Differently

- The spec could have been more explicit about `gate-status.ts` vs `gate-watcher.ts` — they have similar names but very different roles (passive reader vs active poller).

## Technical Debt

- None introduced. Net deletion of ~300 lines of polling infrastructure.

## Follow-up Items

- When Spec 0110 (messaging infrastructure) lands, `notifyArchitect()` will benefit from the message bus and standardized agent names automatically — no changes needed in porch.
- The task description text in `next.ts` still contains human-readable `afx send` instructions for the builder AI as a fallback. These could be removed since porch now handles notification directly, but they're harmless.
