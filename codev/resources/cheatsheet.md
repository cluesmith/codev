# Codev Cheatsheet

A quick reference for Codev's philosophies, concepts, and tools.

---

## Core Philosophies

### 1. Natural Language is the Programming Language

Specifications and plans are as important as code—they ARE the requirements and design.

| Traditional | Codev |
|-------------|-------|
| Code first, document later | Spec first, code implements spec |
| Documentation gets stale | Specs ARE the source of truth |
| Humans read code to understand | AI agents translate spec → code |

**Corollaries:**
- The spec IS the requirements; the plan IS the design
- Code is the implementation of well-defined natural language artifacts
- If the spec is wrong, the code will be wrong—fix the spec first

### 2. Multiple Models Outperform a Single Model

No single AI model catches everything. Diverse perspectives find more issues.

| Role | Models |
|------|--------|
| Architect & Builder | Claude (primary agent) |
| Consultants | Gemini, Codex, Claude (for reviews) |

**Corollaries:**
- 3-way reviews catch issues single models miss
- Different models have different strengths and blind spots
- Consultation happens at key checkpoints, not continuously

### 3. Human-Agent Work Requires Thoughtful Structure

Just like structuring a human team—clear roles, defined processes, explicit handoffs.

| Component | Purpose |
|-----------|---------|
| Protocols | Define HOW work happens (SPIR, ASPIR, etc.) |
| Roles | Define WHO does what (Architect, Builder, Consultant) |
| Parallelism | Scale by running multiple builders simultaneously |

**Corollaries:**
- Well-defined protocols reduce ambiguity and rework
- Clear roles enable autonomous operation
- Parallel execution multiplies throughput

---

## Core Concepts

### Protocols

A **protocol** is a structured workflow that defines how work progresses from idea to completion.

| Protocol | Use For | Phases |
|----------|---------|--------|
| **SPIR** | New features | Specify → Plan → Implement → Review → Verify |
| **ASPIR** | SPIR for trusted, low-risk work (no spec/plan gates) | Specify → Plan → Implement → Review → Verify |
| **AIR** | Small features fully described in an issue | Implement → PR |
| **BUGFIX** | Bugs from GitHub issues | Investigate → Fix → PR |
| **PIR** | Issue-driven work whose approach or running behavior needs review | Plan → Implement → Review |
| **MAINTAIN** | Scheduled codebase hygiene | Whole-repo audit → clean → sync run since the last one, on the human's call. Not for a single targeted cleanup or doc fix (that is a BUGFIX) |
| **EXPERIMENT** | Research & prototyping | Hypothesis → Experiment → Conclude |
| **RESEARCH** | Multi-agent research | Scope → Investigate (3-way) → Synthesize → Critique (3-way) |
| **SPIKE** | Time-boxed feasibility check | One phase; findings, no production code |

### Roles

A **role** defines who does what work and what tools/permissions they have.

| Role | Responsibilities |
|------|------------------|
| **Architect** | Orchestrates development, reviews specs/plans at the gates, reviews PRs, maintains big picture |
| **Builder** | Writes specs and plans, implements them in isolated worktrees, writes tests, creates PRs |
| **Consultant** | External reviewers providing second opinions on specs, plans, implementations |

**Consultant Flavors** (via `--type`):
- `spec` - Review specification completeness
- `plan` - Review implementation plan feasibility
- `impl` - Review code for spec adherence
- `pr` - Review pull request before merge
- `phase` - Phase-scoped review (builder only)
- `integration` - Review for architectural fit

### Context Hierarchy

In much the same way an operating system has a memory hierarchy, Codev repos have a context hierarchy. The codev/ directory holds the top 3 layers. This allows both humans and agents to think about problems at different levels of detail.

![Context Hierarchy](context-hierarchy.png)

**Key insight**: We build from the top down, and we propagate information from the bottom up. We start with a GitHub issue, then spec and plan out the feature, generate the code, and then propagate what we learned through the reviews. 

