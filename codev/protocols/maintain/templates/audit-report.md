# Cleanup Audit Report

**Date**: YYYY-MM-DD · **Project**: · **Auditor**:

## Pre-Audit Checks

- [ ] Git working directory is clean
- [ ] All tests currently passing
- [ ] No pending merges or PRs in flight

## Summary

One row per category; totals reconcile against the findings below.

| Category | Items Found | Approved for Removal |
|----------|------------:|---------------------:|
| Dead code (unused exports, unreachable code, unused files) | 0 | 0 |
| Dependencies (npm, Python) | 0 | 0 |
| Documentation (stale, broken links) | 0 | 0 |
| Tests (orphaned files, low-ROI, orphaned fixtures) | 0 | 0 |
| Temp files | 0 | 0 |
| Metadata (projectlist, AGENTS/CLAUDE, arch) | 0 | 0 |
| **Total** | **0** | **0** |

## Findings

One table per category that has findings, using this schema (add/drop columns as the category needs — dependencies use Package/Version, temp files use Path/Size). Name the tool that surfaced each item so the owner can verify it.

| Approve | Location (`file:line` / package / path) | Item | Tool + output | Owner decision |
|:-------:|------------------------------------------|------|---------------|----------------|
| | | | | |

Typical tools: `npx ts-prune` / `ruff check --select F401` (unused exports), `npx depcheck` / `deptry` (dependencies), link checker (docs), coverage + flaky detection (tests), `find` / `du -sh` (temp files).

## Recommendations

Grouped by confidence: **Should remove** · **Likely safe** · **Needs investigation** · **Do not remove** (with reason).

## Rollback Notes

Restoration path if VALIDATE fails — tracked files via `git revert` / `git checkout HEAD~1 -- <path>`; untracked via the dated `codev/cleanup/.trash/…/restore.sh`.

## Approval

- [ ] Human reviewed all items and marked the approved ones.
- [ ] Ready to proceed to the PRUNE phase.
