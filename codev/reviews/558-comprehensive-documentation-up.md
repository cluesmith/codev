# Review: Comprehensive Documentation Update for HN Launch

## Metadata
- **Spec**: codev/specs/558-comprehensive-documentation-up.md
- **Plan**: codev/plans/558-comprehensive-documentation-up.md
- **Issue**: #558
- **Date**: 2026-02-25

## Summary

Documentation-only update across 8 files to fix deprecated CLI syntax, add missing protocol/feature documentation, and modernize stale references in preparation for HN launch.

## Changes Made

### Phase 1: Fix Deprecated CLI Commands
- Replaced all `af dash` with `af workspace` in README.md, docs/tips.md, AGENTS.md, CLAUDE.md, MANIFESTO.md, INSTALL.md
- Added required `--protocol` flag to `af spawn` examples
- Verified AGENTS.md/CLAUDE.md remain byte-identical

### Phase 2: Update README Version References
- Updated version examples from v1.6.0/v1.7.0 era to v2.x era
- Replaced manual SSH tunnel Remote Access section with `af workspace start --remote`
- Updated versioning strategy table

### Phase 3: Expand FAQ and Cheatsheet
- Added 4 new FAQ sections: protocol overview, porch explanation, Agent Farm optionality, remote access
- Added ASPIR and BUGFIX protocols to cheatsheet protocol table
- Added porch CLI to cheatsheet tools reference
- Added porch as fourth CLI tool in commands/overview.md with command summary

### Phase 4: Update tips.md and why.md
- Added tips for remote access, cross-workspace messaging, and non-Node.js porch checks
- Fixed stale "SP(IDE)R-SOLO" and "MCP support" references in why.md

## What Went Well
- Systematic file-by-file audit caught all deprecated `af dash` references
- Changes were minimal and focused — no unnecessary rewrites
- All docs remain internally consistent

## What Was Challenging
- PR consultations failed because no PR existed yet (chicken-and-egg)
- Balancing between updating historical references (like model names in case studies) vs keeping them accurate as historical records

## Lessons Learned
- Documentation-only PRs benefit from creating the PR first, then running consultations on the actual diff
- The `af dash` → `af workspace` deprecation wasn't fully propagated through docs when the rename happened — future renames should include a doc-sweep step

## Methodology Notes
- ASPIR was appropriate for this scope — no spec/plan gates needed for a documentation refresh
- Consultations on the spec ran but output went to stdout (not captured) — consider `--output` flag for background consultations
