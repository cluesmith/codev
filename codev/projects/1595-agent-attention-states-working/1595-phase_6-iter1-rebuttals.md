# Phase 6 iter1 rebuttals

## codex (REQUEST_CHANGES)
- U+2028/U+2029 left intact in summaries: FIXED. They are now treated as line breaks (collapsed to one space with the surrounding whitespace). Test added.

## claude (COMMENT)
- Notification matcher unplanned and unverified: FIXED. Dropped; the script already filters on `notification_type`. Test asserts no matcher. Re-verified on Claude Code 2.1.306 that the generated settings load and report.
- Duplicate quoting helper and inverted dependency direction: FIXED. `toShellPath` moved to `harness.ts`; `lifecycle-reporter.ts` reuses `shellEscapeSingleQuote` from there; `harness.ts` no longer imports from the reporter module.
- Unguarded `--settings` path fails closed if the installed settings file is deleted: ACCEPTED as a residual, not changed in this phase. Every launch build reinstalls before injecting (and injects nothing if install fails), so only a relaunch from an already-baked builder script or shellper restart after a manual deletion of the codev-owned `~/.agent-farm/hooks` is exposed; nothing in codev deletes it. A bash-level guard would need array plumbing in the launch loop for a path that can contain spaces. Carried to phase 8 as an operational note / doctor-check candidate.
- `primaryArgument` keys `description`/`prompt` beyond "command or path": kept. They are fallbacks for tools with no command or path (bounded, sanitized, plain text), so the summary still says what is being asked.

## gemini
- Skipped (agy exit 3), non-blocking.
