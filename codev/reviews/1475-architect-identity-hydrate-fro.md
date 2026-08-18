# PIR Review: Architect identity hydrated from the WELCOME frame

Fixes #1475

## Summary

Session identity — the value that decides which render-gate classifier profile a session gets, and
therefore whether `afx send architect` delivers or holds `no-profile` — was **inferred** from the
launch command Tower recorded (Spec 1313, migration v16, plus a legacy self-heal from config). This
PR makes it **authoritative**: the shellper, which owns the PTY, reports the argv it actually
spawned on the WELCOME handshake frame; `PtySession.command` reads *through* to that on every
access, and Tower persists the hydrated value back to `terminal_sessions.command`. The Spec 1313
chain stays intact as the fallback for a pre-#1475 shellper, a local node-pty session, or a payload
that fails validation.

The design choice that matters is **read-through, not snapshot-at-attach**: both production relaunch
paths (#1264's clean-exit rerun and #1149's crash-loop fallback) re-spawn through the *same* client
with no re-attach and no reconnect, so a value captured at attach time would silently go stale
exactly when a harness changes.

## Files Changed

Against `git merge-base main HEAD` (`9129ab81c`):

- `packages/codev/src/terminal/shellper-protocol.ts` (+28 / -0)
- `packages/codev/src/terminal/shellper-process.ts` (+19 / -1)
- `packages/codev/src/terminal/shellper-client.ts` (+107 / -0)
- `packages/codev/src/terminal/pty-session.ts` (+46 / -6)
- `packages/codev/src/terminal/pty-manager.ts` (+9 / -5)
- `packages/codev/src/agent-farm/servers/tower-utils.ts` (+49 / -0)
- `packages/codev/src/agent-farm/servers/tower-terminals.ts` (+50 / -5)
- `packages/codev/src/agent-farm/servers/tower-instances.ts` (+14 / -2)
- `packages/codev/src/agent-farm/servers/tower-routes.ts` (+13 / -2)
- `packages/codev/src/agent-farm/servers/tower-server.ts` (+9 / -1)
- `packages/codev/src/agent-farm/servers/mailbox-wiring.ts` (+19 / -10)
- `packages/codev/src/terminal/__tests__/welcome-identity.test.ts` (+320 / -0, new)
- `packages/codev/src/agent-farm/__tests__/pir-1475-welcome-identity.test.ts` (+256 / -0, new)
- `packages/codev/src/agent-farm/__tests__/send-architect-identity.test.ts` (+36 / -3)
- `packages/codev/scripts/pir-1475-dev-approval-evidence.mts` (+666 / -0, new)
- `codev/evidence/1475-dev-approval-transcript.txt` (+82 / -0, new)
- `codev/resources/arch.md` (+1 / -1)
- `codev/plans/1475-architect-identity-hydrate-fro.md` (+340 / -0, new)
- `codev/state/pir-1475_thread.md` (+149 / -0, new)
- `codev/projects/1475-architect-identity-hydrate-fro/status.yaml` (+22 / -0, porch bookkeeping)

## Commits

- `09b6a513c` [PIR #1475] Plan draft: hydrate identity from the WELCOME frame
- `ba15d2723` [PIR #1475] Plan revised: read-through identity, `|| null` persist, all 7 attach sites
- `f445c8fb2` [PIR #1475] Carry spawned argv on the WELCOME frame (protocol, shellper, client)
- `c16368c0c` [PIR #1475] Read session identity through the live shellper client
- `ece20901d` [PIR #1475] Persist the hydrated identity back to the session row
- `b3c31e36b` [PIR #1475] Tests for the identity seam; document the handshake
- `6fa7631e0` [PIR #1475] Thread: implement phase notes
- `21f4dea69` [PIR #1475] Running evidence: isolated-Tower e2e, and the arg-bound bug it caught

(`chore(porch): …` bookkeeping commits are interleaved.)

## Test Results

- `pnpm build` (packages/codev): ✓ pass
- `tsc --noEmit`: ✓ clean
- `vitest run`: ✓ **4944 passed / 0 failed / 48 skipped** (249 files passed, 3 skipped), of which
  **32 are new** across the two new suites (17 in `welcome-identity.test.ts`, 15 in
  `pir-1475-welcome-identity.test.ts`).
- **Manual verification (dev-approval gate)**: the plan's Manual steps 2–7 were **scripted against a
  real, isolated Tower** rather than asserted from the unit suite —
  `packages/codev/scripts/pir-1475-dev-approval-evidence.mts` spawns this branch's built
  `tower-server.js` on private ports 14782/14783 (`NODE_ENV=test`, `AF_TEST_DB=test-1475-<port>.db`,
  its own `SHELLPER_SOCKET_DIR`), registers real shellper-backed PTY sessions and drives the real
  HTTP endpoints. **23/23 checks passed, 0 skips**; the live Tower on port 4100 was asserted
  untouched before and after (same PID). Full transcript committed at
  `codev/evidence/1475-dev-approval-transcript.txt`. Human approved the gate on 2026-08-18.

Covered by that run, all passing: baseline delivery; `source=welcome` hydration; Tower restart →
reconcile adopts the live shellper, WELCOME beats a row drifted to `agy`, delivery works and
persist-back corrects the row; clean-exit SPAWN relaunch with **no** Tower restart; a genuine
pre-#1475 shellper → `source=config` with the legacy NULL row **staying NULL**; and a wrapped
`.builder-start.sh` builder still delivering via the launch-script backstop.

## Architecture Updates

**COLD only — `codev/resources/arch.md`** (Shellper Lifecycle → Connect). The handshake step now
states that WELCOME carries the spawned `command`/`args`, that those fields are authoritative and
read through on every access, that the persisted `terminal_sessions.command` is the fallback, and
*why* every WELCOME field is optional-by-design: `PROTOCOL_VERSION` must not move, because the
client rejects any shellper **older** than itself — bumping it would disconnect every live
pre-upgrade shellper on the first restart after an upgrade.

**No HOT change.** `arch-critical.md` is at its 10-fact cap, and the existing Spec 1313 fact
("`afx send` is mailbox-first … never write a PTY directly") already states the invariant a future
agent must not break. This PR changes where identity *comes from*, not the mailbox+gate rule, and
nothing here is worth displacing a current hot fact for.

## Lessons Learned Updates

**COLD only — `codev/resources/lessons-learned.md`**, two entries:

1. *(Security / validation)* **A bound that rejects atomically must be sized against the largest
   real input, not the typical one.** This is the bug the running evidence caught, and it is the
   headline of this project — see below.
2. *(Testing)* **A suite that builds its own fixtures cannot tell you what the real input looks
   like.** 4944 unit tests exercised the identity path and every one of them passed while the
   feature was, in production, doing the opposite of its purpose for every architect session.

**No HOT change.** `lessons-critical.md` is at its 10-lesson cap and already carries the general
form — *"It compiled" / "tests pass" is not "it works" — verify the real user path end-to-end before
calling it done.* Both new lessons are concrete instances of that rule, which is exactly the
hot/cold split the two-tier model asks for: the rule stays hot, the war story goes cold.

### The bug the evidence caught

My bounded validation capped **each** WELCOME argument at 4096 bytes and rejected the identity
**atomically** — any one bad element discards `command` *and* `args`. Architects launch as:

```
claude --session-id <uuid> --append-system-prompt "<the entire role document>"
```

That last argument is several KB in a single string. Every architect tripped the per-arg cap, the
atomic rejection threw away the whole identity, and every architect session silently fell back to
`source=config` — precisely the sessions this feature exists to make authoritative, and precisely
the `afx send architect` case Spec 1313 was about. The feature would have shipped looking correct.

The fix bounds the **aggregate** args size (512 KB, well above any real argv and far below the
frame cap) while keeping the count bound (256) and the PATH_MAX-shaped command bound (4096).
Regression test: *"accepts a REAL architect argv, whose system prompt is several KB in one
argument."*

Two things made this findable only by running it: the cap was reasonable-looking, and the failure
was **silent** — a fallback, not an error. Fail-soft paths need evidence from real inputs precisely
because they never go red.

## Things to Look At During PR Review

- **`shellper-client.ts` — the validation bounds.** The interesting question is not the numbers but
  the *shape*: aggregate vs per-element, and atomic vs partial rejection. It is a sanity check
  against a garbled frame, not a security boundary (the frame already arrives over an owner-only
  socket and is capped by the parser's `MAX_FRAME_SIZE`). If you think atomic rejection is wrong,
  say so — it is deliberate, and it is what turned an oversized argument into a silent
  whole-identity loss.
- **`pty-session.ts` — read-through getters.** `command`/`launchArgs` answer from the live client on
  every access rather than snapshotting at attach. That is what keeps identity correct across a
  SPAWN relaunch, and it is pinned by *"tracks a SPAWN relaunch with no re-attach and no reconnect"*
  — a test written to fail against the snapshot design I originally proposed.
- **Persist-back at all seven attach sites, and never `''`.** `persistableCommand()` returns
  `session?.command || null`. Writing `''` instead of `NULL` would permanently defeat the Spec 1313
  legacy self-heal (`??` treats `''` as present). The legacy-NULL round trip is pinned in both the
  unit suite and the evidence transcript.
- **A rebutted plan-review finding, re-stated so the reviewer can disagree.** Codex's plan review
  asked for row persistence at SPAWN time. I rebutted it and the architect accepted: the row can go
  stale after a relaunch, but is never *observable* — `terminal_sessions.command` is read only at
  the two reconcile paths, both of which attach a fresh client whose WELCOME supersedes it and then
  persist the correction. The obvious hooks would not work anyway: `session-fresh-restart` and
  `session-restart` both fire *before* the delayed `client.spawn()`. Pinned by test rather than by
  new terminal→DB event plumbing.
- **One disclosed deviation from the approved plan.** `persistableCommand` lives in `tower-utils.ts`,
  not `tower-terminals.ts` as planned: `tower-terminals` already imports `tower-instances`, so the
  planned home would have closed an import cycle. Same behavior, different file.
- **One honest limit of the evidence.** Step 5 cannot show the identity *value* changing across a
  relaunch, because neither production relaunch path mutates `session.options.command` (#1338) —
  they swap args/env only. The transcript says so in a `note`; the read-through-vs-snapshot
  distinction is pinned by the unit test instead. Step 4's row drift is staged by writing the DB row
  directly, which is disclosed in the script header (drift is produced in the field by a config edit
  plus the Spec 1313 heal, which cannot be forced through the public API).

## How to Test Locally

- **View diff**: VSCode sidebar → right-click builder `pir-1475` → **Review Diff**
- **Run dev**: VSCode sidebar → **Run Dev**, or `afx dev pir-1475`
- **Re-run the evidence yourself** (this is the fastest way to see the whole feature work; it never
  touches the live Tower on 4100, and refuses to run against a port it did not itself bind):

  ```bash
  cd packages/codev && pnpm build
  node --experimental-strip-types scripts/pir-1475-dev-approval-evidence.mts
  # PIR1475_ONLY=5 … to drive a single scenario while iterating
  ```

- **What to verify** (maps to the plan's Test Plan):
  - `afx send architect "ping"` → `delivered`, and the Tower log shows
    `[identity] … identity hydrated from WELCOME — command=…, source=welcome, row=…`
  - Restart Tower → reconcile adopts the live shellper → send again → still `delivered`,
    still `source=welcome`
  - Quit the architect harness cleanly (#1264 reruns it via SPAWN) without restarting Tower → send
    → `delivered`
  - A pre-#1475 shellper → `source=config`, delivery still works, and a legacy NULL row stays NULL
  - A wrapped builder (`.builder-start.sh`) → `delivered` via the launch-script backstop

## Flaky Tests

None. No test was skipped or quarantined for this change; the 48 skips in the suite are pre-existing
and unrelated.
