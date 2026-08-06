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
