# Spec 1658 — Iteration 1 rebuttal

All REQUEST_CHANGES points were accepted and applied (commit `[Spec 1658] Specification with
multi-agent review`). No disagreements.

## Claude (REQUEST_CHANGES)

1. **C1 left the husk sweep with no start time.** Accepted. Area C now requires the Windows
   census provider to return pid, ppid, command line **and creation time**, and explains why:
   the husk sweep and the registered-PID set skip any process whose start time is null. The
   "DB PIDs + taskkill only" option is now stated to forfeit the sweep, so it fails parity.
   Open Question 2 was rewritten so the owner sees that trade-off.
2. **Worktree removal and open handles.** Accepted. Added three things:
   - a success criterion (removal succeeds despite transient handles, or fails clearly);
   - retry-with-backoff and junction-safe deletion in Area E;
   - test scenario 6a and a risk row.
3. **Long paths need admin.** Accepted. Long paths moved out of nice-to-know:
   - an assumption (`LongPathsEnabled` assumed off; per-user `core.longpaths`);
   - a success criterion (typical-depth workspace works; doctor checks depth and `core.longpaths`);
   - test scenario 6b and a risk row.
4. **`tea` missing.** Fixed. Assumptions now list the provider CLIs as `gh`, `glab`, `tea`.
5. **Session id parsed from the `.sock` basename.** Added to Area A's list of endpoint-string
   dependencies.
6. **Owner lock already self-clears.** Noted in Area B, so the plan won't over-engineer the
   graceful Tower-stop path.

## Codex (REQUEST_CHANGES)

1. **HELLO secret vs "not connectable."** Accepted. The criterion now states testable
   semantics: an unauthenticated connection receives zero bytes and its frames have no effect.
   Area A states plainly that the secret gate does not prevent opening a handle, and that
   OS-level non-connectability (a DACL) is Open Question 6 for the owner.
2. **Detect-and-warn isn't parity.** Accepted. Survival is now *required* on documented launch
   paths. A kill-on-close job context must either relaunch Tower outside the job (WMI
   `Win32_Process.Create` or a scheduled task, both without native code) or refuse with an
   actionable error. Open Question 3 asks the owner to choose; warning alone is ruled out.
3. **`taskkill /T` plus a degraded sweep can't guarantee "no descendants."** Accepted.
   - Teardown now takes a pre-kill census snapshot and kills recorded descendants explicitly,
     using creation time as a PID-reuse guard.
   - The sweep is the backstop.
   - Census unavailability is a reported failure, not a supported mode ("No degraded mode at
     parity").
4. **Build Tools fallback contradicts the locked-down target.** Accepted. The supported Windows
   Node versions are defined as those with prebuilds. A new criterion requires a clear failure,
   never a silent source build.
5. **Agent vs shell terminal semantics.** Accepted. The success criteria, Desired State and test
   scenario 3 now distinguish:
   - agent terminals, which run the harness directly;
   - human shell terminals, which run PowerShell.

   The reading of ruling 4 is recorded in Assumptions and raised as Open Question 10 for owner
   confirmation, rather than decided unilaterally.
6. **Critical questions resolved at the gate.** Agreed. Open Questions 1 and 2 remain Critical,
   explicitly for the spec-approval gate. Open Question 1 proposes a promotion criterion: N
   consecutive green runs on main without a Windows-only flake. The owner sets N.

## Gemini (COMMENT), suggestions also adopted

- `.cmd` shims can't run under ConPTY's `CreateProcess`: added to Area D, with a risk row.
- MSYS output-path normalization (`/c/...` back to `C:\...`): added to Area D and a success
  criterion.
- `taskkill /T` on an already-dead root walks nothing: covered by the pre-kill snapshot, and
  added to test scenario 6.
- Junction deletion must not traverse targets: added to Area E, the success criteria, and
  scenario 6a.
- Secret delivered through environment or stdin, never argv: made explicit in Area A.
