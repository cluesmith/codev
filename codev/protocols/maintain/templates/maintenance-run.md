# Maintenance Run NNNN

**Date**: YYYY-MM-DD
**Base Commit**: <hash>
**PR**: #NNN

## Changes Since Last Run

<key commits or summary>

## Audit Findings

Recorded by Step 3a (Audit documentation) as the cuts are applied — one line per cut, with its reason. The diff plus these reasons is the proposal; the architect's PR review is the gate.

### arch.md (cold) / arch-critical.md (hot)
- <section or hot entry>: <reason for cut / compression / demotion>

### lessons-learned.md (cold) / lessons-critical.md (hot)
- <entry>: <reason; note hot→cold demotions and any cold-doc-map fixes>

## What Was Done

### Dead Code Removed
- <file>: <item> — <reason>

### Dependencies Cleaned
- <package> — <reason>

### Documentation Updated
- arch.md (cold) / arch-critical.md (hot): <what changed; note any demotions + map fixes>
- lessons-learned.md (cold) / lessons-critical.md (hot): <what changed; note any demotions + map fixes>

### Documentation Changes Log
| Document | Section | Action | Reason |
|----------|---------|--------|--------|
| arch.md | "Dashboard Server" | DELETED | OBSOLETE — replaced by Tower |

## Deferred

- <items found but not fixed, with reason>

## Summary

<2-3 sentences>
