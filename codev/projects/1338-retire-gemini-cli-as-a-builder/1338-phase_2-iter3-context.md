### Iteration 1 Reviews
- gemini: APPROVE
- codex: REQUEST_CHANGES — Builder preflight is correct, but Tower restart paths can still launch Gemini or crash.
- claude: APPROVE — Phase 2 fails closed at every spawn and architect-launch boundary with no orphaned state and no Tower-crash path; tests and typecheck are green.

### Builder Response to Iteration 1
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


### Iteration 2 Reviews
- gemini: APPROVE
- codex: REQUEST_CHANGES — Reconnect handling is fixed, but the clean-exit path can still relaunch the retired Gemini binary.
- claude: APPROVE — Both Codex iteration-1 fail-closed gaps are genuinely fixed at the correct layer, verified against source; all Phase 2 launch/spawn boundaries fail closed with no orphaned state and no Tower-crash path; typecheck and the full 4136-test suite are green.

### Builder Response to Iteration 2
# Phase 2 (1338) — Rebuttals, iteration 2

Reviews: **Gemini APPROVE**, **Codex REQUEST_CHANGES (HIGH)**, **Claude APPROVE (HIGH)**.
Disposition: **Codex's point accepted and fixed in commit `9ec14c4d`.** No point rejected. Codex
found that the iter1 C2 fix stopped the *throw* but not the *relaunch* on the clean-exit path — a
genuine, deeper fail-open that both approving reviewers missed. Fixed by extending the `FreshLaunch`
contract with a fail-closed `stop` signal. Claude's non-blocking test-isolation nit is also addressed.
Each claim was re-verified against source before revising.

---

## Codex (REQUEST_CHANGES) — accepted, fixed

### C3 — Clean-exit path still relaunches the retained retired `command`
**Accepted (important, real fail-open).** Verified against source. My iter1 C2 fix had
`buildArchitectFreshLaunch().next()` return `{ args: baseArgs, env: baseEnv }` on retirement. That
prevents the uncaught throw, but **`FreshLaunch.next()` can only influence `args`/`env` — never the
launch `command`.** SessionManager's clean-exit handler retains the original command and respawns it:

```
// session-manager.ts (pre-fix)
const fresh = session.options.freshLaunch?.next() ?? null;
if (fresh) { session.options.args = fresh.args; if (fresh.env) session.options.env = fresh.env; }
...
session.client.spawn({ command: session.options.command,  // ← RETAINED, not from next()
                       args: session.options.args, ... });
```

So if the retained `command` is itself the retired binary — reachable when an architect launched via
a **custom `gemini` harness** (the explicit escape hatch) whose definition is later removed, or a
config edit flips the harness to the retired built-in before a clean exit — returning `baseArgs`
still respawns `gemini`. Codex is right; Claude's iter2 "safe because freshLaunch is only wired when
the harness resolved cleanly" reasoning missed that a *custom gemini* resolves cleanly at wire time,
so the retained command can legitimately be `gemini`.

**Change (commit `9ec14c4d`):** gave `FreshLaunch` a fail-closed **stop** signal — the only way for
the factory to prevent a respawn it cannot re-command.
- `FreshLaunch.next()` return type is now
  `{ args: string[]; env?: Record<string, string> } | { stop: true } | null` (session-manager.ts:73),
  documented in the interface's doc comment.
- SessionManager's clean-exit handler honors it (session-manager.ts:1184): on `{ stop: true }` it does
  **not** respawn — it ends the session (`removeDeadSession`) and surfaces the reason in the pane via
  `session-gave-up` → `PtySession.notice` (tower-server.ts:479), the same visible-teardown UX as the
  existing fast-clean-exit valve. It returns before the rerun/`session-fresh-restart` path.
- `buildArchitectFreshLaunch().next()` returns `{ stop: true }` on `RetiredHarnessError`
  (tower-utils.ts:551) instead of `{ args, env }`. Non-retirement errors are still rethrown.

**End-to-end regression test (exactly what Codex asked for):** `session-manager.test.ts:2493` drives
the **real** clean-exit handler with a session whose retained `command: "gemini"` and a `{stop:true}`
freshLaunch → asserts `client.spawn` is **never** called, the session is removed, and a `retired`
reason (containing `gemini`) is surfaced. The iter1 test only checked returned args; this exercises the
retained command, which is where the bug lived.

**Blast radius:** `FreshLaunch` is architect-only — the sole implementer is `buildArchitectFreshLaunch`
and the sole `.next()` consumer is `session-manager.ts:1184`. Other freshLaunch return paths (no
recovery / resumable-session) are unchanged; every non-architect session (plain shells, builders) never
constructs a `FreshLaunch`, so the added branch cannot affect them.

---

## Claude (APPROVE, HIGH) — non-blocking nit addressed

Claude approved. Its one non-blocking observation: the three `#1338` retirement describes in
`tower-utils.test.ts` didn't isolate `HOME` or clear `TOWER_ARCHITECT_CMD`, unlike
`spawn-retirement.test.ts` / `config.test.ts`. Verified the precedence: `getArchitectHarness` →
`getResolvedCommands` gives `TOWER_ARCHITECT_CMD` precedence over workspace config (config.ts:241),
and `loadUserConfig` can read a global `~/.codev/config.json` (HOME). A dev with either set locally
would see a loud, misleading failure.
**Change (`9ec14c4d`):** added a shared `isolateHarnessEnv()` helper (sets an isolated `HOME`, clears
`TOWER_ARCHITECT_CMD`/`TOWER_BUILDER_CMD`, restores in teardown) and wired it into all three describes.

---

## Gemini (APPROVE)
No changes requested. Gemini re-confirmed the spawn preflight, the `buildArchitectArgs` /
`launchInstance` / `addArchitect` launch-boundary handling, the `siblingRegistrationIsLive` guard, the
C1 reconnect fail-closed, and the C2 clean-exit guard.

---

## Verification after fixes
- `pnpm --filter @cluesmith/codev build` → exit 0 (tsc + vite clean).
- `tower-utils.test.ts` + `session-manager.test.ts` → 152 passed (incl. the new stop assertion, the
  env isolation, and the `command: "gemini"` e2e regression).
- Consumer suites `tower-terminals.test.ts` + `tower-instances.test.ts` + `bugfix-430-tower-restart.test.ts`
  → 133 passed (no regression from the `FreshLaunch` contract addition).


### IMPORTANT: Stateful Review Context
This is NOT the first review iteration. Previous reviewers raised concerns and the builder has responded.
Before re-raising a previous concern:
1. Check if the builder has already addressed it in code
2. If the builder disputes a concern with evidence, verify the claim against actual project files before insisting
3. Do not re-raise concerns that have been explained as false positives with valid justification
4. Check package.json and config files for version numbers before flagging missing configuration
