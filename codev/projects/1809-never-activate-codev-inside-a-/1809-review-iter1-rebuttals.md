# 1809 review iteration 1: rebuttals and dispositions

Fixes are in commit `e7914f2ce` (pushed to PR #1846). Every finding was checked against the source before acting.

## Codex: REQUEST_CHANGES (accepted, fixed)

**Finding.** The prune keeps a stray whose persisted pid is live even when reconcile did not reattach it. For that stray, `stopInstance` finds no in-memory entry and kills nothing, so the WARN's `afx workspace stop` remedy does nothing.

**Verified.** `stopInstance` only iterates the `workspaceTerminals` entry (`tower-instances.ts:918-931`) and returns "No terminals found" otherwise. The finding is correct, and it breaks main's condition C(1), "a remedy that works".

**Change.** `liveSessionsForWorkspace` now splits live sessions into two groups:
- **attached:** in the in-memory map, so `afx workspace stop` reaches them through the unfiltered deactivate route;
- **unattached:** pid alive but not reattached.

`strayWarning` names the right remedy for each group. Attached sessions get `afx workspace stop`. Unattached sessions get their id and pid, an explicit "`afx workspace stop` cannot reach these", and an instruction to confirm the cwd and stop each one by pid. Tower still never signals any process itself: the owner and main both ruled that live sessions are never killed by this pass.

**Tests.**
- The unattached case asserts the pid-based remedy and that the attach-only wording is absent.
- The attached case asserts the `afx workspace stop` wording.

## Claude: REQUEST_CHANGES (accepted, fixed)

1. **`BuilderSpawnHandler` ungated in a worktree window.** Verified at `extension.ts:1765-1767`. Its scope check compares the payload's workspace with `getWorkspacePath()`, which is now the parent root. So a sibling lane's spawn would toast (`notify`) or auto-open the sibling's writable terminal (`auto`).
   - **Change:** it is not constructed when `isBuilderWorktreeWindow` is true. This is the same rule as the gate and mailbox toasts the owner approved suppressing.
   - **Test:** a source-level assertion, following the existing convention for `activate()` wiring.
   - The lessons-learned entry now records this as the additional subscriber found by review.
2. **Path spelling in prune liveness (minor).** Verified: the map is keyed by `normalizeWorkspacePath`.
   - **Change:** the lookup tries both the raw and the normalized spelling.
   - **Test:** a DB row spelled `<worktree>/.` with a live in-memory entry under the normalized key is kept.
3. **Agents-view flash before activation (minor): not changed.** The clause has to stay true in windows that are not worktrees before activation, because the view hosts the pre-activation "Loading Codev…" welcome (`!codev.stateKnown`). A positive-polarity clause would remove that welcome everywhere. `codev.isBuilderWorktree` is seeded at the top of `activate()`, and the view holds no data before the connection exists. The flash is short and empty.
4. **`terminal_sessions.pid` counted as liveness (minor): not changed.** This errs on the safe side, as the reviewer notes.

## Gemini: APPROVE (non-blocking note adopted)

`resolveDevTargetById`'s local fast path used the parent root. It now uses `getWindowRoot()`, so a worktree window resolves its own builder without a Tower round-trip. A source-level test covers it.

## Verification after the fixes

- `packages/codev`: the #1809 suite passes (13 tests), and the type check is clean.
- `apps/vscode`: 1217 tests pass, and `check-types` and `lint` are clean.
