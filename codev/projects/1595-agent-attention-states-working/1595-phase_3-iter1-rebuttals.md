# Phase 3, iteration 1: rebuttal

Fix commit: `236be303f`. All points accepted; no disagreements.

## Codex (REQUEST_CHANGES)

1. **Stored `workspace_path` not normalized.** Accepted and fixed. `identity.ts` now normalizes both sides of the workspace comparison for builders and architects. Rows stored in the canonical spelling are tried first, and rows under another spelling are realpathed only when that misses, so the common case costs nothing extra. New tests: a builder row and an architect row whose stored `workspace_path` is a symlinked spelling (the architect one with a trailing slash) both resolve to the canonical workspace and id.
2. **`invalidateAgentIdentityMemo` has no production callers.** Accepted and fixed differently from a call-site hook. Most registry writes happen in other processes (`afx spawn` and `afx cleanup` write `global.db` directly), so no Tower-side hook could see them. The memo now records a registry version token, SQLite's `PRAGMA data_version` (moves on another connection's commit) plus this connection's `total_changes()` (moves on Tower's own writes). A cached resolution is reused only while the token is unchanged, and the 5 s TTL stays as a backstop. A removed agent therefore stops resolving on the next report. New tests: removal on the same connection, removal through a second connection (another process), and a memo hit that skips the registry query until the TTL lapses. `invalidateAgentIdentityMemo` stays as a reset seam, and its doc no longer claims production wiring.
3. **Tests could not run in the review sandbox.** Environmental. Locally, the agent-state suite passes (67 tests), as do `npm run build` and the full suite (6929 tests).

## Claude (COMMENT)

- **`overview-changed` per accepted report.** Accepted. `agent-state/broadcast.ts` coalesces changes per workspace into one notification 500 ms after the first change of a burst (trailing), well inside SC1's 5 s budget. `tower-server.ts` wires the store's change event through it. Tested with fake timers.
- **Unwired memo invalidator.** Addressed under Codex 2.
- **Store-to-overview key join.** Recorded for phase 5 in the thread log: assert the join for a role-shaped-id row and a legacy row.
- **`detailFor` keeps the stored detail on a tool-less needs-input with a different kind.** Kept as is. It matches the spec's wording, and the only tool-less report in the mapping is the redundant permission notification.
- **Phase 6 coupling (strict field coherence).** Recorded for phase 6 in the thread log.
- **`realpathSync` per candidate row.** Acknowledged. The memo makes the lookup rare, and the canonical-spelling-first pass limits it to this workspace's rows.

## Gemini (APPROVE)

No action needed.
