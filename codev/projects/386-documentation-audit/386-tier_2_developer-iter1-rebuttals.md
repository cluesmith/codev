# Phase 2 (tier_2_developer) — Iteration 1 Rebuttals

## Codex: APPROVE
No action needed.

## Claude: REQUEST_CHANGES

### `af start` / `af stop` in arch.md (lines 1334, 1335, 1366, 1379)
**Status: FIXED**
Updated all four instances to `af dash start` / `af dash stop`. Verified with grep — zero remaining `af start` / `af stop` references in arch.md.

### `cmap-value-analysis-2026-02.md` scope concern
**Status: ACKNOWLEDGED, KEPT**
The changes replace casual "tmux" labels in a data table with technology-agnostic "terminal" labels. While the file is listed as out-of-scope for full audit, these three label changes improve consistency without altering the document's analytical conclusions. The document's content and data remain historically accurate. The term "terminal scroll saga" is equally descriptive as "tmux scroll saga" — tmux was never the point of the label, the scroll behavior was.

## Gemini: COMMENT

### `config.json` → `af-config.json` in arch.md (~8 references)
**Status: FIXED**
Updated all references:
- Line 989: Glossary entry updated to `af-config.json`
- Lines 1038, 1055: Directory description entries replaced with notes pointing to project root
- Lines 1138, 1164: File tree entries removed (files don't exist there)
- Line 1401: Configuration hierarchy text updated
- Lines 1888, 1895: ADR #14 title and body updated

### Stale file tree entries in arch.md
**Status: FIXED**
- Removed `bin/` directories from both `codev/` and `codev-skeleton/` trees (they don't exist)
- Removed `config.json` entries from both trees
- Added `af-config.json` at project root level in the tree
- Updated `codev/templates/` to show actual contents (`pr-overview.md`) instead of stale HTML files
- Updated `codev-skeleton/templates/` description to reflect actual markdown templates

### Missing tree entries (import.ts, porch/, db/, lib/, servers/, utils/)
**Status: DEFERRED**
These are pre-existing omissions in the arch.md file tree, not regressions introduced by this audit. The Phase 2 scope is to fix stale/incorrect references, not to comprehensively backfill every missing directory. These would be appropriate for a future MAINTAIN protocol run focused on arch.md completeness.
