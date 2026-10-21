# Review: Native (non-WSL) Windows Support

**Spec**: [codev/specs/1658-windows-native-non-wsl-support.md](../specs/1658-windows-native-non-wsl-support.md)
**Plan**: [codev/plans/1658-windows-native-non-wsl-support.md](../plans/1658-windows-native-non-wsl-support.md)

> In progress. This document is started early, during Phase 1, so owner rulings are recorded
> when they are made. It is completed in the review phase.

## Root cause of the 2026-09-09 `afx tower start` hang

**Owner ruling (2026-10-21T07:41:34Z, relayed by main): criterion discharged as not reproducible.
No further hunt.**

Evidence, from `codev/projects/1658-windows-native-non-wsl-support/audit.md` §1.6:

- The hang does not reproduce on **3.3.3**, the release current on 2026-09-09 (published 09-05;
  3.3.4 followed on 09-17), or on the current **3.3.5**. Both were installed globally from npm and
  reach ready in about 3 s. Covered: GitHub's `windows-latest` (x64) and `windows-11-arm` (ARM64),
  Node 22 and 24; and the owner's Windows 11 Home machine (3.3.5, Node 24). Runs 39556358109,
  39560462785 and 39562480678.
- The leading mechanism was **ruled out by direct test**. It was a Tower left alive by a broken
  `afx tower stop`, which then blocks the next start on the same port. The sequence start →
  `tower stop` → start again does not hang: the second start detects the live Tower over HTTP
  and exits 0.
- On Node 20, neither release can be installed on Windows (no better-sqlite3 prebuild), so a
  Node 20 attempt fails at install, not at start.
- The only untested candidate is the state of the 2026-09-09 machine itself, which is not
  available.

A real defect turned up along the way: **`afx tower stop` cannot stop Tower on Windows.** Its
`lsof` port lookup fails under `cmd.exe`, so it prints "Tower is not running" and exits 0 with the
daemon still alive. Phase 4 fixes this.

## Flaky Tests

- **Unidentified intermittent failure under `porch done` (Phase 1, 2026-10-21).** The porch
  `tests` check failed twice (51 s, against ~38-40 s for passing runs) and passed on the next
  attempt. Six direct runs passed: `npm test` from the root, `vitest run` in the package, porch's
  `PROJECT_ID`/`PROJECT_TITLE` env set, and a script reproducing porch's detached-process-group
  spawn. Porch prints only a failed check's **stderr**, which held the harmless expected output of
  the `bugfix-1455` pr-create tests. The failing test's name was in stdout, which porch does not
  show. Next time, read `packages/codev/node_modules/.vite/vitest/<hash>/results.json` right after
  the failed check: it records per-file pass/fail. Porch hiding a failed check's stdout is worth a
  separate issue.
