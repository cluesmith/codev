# Phase 3 (tier_3_skeleton) — Iteration 1 Rebuttals

## Codex: REQUEST_CHANGES

### CLAUDE.md/AGENTS.md template pair not synced beyond title/header
**Status: ACKNOWLEDGED, BY DESIGN**
The two templates intentionally have different note blocks:
- CLAUDE.md: No note (it IS the Claude-specific version)
- AGENTS.md: Cross-tool compatibility note pointing back to CLAUDE.md

This mirrors the pattern in the actual root CLAUDE.md/AGENTS.md files. The body content is identical — only the title and header note differ, which is the expected design for supporting both the AGENTS.md standard and Claude Code specifically.

## Claude: REQUEST_CHANGES

### `af spawn` synopsis in agent-farm.md still shows `-p, --project`
**Status: FIXED**
Updated synopsis from `af spawn [options]` with `-p, --project <id>` to `af spawn [issue-number] [options]` with positional argument documentation. Examples were already correct; now the synopsis matches.

## Gemini: REQUEST_CHANGES

### `af spawn` synopsis — same as Claude's finding
**Status: FIXED** (see Claude section above)

### CLAUDE.md template `(start, spawn, status, cleanup)` description
**Status: ACKNOWLEDGED, KEPT**
The parenthetical "(start, spawn, status, cleanup)" describes high-level capabilities of the `af` tool, not actual CLI subcommands. "Start" refers to the dashboard start functionality. This is a summary description pattern, not command-line syntax. Changing it to "(dash start, spawn, status, cleanup)" would be awkward and less readable. The full CLI reference is linked immediately below.

### `af tower start` in codev table of cheatsheet template
**Status: FIXED**
Removed from the `codev` table — it was already correctly listed in the `af` table below. Also fixed the same issue in `codev/resources/cheatsheet.md` for consistency.

### Missing `codev import` documentation in codev.md
**Status: DEFERRED**
This is a pre-existing documentation gap, not a regression from this audit. The audit scope is fixing stale/incorrect references, not backfilling missing documentation. This would be appropriate for a future doc improvement task.
