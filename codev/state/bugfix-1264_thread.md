# bugfix-1264 — double Ctrl-C no longer restarts the agent (3.2.4 regression)

> **Superseded design.** The first implementation discriminated `^C^C` from a typed quit by
> sniffing `0x03` in the shellper's input stream. The architect corrected the spec on 2026-07-27:
> the problem was never the discrimination, it's that a clean harness exit kills the shellper at
> all. The branch was force-pushed to carry only the corrected design, so the superseded commits
> (`ed10e2fc`…`3d525114`) are no longer on the branch — they remain reachable by SHA via the PR's
> force-push record. Their reasoning is kept below, because the empirical findings are what justify
> the corrected design.

## Investigate

**Empirical probes against the real Claude CLI (v2.1.220), node-pty, trusted cwd.**

| Probe | Result |
|---|---|
| Double Ctrl-C in the REPL | `{exitCode: 0, signal: 0}` |
| Typed `/quit` | `{exitCode: 0, signal: 0}` |
| Generated builder launch loop under ^C^C | bash **survives**, prints "Press Enter to relaunch" |

Exit status cannot discriminate the two gestures. (A first probe in a fresh temp cwd returned code 1
— it hit the trust-folder prompt and never reached the REPL. Discarded.)

**Why bash survives**: Claude puts the tty in raw mode (ISIG off), so `^C` is never turned into
SIGINT — it arrives as a literal `0x03` byte. That is also why the shellper *could* see it.

### Blast radius

`restartOnExit: true` is passed **only** for architect sessions (`tower-instances.ts:597`, `:1092`).
Builders and shells use `defaultSessionOptions()` and rely on the in-PTY bash loop.

- **Architect terminal** — ^C^C → session dropped, row cleared, dead, needs `afx workspace start`.
  The reported symptom.
- **Builder terminal** — bash loop Enter-gates the relaunch. Not dead.

## Superseded attempt (kept for the record)

Tracked `0x03` in `ShellperProcess.handleData`, flagged the EXIT frame, `isDeliberateExit` treated a
flagged exit as restartable. CMAP: gemini APPROVE, claude APPROVE, **codex REQUEST_CHANGES** — and
codex was right: my clear-the-stamp rule fired only on printable input, so **Ctrl-D after Ctrl-C**
would have restarted an EOF quit. Reproduced, then fixed by collapsing the rule to "the stamp
survives iff the most recent input byte is 0x03" (simpler and strictly more correct, net −11 lines).

Lesson worth keeping: two APPROVEs did not outvote one specific, reproducible finding.

## Corrected spec (architect, 2026-07-27) — what shipped

1. **Any** clean exit of the harness (^C^C, `/quit`, `exit` — no discrimination): the shellper and
   session **survive**, and the harness is rerun in the same PTY **without recovery** (no
   `--resume`; fresh conversation).
2. Unnatural exits (crash, signal, nonzero) keep restart-**with**-recovery.
3. A session ends only via explicit kill (afx / UI / `DELETE /api/terminals/:id`).

Architect decisions on my four questions: stay BUGFIX (design is human-prescribed on the issue);
**builders out of scope** (filed #1267, including that their Enter-relaunch bakes `--resume` and so
violates the corrected spec); **persist** the fresh conversation id; clean-exit reruns must not
touch the restart budget or crash-loop history.

### Implementation

All the `0x03` machinery deleted. What replaced it:

| File | Change |
|---|---|
| `session-manager.ts` | Clean exit → rerun via a caller-supplied `FreshLaunch` factory instead of ending the session. Not counted as a restart. |
| `pty-session.ts` | Clean exit takes the restart-wait path (session survives); shared with the crash path via an extracted `startRestartWait`, differing only in the notice. |
| `tower-utils.ts` | `buildArchitectFreshLaunch` — mints a new conversation id, re-injects the role, **persists** the id to the architect row. |
| `tower-instances.ts` ×2, `tower-terminals.ts` ×1 | Wire the factory. Built from `baseArgs`/`cmdParts`, never from the resolved args — those may already carry `--resume`. |

`FreshLaunch` is a **factory, not a precomputed arg list**: every clean exit is a genuinely new
conversation and needs its own id. Persisting it means a later crash resumes the post-rerun
conversation, not the one the user walked away from.

### One addition beyond the four decisions — flagged, not smuggled

Making clean-exit reruns unlimited removes a bound that **both** prior versions had (#1241 ended the
session; pre-3.2.4 had `maxRestarts`). A harness misconfigured to exit 0 on startup would then
respawn forever. So: a clean exit within `FAST_CLEAN_EXIT_MS` (2s) of launch is evidence of a broken
command rather than a human gesture — 5 *consecutive* such exits give up. A real quit never trips
it, and one fast exit followed by a healthy session resets the counter. Genuine gestures stay
unlimited, exactly as decided.

### Verification

End-to-end, real SessionManager → real shellper → real `claude`:

| Gesture | Events | Relaunch argv | Verdict |
|---|---|---|---|
| `^C^C` | `fresh-restart`, session live, agent back | new `--session-id`, **no `--resume`**, factory called 1× | PASS |
| SIGKILL | `restart#1`, session live, agent back | **argv unchanged** (recovery preserved), factory called 0× | PASS |

Unit coverage: session survival, the no-recovery guarantee, a new id per rerun, budget and
crash-loop history untouched across repeated clean exits, no-factory fallback, crash/signal keeping
recovery, PtySession's suppressed `exit` plus its bounded-wait backstop.

> Trap for the next person: don't run `pnpm build` while the suite is running — `copy-skeleton`
> does `rm -rf skeleton` and pulls it out from under every test that resolves through it. Cost me a
> phantom "108 failures across 56 files" once.
