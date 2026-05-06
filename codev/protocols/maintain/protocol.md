# MAINTAIN Protocol

## Overview

MAINTAIN is a single-pass maintenance protocol for keeping codebases healthy. The builder does all maintenance work in one phase, then creates a PR with a 3-way review.

**Core Principle**: Do the work in one pass. Don't over-ceremonialize housekeeping.

**Key Documents** MAINTAIN keeps current:
- `codev/resources/arch.md` - Architecture documentation
- `codev/resources/lessons-learned.md` - Extracted wisdom from reviews

The two governance docs are siblings with **different purposes**: `arch.md` owns system shape (services, transports, mental models, verified-wrong assumptions about *this* system); `lessons-learned.md` owns durable engineering wisdom that applies *across* specs. Use the routing matrix below to decide where each fact belongs.

### Lives where: routing facts to the right home

| Type of fact/insight | Lives in |
|---|---|
| Current system shape (services, transports, key mental models) | `codev/resources/arch.md` |
| Mechanism for a unique subsystem | `codev/resources/arch.md` (subsystem section) OR a meta-spec under `codev/architecture/<domain>.md` if the mechanism is large enough to warrant its own doc |
| A durable engineering pattern that applies across multiple specs | `codev/resources/lessons-learned.md` |
| A spec-narrow fix recipe (only relevant inside the originating feature) | Spec review only — does NOT belong in `lessons-learned.md` |
| A system-shape surprise verified-wrong in production ("looks like X but isn't") | `codev/resources/arch.md` § "Verified-Wrong Assumptions" |
| Aspirational architectural direction (where we want to go) | The relevant meta-spec or roadmap doc, NOT `arch.md` body |
| A changelog entry ("we shipped X in spec Y on date Z") | `git log` + the spec/review document — NOT `arch.md`, NOT `lessons-learned.md` |
| A retired or removed component | Delete the section entirely; do NOT keep a "retired components" graveyard. (`git log` retains history.) |

The most commonly-misrouted entry is the system-shape surprise. If a future reader needs to know "the system *looks* like X but actually does Y," that is system shape and lives in `arch.md`. If they need to know "we learned that doing X is generally a bad idea," that is engineering wisdom and lives in `lessons-learned.md`.

## When to Use

- Before a release (clean slate for shipping)
- After completing a major feature
- Quarterly maintenance window
- When the codebase feels "crusty"

## Execution Model

```
afx spawn --protocol maintain
    ↓
1. MAINTAIN: Audit → Clean → Sync docs (single pass)
    ↓ (build + test checks, 3-way review)
2. REVIEW: Create PR
    ↓ (3-way review)
Architect reviews → Merge
```

Two phases total. One consultation during the maintain phase, one before PR.

## Prerequisites

Before starting:
1. Check `codev/maintain/` for the last run number
2. Note the base commit: `git log --oneline -1` on the last run file
3. Focus on changes since then: `git log --oneline <base-commit>..HEAD`

---

## The Maintain Phase (Single Pass)

The builder works through these tasks in order, committing as they go.

### Step 1: Audit

Identify what needs fixing. Don't fix yet — just catalog.

**Dead code**:
```bash
# Find unused exports (TypeScript)
npx ts-prune 2>/dev/null || echo "ts-prune not available"

# Find unused dependencies
npx depcheck 2>/dev/null || echo "depcheck not available"
```

**Stale documentation**:
```bash
# What changed since last maintenance?
git log --oneline <base-commit>..HEAD

# Check arch.md references still exist
grep -oE '[a-zA-Z]+/[a-zA-Z/]+\.[a-z]+' codev/resources/arch.md | sort -u | while read f; do
  [ -e "$f" ] || echo "Missing: $f"
done
```

**Stale project tracking**:
- GitHub Issues that should be closed
- Labels that need updating

Record findings in the maintenance run file (`codev/maintain/NNNN.md`).

### Step 2: Clean

For each finding from the audit:
1. Verify it's truly unused (grep the codebase)
2. Remove it (use `git rm` for tracked files)
3. Verify build + tests still pass
4. Commit with `[Maintain] Remove unused X`

**Rules**:
- One removal at a time — don't batch unrelated changes
- Verify after each removal — build must pass
- Use soft deletion for untracked files: `mv file codev/maintain/.trash/$(date +%Y-%m-%d)/`
- Never use `git add -A` or `git add .`

### Step 3: Sync Documentation

Step 3 is split into two sub-steps: **Audit first, then update.** This split exists because `arch.md` and `lessons-learned.md` accumulate without bound when MAINTAIN does only "what's new" — the audit pass surfaces what should be cut so the update pass is not purely additive.

The `update-arch-docs` skill (at `.claude/skills/update-arch-docs/SKILL.md`) is invoked by both sub-steps. Read it before starting Step 3 so the discipline is fresh.

#### Step 3a: Audit documentation

Invoke the `update-arch-docs` skill in **audit-mode**. The skill reads `codev/resources/arch.md` and `codev/resources/lessons-learned.md` end-to-end against the discipline below and produces a candidate-cuts list (with reasons) recorded in the run file (`codev/maintain/NNNN.md`) under a new `## Audit Findings` section before any edits land.