---

## Tools Reference

### codev

Project management commands. Typically used by **humans** to set up and maintain projects.

| Command | Description |
|---------|-------------|
| `codev init <dirname>` | Create a new Codev project |
| `codev adopt` | Add Codev to an existing project |
| `codev bootstrap-docs` | Draft the governance docs from an existing codebase |
| `codev doctor` | Check dependencies and configuration |
| `codev update` | Update Codev framework |
| `codev import <source>` | AI-assisted protocol import from another codev project |

### agent-farm (afx)

Architect-Builder orchestration. Used by both **humans and agents**—agents use it more frequently.

| Command | Description |
|---------|-------------|
| `afx workspace start` | Start the workspace in Tower (http://localhost:4100) |
| `afx workspace stop` | Stop all processes |
| `afx spawn <id> --protocol <name>` | Spawn a builder for project |
| `afx status` | Check status of all builders |
| `afx send <target> <msg>` | Send a message to a builder or an architect |
| `afx cleanup -p <id>` | Clean up a builder worktree |
| `afx shell` | Spawn a utility shell |
| `afx open <file>` | Open file in workspace viewer |
| `afx tower start` | Start cross-project tower |
| `afx tower connect` | Connect Tower to Codev Cloud for remote access |

### porch

Protocol orchestrator. Drives each protocol's state machine. Used by **builders** (and by the architect to check status).

| Command | Description |
|---------|-------------|
| `porch next <id>` | Get the next tasks (the strict-mode loop) |
| `porch done <id>` | Signal the current phase complete |
| `porch status <id>` | Check project protocol status |
| `porch approve <id> <gate> --a-human-explicitly-approved-this` | Record a human's gate decision (the builder runs it, after the architect relays the decision) |
| `porch pending` | List live pending gates (`--all` includes stale records) |

### consult

Multi-agent consultation. Used by both humans and agents—**mostly agents** during reviews.

| Command | Description |
|---------|-------------|
| `consult -m <model> --prompt "text"` | General consultation |
| `consult -m <model> --protocol spir --type spec` | Review a specification |
| `consult -m <model> --protocol spir --type plan` | Review an implementation plan |
| `consult -m <model> --protocol spir --type pr` | Review a pull request |
| `consult -m <model> --type integration --issue <N>` | Architect's integration review of PR N |
| `consult stats` | View consultation statistics |

**Models**: `gemini` (alias: `pro`), `codex` (alias: `gpt`), `claude` (alias: `opus`)

**Review Types** (`spec`, `plan`, `impl`, `pr`, `phase` need `--protocol`; `integration` takes none):
| Type | Use Case |
|------|----------|
| `spec` | Review spec completeness and clarity |
| `plan` | Review plan coverage and feasibility |
| `impl` | Review implementation quality (Builder use) |
| `pr` | Review pull request before merge |
| `phase` | Phase-scoped review (Builder use) |
| `integration` | Review architectural fit (Architect use, with `--issue <N>`) |

---

## Quick Reference

### SPIR Checklist

```
[ ] Specify - Write spec in codev/specs/<id>-<name>.md
[ ] Plan - Write plan in codev/plans/<id>-<name>.md
    For each phase of the plan:
      [ ] Implement - Write code following the plan
      [ ] Defend - Write tests for the implementation
      [ ] Evaluate - Consult external reviewers, address feedback
[ ] Review - Write review in codev/reviews/<id>-<name>.md, create PR
```

### Consultation Pattern

Run each review as its own background task (in Claude Code, `run_in_background: true`, not a
trailing `&`), so the turn ends and you are notified as each finishes:

```bash
consult -m gemini --protocol spir --type pr
consult -m codex --protocol spir --type pr
consult -m claude --protocol spir --type pr
```

In strict mode porch hands builders these commands itself.

---

*For detailed documentation, see the full protocol files in `codev/protocols/`.*
