# Phase 6 — Iteration 2 Rebuttals

**Verdicts**: codex `APPROVE` (HIGH) · claude `REQUEST_CHANGES` (HIGH)

Both accepted and fixed. Nothing rebutted.

---

## claude (blocking) — the section's only CLI example does not run

> `consult -m codex --model-id gpt-5.6-sol "Review this design"` exits 1 with "Unknown subcommand"
> — a bare positional is parsed as the subcommand argument. Needs `--prompt`.

**Accepted, and confirmed by running it** rather than by reading the parser alone:

```
$ consult -m codex --model-id gpt-5.6-sol "Review this design"
Unknown subcommand: --model-id
Use --prompt for general queries or --type for protocol reviews.
```

`cli.ts` declares `.argument('[subcommand]', …)`, so the first bare positional binds to
`subcommand` and anything that is not `stats` is rejected. Fixed to `--prompt "…"`, which is the
form every other example in this document already uses — the new section was the only one that
departed from the file's own convention, which is precisely where a copy-paste error survives.

This is the worst kind of documentation defect and it is worth naming: a **wrong** example is
strictly worse than a missing one, because the reader has no reason to doubt it and will conclude
the *tool* is broken. I had verified the config JSON in this document by loading it for real, and
verified every constant against source, but did not run the one shell command I wrote.

**Swept the rest of the file rather than fixing only the reported line**, since a single
copy-paste slip is rarely alone: every other `consult …` example uses `--prompt`, `--prompt-file`,
`--type`, or `stats`. The only bare-positional occurrence left is the synopsis
(`consult -m <model> [options]`), which is a placeholder, not a runnable command.

## claude (nit) — the skip list omitted zero-exit-with-empty-output

Correct, and verified at the branch following the hard-failure gate:
`if (code !== 0 || raw.length === 0 || timedOutProducing)`. An `agy` run that exits **successfully**
having produced nothing still skips non-blockingly even when a model id is resolved. My list named
absent / unauthenticated / timed out / signal-killed and stopped there.

Worth including precisely because it is the least intuitive member of the set — "exited 0 and
skipped anyway" is the case a reader would assume must be a hard failure. Added.

---

## Verification

The corrected example was run and parses. `diff` between `codev/` and `codev-skeleton/` is
**empty**. Build ✓, full unit suite green.
