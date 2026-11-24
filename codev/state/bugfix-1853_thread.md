# bugfix-1853 thread

Issue #1853: porch done truncates failing check output; the failing test is never named.
Scope is the architect's last issue comment (2026-11-23): persist the full output of every failed
check, print the last lines instead of the first, and leave the commit-adjacent timing alone
(explained by #1956).

## 2026-11-23 — investigate

Operating rules from architect:main: no local full unit suite (#1956 load), targeted tests + build +
type-check only; open a draft PR so CI runs the suite and tell the architect before `porch done`;
present the pr gate in PRFT form.

Reproduced through porch's own `runCheck` + `formatCheckResults`, running one failing vitest test
under the real `npm test -- --exclude='**/e2e/**' <file>` command in `packages/codev`. Porch printed
five `npm warn Unknown env config ...` lines and `...`, nothing else. The failing test's name was
in two places porch never shows: stderr's `FAIL <file> > <describe> > <test>` block (the last ~18
lines of stderr) and stdout's `× <test>` line.

Root cause, `packages/codev/src/commands/porch/checks.ts`:
- `runCheck` keeps stdout in `output` and stderr in `error`; `formatCheckResults` prints only the
  first five lines of `error` and never `output`. npm writes its config warnings to stderr first, so
  the five lines are always warnings.
- The timeout result carries neither stream, so a timed-out check loses its output entirely.
- Nothing is written to disk, so a retry that passes leaves no record.

Fix plan (~250 LOC with tests, fits BUGFIX):
- `runCheck` also keeps one transcript of stdout and stderr in the order porch reads them, on every
  failure path (exit code, timeout, spawn error).
- `runPhaseChecks` takes an optional log destination and writes each failed shell check's full
  output to `codev/projects/<id>/checks/<timestamp>-<phase>-<check>.log`; it keeps the newest 20
  and drops `.gitignore` (`*`) in the directory, since adopters' `.gitignore` does not ignore
  `codev/projects/*/*.txt`, let alone a new directory.
- `formatCheckResults` prints the last lines of the transcript plus the log path.
- `porch check`, `porch done` and `porch approve` pass the destination.

`overriddenChecks` on `runPhaseChecks` is never passed by any caller. Noted, left alone: it is about
artifact checks, not output.