**Per-arch.md-section pruning checklist** — for each section in `arch.md`, ask:
- Does it describe **current state**? If aspirational, the section moves to a meta-spec; `arch.md` keeps a 1-paragraph summary + pointer (or nothing, if the meta-spec stands on its own).
- Does it duplicate a meta-spec? If yes, replace with a 1-paragraph summary + pointer.
- Is it a per-file enumeration that's gone stale? If yes, prune to the directory shape + a few key files.
- Is it a changelog/narrative section ("Spec 0042 added X")? If yes, absorb the architecturally-relevant facts and remove the spec-numbered framing.
- Is the component still alive? If retired, delete the section entirely.

**Per-lessons-learned.md-entry pruning checklist** — for each entry, ask:
- Is it cross-applicable beyond the spec that produced it? If no, remove (the lesson belongs in the spec's review).
- Is it terse (1–3 sentences)? If multi-paragraph, split or compress.
- Is the topic section the right home? If filed under "Architecture (continued)" or a spec-numbered section, move it to the right topical home.
- Is it a duplicate of an adjacent entry? If yes, fold them.

**Sample audit prompt** (paste into the skill invocation if you want a baseline checklist run):

```
Audit codev/resources/arch.md and codev/resources/lessons-learned.md against the
discipline in the update-arch-docs skill. For each section/entry, run the per-
arch.md-section and per-lessons-learned.md-entry pruning checklists from the
MAINTAIN protocol (Step 3a). Produce a candidate-cuts list with one-line reasons.
Bias toward fewer, higher-confidence cuts ("when in doubt, KEEP"). Record the
findings in the current run file's ## Audit Findings section before applying.
```

**When in doubt, KEEP.** This rule is preserved from the older Step 3. A confident cut is better than three speculative ones. The audit pass is a *proposal*; the architect's PR review confirms it.

#### Step 3b: Update documentation

Apply the audit decisions from Step 3a, plus any additive content needed.

**arch.md**: Compare documented structure with actual codebase. Update:
- Directory structure
- Component descriptions (explain HOW things work, not just WHAT)
- Key files and their purposes
- Remove references to deleted code (per Step 3a audit findings)
- Add new components/utilities

**lessons-learned.md**: Scan `codev/reviews/` for new reviews since last run. Extract lessons that are actionable, durable, and general. Apply Step 3a's per-entry cuts.

For specific additive changes, invoke `update-arch-docs` in **diff-mode** — it applies the smallest section update needed.

**CLAUDE.md / AGENTS.md**: Diff the two files. They must be identical. Update the stale one.

**Documentation pruning**:
- Remove obsolete references
- ~400 line guideline for CLAUDE.md/README.md (not a hard limit)
- Document every deletion with justification (OBSOLETE, DUPLICATIVE, MOVED, VERBOSE)
- When in doubt, KEEP the content

### Step 4: Final Checks

```bash
# Build and test from the package directory
cd packages/codev && pnpm build && pnpm test
```

Both must pass before moving to the review phase.

---

## Maintenance Run File

Each run creates `codev/maintain/NNNN.md`:

```markdown
# Maintenance Run NNNN

**Date**: YYYY-MM-DD
**Base Commit**: <hash>
**PR**: #NNN

## Changes Since Last Run

<key commits summary>

## Audit Findings

Recorded by Step 3a (Audit documentation) before any edits land. One line per candidate cut.

### arch.md
- <section-name>: <reason for proposed cut/compression>

### lessons-learned.md
- <entry>: <reason>

## What Was Done

### Dead Code Removed
- `path/to/file.ts`: `unusedFunction()` — not imported anywhere
- Removed `some-package` dependency — zero imports

### Documentation Updated
- arch.md: Added VS Code extension section, removed old dashboard-server refs
- lessons-learned.md: Extracted 3 lessons from reviews 653, 672

### Documentation Changes Log
| Document | Section | Action | Reason |
|----------|---------|--------|--------|
| arch.md | "Dashboard Server" | DELETED | OBSOLETE — replaced by Tower |

## Deferred

- Items found but not worth fixing now

## Summary

<2-3 sentences>
```

Keep it factual and short. The run file documents what happened, not what might happen.

---

## Commit Messages

```
[Maintain] Remove 5 unused exports
[Maintain] Remove http-proxy dependency
[Maintain] Update arch.md — add VS Code extension, remove dashboard-server refs
[Maintain] Generate lessons-learned.md from reviews 653, 672
[Maintain] Sync CLAUDE.md with AGENTS.md
```

---

## Governance

MAINTAIN is an operational protocol, not a feature protocol:

| Document | Required? |
|----------|-----------|
| Spec | No |
| Plan | No |
| Review | No (maintenance run file serves this purpose) |
| Consultation | Yes — 3-way review before PR |

If maintenance reveals need for architectural changes, those should follow SPIR.

---

## Rules

1. **Don't be aggressive** — when in doubt, KEEP the content
2. **Check git blame** — understand why code/docs exist before removing
3. **Run full test suite** — not just affected tests
4. **Group related changes** — one commit per logical change
5. **Document every deletion** — what, why, and where (if moved)
6. **Prefer moving over deleting** — extract to another file rather than removing
7. **Size targets are guidelines** — never sacrifice clarity to hit a line count

## Anti-Patterns

1. Aggressive rewriting without explanation
2. Deleting without documenting why
3. Hitting line count targets at all costs
4. Removing "patterns" or "best practices" sections without explicit approval
5. Deleting everything the audit finds — review each item individually
6. Skipping validation — "it looked dead" is not validation
7. Using `rm` instead of `git rm`
