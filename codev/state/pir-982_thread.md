# PIR #982 — Builder thread

Issue: vscode + tower "No active terminal for X" toast is unactionable. Label: `area/cross-cutting`.

## Plan phase (iteration 1)

**Root cause confirmed by reading code:** the sidebar tree and the terminal-opener read two different Tower sources.
- Sidebar renders from `OverviewBuilder` (overview cache, `/api/overview`) — disk-sourced, **no `terminalId`** (`packages/types/src/api.ts:141-225`). Row shows while worktree exists.
- Opener `openBuilderByRoleOrId` (`packages/vscode/src/terminal-manager.ts:186-215`) reads `getWorkspaceState` → `DashboardState.builders.terminalId` (in-memory PTY session id). Tower restart drops the in-memory registry → `terminalId` null → bare warning at `terminal-manager.ts:206-209`.

**Decision:** ship Option 1 (better message) + Option 2 (in-extension recovery), defer 3/4/5.
- New toast (replacing the bare warning): names the builder, explains likely cause (Tower restart), buttons **Recover Builders** + **Retry**.
- **Recover Builders** → `createTerminal({ cwd: workspacePath })` + `sendText('afx workspace recover')` (dry-run), mirroring `commands/run-worktree-setup.ts:51-56`. Deliberately stops at dry-run (recover is workspace-wide, can't target one builder).
- **Retry** → re-attempt open (handles the transient spawn/recover race, cause 3).
- Pure-vscode, confined to the `!terminalId` branch → happy path untouched.
- Deferred: Option 3 (sidebar icon) needs a `terminalId`/liveness field threaded through overview server + types — cross-package, no extra acceptance coverage → follow-up issue. Options 4/5 explicitly deferred by the issue.

Toast button pattern reference: `notifications/gate-toast.ts:109-139`. Tests extend `packages/vscode/src/__tests__/terminal-manager.test.ts` (vitest, `pnpm --filter codev-vscode test:unit`).

Plan written to `codev/plans/982-vscode-tower-no-active-termina.md`. Committed, pushed. Sitting at `plan-approval` gate.

## Plan check vs main + rebase (still at plan-approval)

Branch was 88 commits behind `origin/main` (based on `66144d90`; main at `586a2fcb`). Checked plan validity against main:
- Warning code at `terminal-manager.ts:206-209` is **byte-identical on main** — bug untouched, same lines.
- None of the plan's targeted files changed since the old base (terminal-manager, builder-row, builders, types/api.ts, run-worktree-setup, gate-toast, the test).
- Only adjacent change intersecting the plan: `overview.ts` got PIR #907's enrichment cache (for `area`) — did NOT add any `terminalId`/liveness field, and `OverviewBuilder` (api.ts) is unchanged. So the Option-3 deferral reasoning ("no liveness signal on OverviewBuilder") still holds.
- No merged PR references #982 — no duplicate fix shipped.

Rebased onto `origin/main` (586a2fcb) cleanly (no conflicts), force-pushed. Porch state intact (still gate_pending / plan / iter 1). Post-rebase line refs re-verified: warning at `:207`, `run-worktree-setup.ts:51-56` pattern present.

**Deep-dive on Tower-up causes (answered to reviewer):** `/api/state` (opener) omits a builder whose live `PtySession` is gone from `TerminalManager.sessions` (`tower-routes.ts:1834-1855` — included only `if (session)`); `/api/overview` (sidebar) is disk-sourced so still lists it. Tower-up triggers: non-shellper 5-min idle reap (`pty-session.ts:368-379`, shellper-exempt), PTY exit past 30s grace (`pty-manager.ts:97-101`), spawn race, explicit kill. For shellper-backed afx builders the dominant cause is the **shellper process dying** while Tower lives (what `afx workspace recover` targets) + the spawn race. Implication flagged: plan's toast wording "most likely Tower restarted" is too narrow — offered to broaden it.
