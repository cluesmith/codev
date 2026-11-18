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
