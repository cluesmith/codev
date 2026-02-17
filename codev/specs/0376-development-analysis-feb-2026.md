---
approved: 2026-02-17
validated: [architect]
---

# Spec 0376: Two-Week Development Analysis (Feb 3–17, 2026)

## Context

This is the second comprehensive analysis of the Codev development system. The first covered Jan 30–Feb 13 and focused on CMAP (multi-agent consultation) value — measuring pre-merge catches vs post-merge escapes (`codev/resources/cmap-value-analysis-2026-02.md`).

This analysis covers Feb 3–17 and expands the scope to include **autonomous builder performance**, **porch effectiveness**, and **system throughput** in addition to updated CMAP value metrics.

## Scope

**Period**: Feb 3–17, 2026 (two weeks)
**Output**: `codev/resources/development-analysis-2026-02-17.md`

### Data Sources

| Source | Location | What to Extract |
|--------|----------|----------------|
| Review files | `codev/reviews/*.md` (modified Feb 3–17) | Phases, iterations, bugs caught, deviations, context windows, rebuttals, autonomous stretches |
| GitHub PRs | `gh pr list --state merged` | Timing (created→merged), LOC, files changed |
| GitHub Issues | `gh issue list --state closed` | Volume, categories, resolution time |
| Consult metrics DB | `consult stats` | Cost breakdown by model, invocation counts, duration |
| Git history | `git log --since="2026-02-03"` | Commit volume, branch patterns |
| Porch project state | `codev/projects/*/status.yaml` (if any remain) | Phase transition timestamps |

### Review Files in Scope (26 files)

All review files modified between Feb 3–17, 2026:

- 0102 through 0127 (SPIR projects)
- bugfix-274, 324 (bugfix reviews)
- 0350, 0364 (late-period SPIR projects)

## Goals

### 1. Autonomous Builder Performance (PRIMARY FOCUS)

Measure how long builders operated without human intervention between plan approval and PR creation. For each SPIR project in the period:

- **Autonomous runtime**: Time from first implementation commit to PR creation (excludes human gate waits)
- **Context windows consumed**: How many context compactions/restarts occurred
- **Context recovery success**: Did the builder resume correctly after context loss? Did porch help?
- **Completion rate**: Did the builder reach PR without architect intervention?
- **Intervention incidents**: When did the architect need to step in, and why?

Known data points from reviews:
- **Spec 0099**: 3 context windows, auto-resumed without human intervention
- **Spec 0104**: 4 context compactions, porch status tracking was essential for recovery
- **Spec 0105**: 2 context windows, auto-resumed
- **Spec 0126**: Context ran out twice during 6-phase implementation
- **Spec 0101**: Architect manually advanced after 7 iterations with 2/3 approval
- **Spec 0104**: Claude consultation timeouts on 3,700-line file, required manual reviews

### 2. Porch Effectiveness

Quantify how porch (protocol orchestrator) enables longer autonomous operation:

- **State persistence across context loss**: How many builders resumed successfully via porch state?
- **Phase-gated progress**: Did phase decomposition prevent builders from going off-track?
- **Consultation loop management**: How many consultation iterations per phase on average?
- **Rebuttal mechanism**:
  - How many reviews used rebuttals?
  - What was the false positive rate from each reviewer?
  - Did Spec 0121 (rebuttal-based advancement) reduce wasted iterations?
- **Gate enforcement**: Did human gates catch anything the builder missed?

### 3. Multi-Agent Review Value (Updated CMAP Analysis)

Update the Jan 30–Feb 13 analysis with new data:

- **Pre-merge catches**: Categorize all bugs caught by consultation (security, runtime, quality)
- **Post-merge escapes**: Bugs that shipped despite review
- **Reviewer effectiveness by model**: Which model catches which types of bugs?
- **False positive patterns**: Codex JSONL parsing bug, Claude reading wrong filesystem, Gemini path confusion
- **Net value calculation**: Hours saved vs overhead cost

Known critical catches from reviews:
- **Spec 0126**: Claude caught missing `workspacePath` parameter (would have broken dashboard)
- **Spec 0113**: Codex found boolean value-copy bug in `stderrClosed`
- **Spec 0112**: Gemini/Codex caught missed rename in `tower.html`
- **Bugfix #274**: Codex caught secondary race path through API
- **Spec 0106**: Claude caught merge artifact behavioral changes in Phase 1

### 4. System Throughput

Aggregate metrics across the full two-week period:

- **PRs merged** (total, by type: SPIR/bugfix/other)
- **Issues closed** (total, by category)
- **Lines of code** (additions, deletions, net)
- **Files changed**
- **New tests added** (from review data)
- **Test suite growth trajectory**
- **Commits per day**
- **Average PR time-to-merge** (by type)

### 5. Cost Analysis

- **Consultation costs by model** (from `consult stats`)
- **Cost per catch** (total consultation cost / number of pre-merge catches)
- **Cost per PR** (total consultation cost / PRs merged)
- **ROI calculation** (estimated hours saved / total cost)
- **Comparison to Jan 30–Feb 13 period**

## Output Format

The analysis document should follow the structure of the previous analysis but with expanded sections:

```
# Development Analysis: Feb 3–17, 2026

## Executive Summary
(1-paragraph overview with headline numbers)

## 1. Autonomous Builder Performance
### 1.1 Per-Project Breakdown (table)
### 1.2 Context Window Usage
### 1.3 Completion Rates
### 1.4 Failure Modes and Interventions

## 2. Porch Effectiveness
### 2.1 State Recovery After Context Loss
### 2.2 Phase Decomposition Value
### 2.3 Consultation Loop Efficiency
### 2.4 Rebuttal Mechanism Analysis

## 3. Multi-Agent Review Value
### 3.1 Pre-Merge Catches (table: catch, spec, reviewer, description)
### 3.2 Post-Merge Escapes (table: issue, PR, description, why missed)
### 3.3 Reviewer Effectiveness
### 3.4 False Positives and Overhead
### 3.5 Net Value Calculation

## 4. System Throughput
### 4.1 Volume Metrics
### 4.2 Timing Analysis
### 4.3 Code Growth

## 5. Cost Analysis
### 5.1 By Model
### 5.2 ROI Calculation
### 5.3 Comparison to Previous Period

## 6. Recommendations
### What's Working
### What Needs Improvement
### Process Changes for Next Sprint

## Appendix: Data Sources
```

## Acceptance Criteria

1. Every claim is backed by a specific PR number, review file citation, or git commit
2. All 26 review files in scope are analyzed
3. Autonomous runtime is calculated for every SPIR project that has review data
4. Context window usage is documented per project
5. At least 10 pre-merge catches are catalogued with full details
6. Post-merge escapes are cross-referenced against GitHub issues
7. Cost analysis uses actual `consult stats` data
8. Comparison to previous analysis period is included
9. Document is placed at `codev/resources/development-analysis-2026-02-17.md`

## Non-Goals

- No code changes — this is a pure analysis/documentation task
- No changes to protocols or tools (recommendations only)
- No retrospective on process — focus on measurable data
