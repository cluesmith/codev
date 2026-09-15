# bugfix-1681 — terminal reconnect budget exhausts during laptop sleep

Issue #1681. VS Code terminal tabs show a permanent `[Codev: Connection lost. unable to
reconnect after 6 attempts. Click here to reconnect]` after laptop sleep, while Tower + the
detached shellper session are perfectly healthy. Only the client view dies.

## INVESTIGATE (complete)

### Root cause
- `apps/vscode/src/terminal-adapter.ts`: `BackoffController({ maxAttempts: 6 })` +
  `scheduleReconnect()`. After 6 consecutive transient failures, `giveUp()` sets
  `gaveUp = true` **permanently** — the retry loop stops until a manual reconnect click.
- Backoff curve is `[1s,2s,4s,8s,16s,30s]` ≈ 61s total. During sleep the network stack is
  suspended, so each `connect()` fails instantly; the whole budget burns before the machine
  fully wakes. A transient OS event becomes a permanent-looking failure banner on every tab.
- The only wake signal wired is `onDidChangeWindowState` focus rising-edge (extension.ts:334),
  which calls `repaintAllOnRefocus()` — a SIGWINCH-only repaint, gated behind the off-by-default
  `codev.terminal.repaintOnRefocus`. It **never** re-arms the reconnect budget or reconnects a
  gave-up adapter.

### #936 constraint (architect brief + issue comment)
The finite budget + `giveUp` was PIR #936's deliberate fix for a pre-June infinite retry loop
against stale terminal ids. The 4xx fast give-up (`classifyUpgradeError(...) === 'permanent'` →
`giveUp('this terminal session no longer exists on Tower')`) MUST stay. A wake re-arm must
re-arm ONLY the transient give-up class, never "session no longer exists on Tower".

### Wake-signal note
The issue lists "window focus, online, visibility". The VS Code extension host is Node — there
is no DOM `online`/`visibilitychange` event (`rg` confirms `onDidChangeWindowState` is the only
window-state hook). So the trio collapses to the focus rising-edge already wired at
extension.ts:334. Will note this in the PR.

### Fix shape (scoped, ~70 prod LOC, <300 ceiling)
1. `terminal-adapter.ts`:
   - Track give-up class: `transient` (exhausted budget) vs `permanent` (4xx). Reset on
     `recordSuccess`/`reconnect`.
   - `onWake()`: no-op when disposed, permanently gave-up, or currently OPEN; otherwise
     `reconnect()` (which already resets backoff + clears gaveUp + reconnects). This also skips
     a long parked backoff wait.
   - Honest banner via one `/health` probe (injected `probeHealth` closure): exhausted path
     words the banner "Tower unreachable" (probe false) vs "reconnect failed (Tower is up)"
     (probe true) vs current "unable to reconnect after 6 attempts" (no probe / unknown).
     Permanent path keeps its existing wording.
2. `terminal-manager.ts`: `rearmAllOnWake()` iterating managed ptys; inject `probeHealth` via
   `connectionManager.getClient()?.getHealth()` (returns null on unreachable → clean boolean).
3. `extension.ts`: call `terminalManager?.rearmAllOnWake()` on the focus rising-edge,
   **unconditionally** (not behind repaintOnRefocus).
4. Tests: signal-driven re-arm reconnects a transient give-up; 4xx still gives up AND `onWake`
   does not resurrect it; banner wording split (Tower up vs unreachable). CI can't run a real
   sleep — will state what was simulated vs needs physical sleep/wake.

### Out of scope
apps/web `Terminal.tsx` may have a sleep/wake sibling — architect owns filing that separately;
I leave it untouched and will note in the PR if I confirm the gap.

## FIX (implemented, committed 13126d3a6)

Changed files:
- `apps/vscode/src/terminal-adapter.ts`: `giveUpKind` field; `enterGiveUp(kind)` +
  `renderGiveUpBanner(reason)` + async `renderExhaustedGiveUp()` (replaces old `giveUp`);
  `onWake()`; constructor gains optional `probeHealth`. `reconnect()`/open-handler reset
  `giveUpKind`.
- `apps/vscode/src/terminal-manager.ts`: `rearmAllOnWake()` + `probeTowerHealth()` (via
  `connectionManager.getClient()?.getHealth()`); inject the probe into the adapter ctor.
- `apps/vscode/src/extension.ts`: call `rearmAllOnWake()` unconditionally on the focus
  rising-edge (before the opt-in repaint).
- `apps/vscode/src/__tests__/terminal-adapter.test.ts`: +7 tests (4 wake re-arm incl. the
  4xx-permanent guard + parked-backoff + healthy-noop; 3 banner-wording split).

Verification (from worktree):
- `vitest run terminal-adapter.test.ts` → 37 passed.
- full `pnpm test:unit` → 1016 passed (83 files).
- `pnpm check-types` → clean (exit 0) after building codev-types/sdk/artifact-canvas deps.
- `pnpm lint` → clean.
- Regression pins the fix: the new tests call `pty.onWake()` (nonexistent pre-fix) and assert
  the probe-worded banners (new). CI cannot run a real sleep; the tests simulate the burned
  budget + a wake signal. A physical sleep/wake is still the true end-to-end confirmation — will
  state this in the PR.

### CMAP impl review (gemini / codex / claude)
- Gemini: APPROVE, no issues.
- Codex: COMMENT — real race: `renderExhaustedGiveUp` only rechecked `gaveUp`; a stale
  `/health` probe could overwrite a permanent 4xx banner that landed on a wake reconnect.
- Claude: APPROVE — same race (non-blocking) + 3 residuals: (2) no throttle on `rearmAllOnWake`
  (rapid refocus while Tower down restarts in-flight connects/resets budget), (3) focus is the
  only wake signal, (4) `rearmAllOnWake`/extension wiring unit-untested → do a real sleep/wake.

Resolution (commit deee898ef):
- FIXED the race (both reviewers): give-up **generation token** bumped on every give-up
  transition (enter/success/reconnect); the async banner renders only if the token is unchanged
  — closes both the permanent-overwrite and the double-transient staleness. +1 deferred-probe
  regression test (38 adapter tests now, full suite still green, types clean).
- DOCUMENTED as residuals in the PR body (out of BUGFIX scope, follow-ups): the re-arm throttle
  (2), the single wake signal (3), and the manual sleep/wake verification (4).

## Fences
terminal-adapter.ts is mine. Not touching views/tower*.ts, workspace-label.ts, fleet-order.ts,
attention-format.ts, switch-workspace.ts (pir-1566), or views/builders.ts, terminal-manager
cycle logic owned by pir-1563 — my terminal-manager edits are additive (`rearmAllOnWake` +
constructor arg), not to the cycle/focus resolution code.
