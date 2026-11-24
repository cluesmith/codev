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

## 2026-11-23 — fix built, draft PR #1964

Fix and test commits pushed (c0cc478cb, c49ccc5f9). Seven new tests; six fail against the old
`checks.ts`. Targeted runs: 8 files, 90/90; `tsc --noEmit` clean; `pnpm build` clean. End-to-end with
the built CLI in a scratch workspace and with a real failing vitest test under `npm test`: the tail
names the test and ends with the log path, and `git status` stays clean.

Surprise worth knowing: the POSIX launcher collapses runs of whitespace in a check's command
(`posixCollapseWhitespace`), so an `echo "FAIL  x"` in a check prints `FAIL x`. The test strings use
single spaces for that reason.

Draft PR #1964 opened so CI runs the full suite; Windows on-demand run 45303921745 dispatched.
Holding before `porch done` (fix phase's `tests` check is the full local suite) per architect rule 2.

## 2026-11-23 — porch done (fix phase), run once on the architect's go

`VITEST_MAX_WORKERS=3 porch done bugfix-1853`: build passed (26.0s), tests failed (147.8s), 174s
wall. Not rerun, per the architect. The failing test is unknown because the `porch` on PATH is the
installed v3.3.7 (main's build), not this branch's build. So the run printed the old five npm-warning
lines and saved no log: the bug this fix addresses hid its own evidence. Reported to the architect
with options; holding.

Named from vitest's results cache (`packages/codev/node_modules/.vite/vitest/<hash>/results.json`):
the one real failure was `src/__tests__/skill-refresh.test.ts`, "lists the current version of every
shipped skill". It was caused by this PR: I edited the porch SKILL.md without running
`generate-skill-hashes`. It failed alone too, deterministically. Regenerating the registry added one
hash each for `.claude/skills/porch` and `.codex/skills/porch`, and the file then passed 23/23. The
cache's other failed entry, `zz-repro-1853`, was my deleted repro file, a stale record.

The worker cap reaches vitest through porch → shell → npm → vitest. I probed with 6 throwaway files
under porch's own `runCheck`: with `VITEST_MAX_WORKERS=3`, pool ids were 1–3 and at most 3 ran at
once; without it, ids 1–6 and 6 at once. vitest 4.1.4 applies the variable in config resolution,
overriding the config. I did not sample load during the porch done run (1-min load was 6.4 just after).

## 2026-11-23 — fix phase passed, pr phase

On the architect's go: `VITEST_MAX_WORKERS=3 node packages/codev/bin/porch.js done bugfix-1853` with
this branch's porch, run once. Build passed (19.5s), tests passed (142.6s), 165s wall, peak 1-min load
14.96. Advanced to pr.

CMAP: claude APPROVE with five non-blocking notes. I fixed three: stream splicing (now whole lines),
the dead `stderr` accumulator, and a prune that could delete the log just written (5a67e5800, with
tests in 32fd78350). codex REQUEST_CHANGES, only on the `chore(porch)` commit prefixes. Rebutted:
those are porch's own state commits, standard on main (87 of the last 200).

Windows run 45303921745 (first commit) failed only the same skill-hash test; the #1853 tests passed
there. Re-dispatched as 45306427073 on head 32fd783. PR #1964 is out of draft.
