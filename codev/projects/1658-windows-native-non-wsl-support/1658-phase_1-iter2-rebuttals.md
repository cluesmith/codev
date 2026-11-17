# Phase 1 iteration 2: rebuttals

Gemini: non-blocking skip (`agy` not signed in). Codex: REQUEST_CHANGES (2 points). Claude: APPROVE
(non-blocking items). Both Codex points were accepted, fixed, and re-measured in run 39562480678,
which is green on every job.

## Codex

1. **"`runIsolatedTower()` can report green when Tower hangs or fails."** Accepted and fixed. A
   Tower section now sets `failure` when `afx tower start` times out (the 120 s hang bound), exits
   non-zero, when the restart's second start hangs, or when the published install fails.
   `section()` turns `failure` into `ok: false`, the probe exits non-zero, and the step fails. The
   one known-bad leg, Node 20's published install (audit 1.1: no better-sqlite3 prebuild), is
   marked `continue-on-error` in the workflow with the reason inline. It is still recorded as
   failed in its report, but it does not hide other results.
2. **"The 2026-09-09 release (3.3.3) exists and is testable."** Accepted; this was my error.
   `npm view` shows 3.3.3 as the latest release on 2026-09-09 (published 09-05, 3.3.4 on 09-17).
   `--tower-published` is now repeatable, and the workflow takes a version list. Result: 3.3.3
   installs and reaches ready on x64 and ARM64, Node 22 and 24, and its restart sequence does not
   hang. So the hang reproduces on neither the release from that day nor the current one. The only
   untested candidate left is that machine's own state. `audit.md` §1.6 is updated. The
   owner-decision request already with the architect (how "root cause identified" is discharged)
   now rests on this stronger evidence.

## Claude (non-blocking)

1. **HEAD's workflow not yet dispatched green.** Done: run 39562480678 is green on all jobs (the
   ARM build issue was scoped to x64 in the previous commit).
2. **Job-flags comment overclaims.** Fixed. The comment now says `limitFlags` describes the child
   PowerShell's job, which under SILENT_BREAKAWAY_OK need not be Node's, and that only the
   empirical survival test is authoritative (as audit 1.4 says).
3. **conhost row.** Still an acknowledged gap, asked of the owner and otherwise deferred to the
   PR-gate pass.
4. **Hang criterion is an owner decision.** Agreed; it is with the architect.
