# SPIKE Protocol

## Overview

Time-boxed technical feasibility exploration. Answer "Can we do X?" and "What would it take?" before committing to a full SPIR project.

**Core Principle**: Stay focused on the question. Once you can answer it, write findings and stop.

## When to Use

**Use for**: Quick technical feasibility investigations, proof-of-concept explorations, "can we do X?" questions, evaluating approaches before committing to SPIR

**Skip for**: Production code (use SPIR), formal hypothesis testing (use EXPERIMENT), bug fixes (use BUGFIX), well-understood implementations (use TICK)

### Spike vs Experiment

| | Spike | Experiment |
|---|---|---|
| **Goal** | Answer a feasibility question | Test a formal hypothesis |
| **Structure** | Lightweight guidance | Formal phases (hypothesis/design/execute/analyze) |
| **Output** | Findings document | Experiment notes with metrics |
| **Rigor** | Exploration-first | Measurement-first |
| **Time** | Short (hours) | Longer (days) |

## Spawning a Spike

```bash
af spawn --task "Can we use WebSockets for real-time updates?" --protocol spike
af spawn --task "What would it take to support SQLite FTS?" --protocol spike
```

Spikes are always soft mode — no porch orchestration, no gates, no consultation.

## Recommended Workflow

The following 3-step workflow is **guidance only** — not enforced by porch. Follow it, skip steps, or reorder as the investigation demands.

### Step 1: Research

- Read documentation, examine existing code, search for prior art
- Identify constraints, dependencies, and potential blockers
- Understand the problem space before writing any code
- Check if someone has already investigated this (look in `codev/spikes/`)

### Step 2: Iterate

- Build minimal proof-of-concept code
- Try different approaches, hit walls, pivot
- Focus on answering the feasibility question, not building production code
- **Skip this step** if the answer is clear from research alone

### Step 3: Findings

- Write the findings document at `codev/spikes/<id>-<name>.md`
- Use the template: `codev/protocols/spike/templates/findings.md`
- Provide a clear feasibility verdict
- Commit and notify the architect

## Output

Findings are stored in `codev/spikes/` using the pattern: `<id>-<descriptive-name>.md`

Examples:
- `codev/spikes/462-websocket-feasibility.md`
- `codev/spikes/475-sqlite-fts-performance.md`

The `<id>` is the GitHub issue number or project ID.

## Proof-of-Concept Code

POC code from the iterate step is committed to the spike branch alongside the findings document. It serves as evidence supporting the findings. However:

- POC code does NOT need tests, polish, or production quality
- POC code does NOT get merged to main — it stays on the spike branch
- The findings document is the primary deliverable; the code is supporting evidence
- If the spike leads to a SPIR project, the builder starts fresh

## Outcome Handling

- **Feasible**: Write findings with recommended approach and effort estimate. Architect decides whether to create a SPIR project.
- **Not Feasible**: Write findings documenting why, what was tried, and what alternatives exist. This prevents future teams from repeating the investigation.
- **Feasible with Caveats**: Write findings with conditions, risks, and trade-offs.

In all cases, notify the architect:
```bash
af send architect "Spike <id> complete. Verdict: [feasible/not feasible/caveats]"
```

## Git Workflow

### Commits
```
[Spike 462] Research: WebSocket library comparison
[Spike 462] Iterate: POC with ws library
[Spike 462] Findings: WebSockets feasible for real-time updates
```

### When to Commit
- After significant research findings
- After each iteration attempt
- When writing the findings document (final commit)

## Integration with Other Protocols

### Spike -> SPIR
When a spike validates feasibility:
1. Create a SPIR spec referencing the spike findings
2. Use findings to inform the solution approach
3. Reference effort estimate for planning

Example spec reference:
```markdown
## Background
Spike 462 confirmed WebSocket feasibility with the `ws` library.
See: codev/spikes/462-websocket-feasibility.md
```

### Spike -> "Do Not Pursue"
When a spike finds something is not feasible:
1. Document clearly in findings
2. Close the related GitHub issue with a link to findings
3. The findings become institutional knowledge
