# PIR Review: Self-heal the "No active terminal" click (recovery as last resort)

Fixes #982

## Summary

Clicking a builder row in the Codev sidebar could dead-end on an unactionable `Codev: No active terminal for <id>` warning. The sidebar lists a builder from `/api/overview` (disk-sourced) while the terminal opener needs a live PTY session from `/api/state` (in-memory registry), which momentarily omits a builder while Tower rehydrates / on-the-fly-reconnects sessions on every call. The dominant cause is therefore transient and self-healing, but the opener warned on the first miss. This change wraps the resolve in a bounded retry (reusing the shared `backoffDelayMs` curve with interactive-tuned params) so the transient case opens silently; only a genuinely persistent miss surfaces an actionable toast that leads with **Retry** and offers **Recover Builders** (`afx workspace recover`, dry-run) as a last resort.

## Files Changed

- `packages/vscode/src/terminal-resolve.ts` (+91 / -0) — new vscode-free retry/resolve helper
- `packages/vscode/src/terminal-manager.ts` (+81 / -11) — delegate to the helper; new recovery toast
- `packages/vscode/src/__tests__/terminal-resolve.test.ts` (+147 / -0) — 7 behavioral tests
- `packages/vscode/src/__tests__/terminal-manager.test.ts` (+36 / -0) — 5 source-level wiring tests

## Commits

- `ed8e3ea4` [PIR #982] Self-heal terminal open with bounded retry; recovery toast as last resort
- `8a52338b` [PIR #982] Tests for retry-resolve helper and recovery-toast wiring

(Plus `[PIR #982]` plan and thread commits, and porch chore commits, on the branch.)

## Test Results

- `pnpm --filter codev-vscode compile` (check-types + lint + esbuild): ✓ pass
- `pnpm --filter codev-vscode test:unit`: ✓ pass (27 files, 348 tests; 12 new)
- Porch phase checks: `build` ✓ (6.5s), `tests` ✓ (20.6s)
- Manual verification: approved by the human at the `dev-approval` gate (running worktree).

## Architecture Updates

No `arch.md` changes needed. The server-side resilience for this window (the startup-reconcile barrier behind `/api/state` and `/api/overview`) is already documented at `codev/resources/arch.md:213`. This PR adds a localized, client-side bounded retry inside the existing `terminal-manager` open path; it introduces no new module boundary, endpoint, or cross-component contract, so it sits below the altitude `arch.md` records.

## Lessons Learned Updates

Added one entry to `codev/resources/lessons-learned.md` (Debugging and Root Cause Analysis): two views backed by different freshness sources can diverge *transiently*, not only on outright failure, and a bounded retry that absorbs the self-healing window beats dead-ending on the first miss. It is filed as a sibling to `[From 916]` (same divergence class, opposite direction: there the whole shared cache nulled; here a single per-builder field is briefly stale).

## Things to Look At During PR Review

- **`terminal-resolve.ts` is the core.** It is pure / vscode-free (deps injected: `sleep`, `attempts`), which is why the retry behavior is tested for real (`terminal-resolve.test.ts`) rather than through the heavy `TerminalManager` vscode harness. The retry returns a discriminated outcome (`ok` / `ambiguous` / `missing`); ambiguity short-circuits without retrying because it is stable.
- **Backoff convention.** Reuses the shared `backoffDelayMs` from `@cluesmith/codev-core/reconnect-policy` (the curve consolidated in #961), with interactive params `{ baseMs: 150, capMs: 800 }` over 4 attempts (~150/300/600ms, ~1s total) instead of the module's reconnect-loop defaults (base 1s, cap 30s), which would make a click feel laggy. A test asserts the emitted delays equal the shared curve at those params, so the convention can't silently drift back to a hand-rolled delay.
- **Recovery is deliberately demoted.** `afx workspace recover` only addresses the rare destroyed-session tail (e.g. a dead shellper) and is workspace-wide (it cannot target one builder), so the toast leads with **Retry** and the recover button stops at the dry-run preview (no `--apply`) for the user to review scope.
- **Mixed test styles, on purpose.** Behavioral tests for the pure helper; source-level (regex over source) guards in `terminal-manager.test.ts` for the vscode-side wiring (delegation, toast labels, recover command), matching that file's existing harness rationale (constructing `TerminalManager` needs broad vscode mocking).

## How to Test Locally

For reviewers pulling the branch:

- **View diff**: VSCode sidebar → right-click builder `pir-982` → **View Diff**
- **Run dev server**: VSCode sidebar → **Run Dev Server**, or `afx dev pir-982`
- **What to verify** (maps to the plan's Test Plan):
  - Transient/self-heal: click a builder row right after a spawn or while Tower is settling → terminal opens after a brief pause with **no** dead-end toast.
  - Persistent: kill a builder's shellper so its session can't reconnect → after the retries, the actionable toast appears; **Retry** re-attempts, **Recover Builders** opens a terminal running `afx workspace recover` (dry-run) at the workspace root.
  - Happy path: click a healthy builder → opens immediately, no toast.

## Build / Test Setup Note

This was a fresh worktree where `@cluesmith/codev-core` and `@cluesmith/codev-types` had no `dist/` yet, which made unrelated subpath-importing tests fail to resolve until those packages were built (`tsc`). Not a code issue, but worth knowing when running the vscode unit suite in a new worktree: build the workspace's TS packages first (or run `pnpm build`).
