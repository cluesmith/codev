# Phase 2 (1338) — Rebuttals, iteration 1

Reviews: **Gemini APPROVE**, **Codex REQUEST_CHANGES (HIGH)**, **Claude APPROVE (HIGH)**.
Disposition: **both Codex points accepted and fixed in commit `11527838`.** No point rejected.
Codex found two *reachable* fail-closed gaps on the restart/reconnect paths that the initial
"unreachable" analysis (and my own phase_2 design note) missed — both are now fixed and
regression-tested. Claude's and Gemini's approvals stand; Claude's non-blocking observations are
dispositioned below. Each claim was re-verified against source before revising.

---

## Codex (REQUEST_CHANGES) — both accepted, both fixed

### C1 — Fail-OPEN on reconnect: retired architect can still relaunch the Gemini binary
**Accepted (important, real bug).** Verified: `resolveArchitectRestart` (tower-utils.ts:441)
propagates `RetiredHarnessError`, and BOTH reconnect consumers in `tower-terminals.ts`
(`_reconcileTerminalSessionsInner` at the startup-reconcile site, and `getTerminalsForWorkspace`
at the on-the-fly reconnect site) wrapped that call in a `try/catch` that caught **all** harness
errors and fell back to `{ command: cmdParts[0], args: cmdParts.slice(1) }`. For a gemini architect
`cmdParts[0]` **is** the retired `gemini` binary, so Tower would auto-restart straight into it with
no role injection — a direct violation of fail-closed retirement. My phase_2 design had reasoned
these paths "unreachable" because the *initial* launch throws first; Codex correctly showed they are
reachable when a config is edited to gemini **mid-session**, or when **Tower restarts** and reads a
gemini architect config (no initial launch happened in this process).

**Change (commit `11527838`):** Extracted the two duplicated consumer blocks into one exported
helper, `buildArchitectReconnectRestartOptions` (tower-utils.ts:589), co-located with the
`resolveArchitectRestart` family. It **fails closed** on `RetiredHarnessError` (tower-utils.ts:630):
returns `undefined`, so the session reconnects to a live shellper if one exists but Tower **never
configures an auto-restart into the retired binary**. Any *other* harness-resolution error still
degrades to the plain configured command (identity preserved via `cleanEnv` / `CODEV_ARCHITECT_NAME`,
Spec 786) — that transient-failure behavior is deliberately unchanged. The single `includeFreshLaunch`
parameter preserves each call site's prior behavior exactly: startup reconcile passes `true`
(tower-terminals.ts:684, wires the #1264 clean-exit rerun), on-the-fly reconnect passes `false`
(tower-terminals.ts:920, no clean-exit rerun — as before). The #832 resume-bake and #1149
crash-loop fallback are carried through unchanged.

### C2 — Uncaught throw on clean-exit relaunch: Tower exception
**Accepted (important, real bug).** Verified: `buildArchitectFreshLaunch().next()` resolved
`getArchitectHarness` unguarded, and `SessionManager` invokes it with **no** try/catch
(`session-manager.ts:1175`: `session.options.freshLaunch?.next() ?? null`, inside an async
clean-exit handler). So an architect whose config flipped to gemini, then exited cleanly, would
throw `RetiredHarnessError` into that handler — an uncaught Tower exception.

**Change (commit `11527838`):** Guarded the `getArchitectHarness` call inside `next()`
(tower-utils.ts:544). On `RetiredHarnessError` it logs a WARN and returns the **plain** original
launch `{ args: baseArgs, env: baseEnv }` — no throw, and no re-injection of the retired harness
(`baseArgs` come from the *original supported-harness* launch, so they can never be a gemini command).
Any non-retirement error is a genuine fault and is rethrown unchanged.

### C3 — "Regression tests for both reconnect and clean-exit relaunch paths"
**Accepted.** Added **+7** tests to `tower-utils.test.ts`:
- `buildArchitectFreshLaunch retirement (#1338)` (2): gemini → `next()` does **not** throw and
  returns the plain launch; codex → resolves normally (regression).
- `buildArchitectReconnectRestartOptions retirement (#1338)` (5): gemini → `undefined` regardless of
  `includeFreshLaunch`; codex → real restart options with `command`/env preserved; `includeFreshLaunch`
  toggles `freshLaunch`; a non-retirement harness error → plain-command fallback (proves the
  fail-closed change did **not** regress the transient-error path).

---

## Claude (APPROVE, HIGH) — non-blocking observations dispositioned

Claude approved and asked that two items be recorded in the review artifact; both are handled here
and will be carried into the final `codev/reviews/1338-*.md`:

- **(a) Preflight centralized at the `spawn()` dispatcher** rather than per-`createWorktree`-entry.
  **Intentional deviation from the plan's letter** — one guard above handler dispatch
  (`spawn.ts`, `mode !== 'shell'`) gives equivalent coverage of all five worktree-creating handlers
  **and** `createWorktree`'s own internal `getBuilderHarness` (spawn-worktree.ts:912), with one call
  site instead of five. Recorded; will appear in the review's Deviations section.
- **(b) `session-manager.ts:1175` `freshLaunch?.next()` is unguarded by design / unreachable.**
  This is precisely the path **Codex's C2 proved reachable** (config flipped to gemini before a clean
  exit). So rather than accept it as an unreachable non-issue, the C2 fix now **guards it at the
  source** (`buildArchitectFreshLaunch().next()`). Claude's non-blocking note and Codex's HIGH finding
  converge on the same site; it is now actively fail-closed, not merely assumed unreachable.

Claude's other minor notes are acknowledged, no change: **#2** (harness resolved twice on the happy
spawn path — negligible config read) and **#3** (`afx setup` / `installHarnessWorktreeFiles` still call
`getBuilderHarness` raw — out of Phase 2 scope; the CLI catch prints the retirement `.message` cleanly,
so a pre-existing gemini worktree degrades to a readable message rather than a crash).

---

## Gemini (APPROVE)
No changes requested. Gemini independently confirmed the builder preflight, the `buildArchitectArgs`
fail-closed launch boundary, the `siblingRegistrationIsLive` guard, and the `tower-instances`
`addArchitect`/`launchInstance` clean-error surfacing.

---

## Verification after fixes
- `pnpm --filter @cluesmith/codev build` → exit 0 (tsc + vite clean).
- `tower-utils.test.ts` → 61 passed (includes the +7 above).
- Consumer suites `tower-terminals.test.ts` + `tower-instances.test.ts` + `bugfix-430-tower-restart.test.ts`
  → 133 passed (the reconnect/restart refactor introduces no regression).
