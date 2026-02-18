# Plan: Iterative Documentation Refinement (4 rounds)

Applies to `codev/resources/arch.md` and `codev/resources/lessons-learned.md` as part of Spec 422 documentation sweep.

## Overview

4 rounds of cmap-driven refinement, each with 3 steps:
1. **cmap review** — 3 parallel consultations (gemini, codex, claude) with a round-specific prompt
2. **Synthesize and edit** — read all 3 outputs, build consensus action list, apply edits
3. **Commit** — commit with message `[Spec 422] Refinement round N/4: <description>`

## Round Focus

| Round | Focus | Description |
|-------|-------|-------------|
| 1 | **Broad prune** | Aggressive removal of content that doesn't earn its place: historical changelogs, duplicate sections, stale technology references, overly granular file indexes, non-architectural material |
| 2 | **Depth** | Fill major gaps identified in Round 1: add missing Porch section, Startup Sequence, Message Delivery. Fix dangling references from Round 1 cuts. Continue lessons-learned cleanup. |
| 3 | **Polish** | Consistency and flow: cross-references, section ordering, terminology (workspace vs project vs worktree), tone/style uniformity, heading hierarchy. Consolidate remaining duplicate lessons. |
| 4 | **Final fresh-eyes** | Fresh perspective pass: read as if seeing it for the first time. Flag anything confusing, verify markdown renders correctly, check for broken cross-references. |

## Per-Round Steps

### Step 1: Write prompt and run cmap

Write a prompt file to `tmp/refinement-round-N.md` with:
- Core review template (USEFULNESS, GAPS, LESSONS VALUE)
- Round-specific focus instructions
- Structured output format (REMOVE/EXPAND/REWRITE/KEEP)

Run 3 parallel consultations:
```bash
consult -m gemini --prompt-file tmp/refinement-round-N.md --output tmp/rN-gemini.txt &
consult -m codex --prompt-file tmp/refinement-round-N.md --output tmp/rN-codex.txt &
consult -m claude --prompt-file tmp/refinement-round-N.md --output tmp/rN-claude.txt &
```

**Important**: Always use `--output` flag — without it, `consult` outputs to stdout which is lost when run in background.

### Step 2: Synthesize and edit

1. Read all 3 outputs
2. Build action list with consensus weighting:
   - 3/3 agree → do it
   - 2/3 agree → do it with judgment
   - 1/3 suggests → evaluate carefully
3. Apply edits to `arch.md` and `lessons-learned.md`
4. Work bottom-to-top in file to avoid line number shifts

### Step 3: Commit

```bash
git add codev/resources/arch.md codev/resources/lessons-learned.md
git commit -m "[Spec 422] Refinement round N/4: <description>"
```

## After Round 4

1. Verify markdown renders correctly (no broken formatting)
2. Verify no broken cross-references (internal anchors, external links)
3. Track final line counts vs starting counts
4. Push branch and update PR #426

## Line Count Tracking

| Document | Start | R1 | R2 | R3 | R4 |
|----------|-------|----|----|----|-----|
| arch.md | 3,352 | 1,516 | 1,650 | — | — |
| lessons-learned.md | 413 | 372 | 368 | — | — |
| **Total** | **3,765** | **1,888** | **2,018** | — | — |

## Process Notes

- This is a manual process outside porch orchestration (no `porch run`)
- Each round builds on the previous — don't undo earlier decisions without reason
- Consultants see the full current state of both files plus the round-specific prompt
- The `consult` command in general mode (`--prompt-file`) reads the codebase context automatically
