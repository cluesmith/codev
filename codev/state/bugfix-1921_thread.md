# bugfix-1921 thread

## Investigate (2026-11-18)
- Reproduced on Windows: running `.af-cron/ci-health.yaml`'s command through node `exec` (cmd.exe /d /s /c) exits 255 with stderr
  "'map' is not recognized..."; tower-cron's runCommand returns `stdout || stderr` as output, and `output != ''` is true -> false alert.
- Root cause 1: cmd.exe does not treat `'...'` as quoting, so `|` inside the jq expression is a pipe.
- Root cause 2: condition ignores exitCode; tower-cron (by design) evaluates conditions on failed runs too.
- Same single-quote pattern in `codev-skeleton/.af-cron/ci-health.yaml.example` (condition `output != '0'` has the same fault).
  `team-update.yaml` is fine (no quoting, already gates on exitCode == 0).
- Fix: double-quote the jq expression with `\"` for inner jq strings. Verified identical output under cmd.exe and bash.
  Chosen over a helper script: stays a one-liner adopters can copy, no extra file to ship.
- Failed check: no separate alert. Tower already logs a WARN for a failed cron command; a "check is broken" alert every
  30 min would be noise of its own.

## Fix + PR (2026-11-18)
- Full suite on this Windows host: first two porch done runs collided with sibling suites (timeout, then pir-1920's approve on top).
  Third run, alone, found a real failure caused by this change: skill-refresh needs `generate-skill-hashes` after editing the afx skill.
  Fixed; fourth run passed (build 41.4s, tests 131.1s). Tower PID 29272 unchanged throughout.
- PR #1929. CMAP: gemini skipped (agy missing), codex APPROVE, claude APPROVE. Applied: cmd.exe inner-quote caveat in the docs,
  platform-independent single-quote guard in the test. Deferred: route tower-cron through commandLaunch (Git Bash on Windows),
  which needs an exit-code-returning execShellString. Offered to the architect as a follow-up.
- Note: the first consult run reported "No PR found for branch" seconds after PR creation; re-ran with `--issue 1929`.
