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
| Protocols | Define HOW work happens (SPIR, TICK, etc.) |
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
| **SPIR** | New features | Specify → Plan → Implement → Review |
| **TICK** | Amendments to existing specs | Task Identification → Coding → Kickout |
| **MAINTAIN** | Codebase hygiene | Dead code removal, documentation sync |
| **EXPERIMENT** | Research & prototyping | Hypothesis → Experiment → Conclude |

### Roles

A **role** defines who does what work and what tools/permissions they have.

| Role | Responsibilities |
|------|------------------|
| **Architect** | Orchestrates development, writes specs/plans, reviews PRs, maintains big picture |
| **Builder** | Implements specs in isolated worktrees, writes tests, creates PRs |
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

**Key insight**: We build from the top down, and we propagate information from the bottom up. We start with an entry in the project list, then spec and plan out the feature, generate the code, and then propagate what we learned through the reviews. 

---

## Tools Reference

### codev

Project management commands. Typically used by **humans** to set up and maintain projects.

| Command | Description |
|---------|-------------|
| `codev init <dirname>` | Create a new Codev project |
| `codev adopt` | Add Codev to an existing project |
| `codev doctor` | Check dependencies and configuration |
| `codev update` | Update Codev framework |
| `codev import` | Import specs from another project |

### agent-farm (af)

Architect-Builder orchestration. Used by both **humans and agents**—agents use it more frequently.

| Command | Description |
|---------|-------------|
| `af workspace start` | Start workspace (port 4200, 4300, etc.) |
| `af workspace stop` | Stop all processes |
| `af spawn <id> --protocol spir` | Spawn a builder for project |
| `af status` | Check status of all builders |
| `af send <target> <msg>` | Send message (builder↔architect) |
| `af cleanup -p <id>` | Clean up a builder worktree |
| `af shell` | Spawn a utility shell |
| `af open <file>` | Open file in workspace viewer |
| `af tower start` | Start cross-project tower |

### consult

Multi-agent consultation. Used by both humans and agents—**mostly agents** during reviews.

| Command | Description |
|---------|-------------|
| `consult -m <model> --prompt "text"` | General consultation |
| `consult -m <model> --protocol spir --type spec` | Review a specification |
| `consult -m <model> --protocol spir --type plan` | Review an implementation plan |
| `consult -m <model> --protocol spir --type pr` | Review a pull request |
| `consult stats` | View consultation statistics |

**Models**: `gemini` (alias: `pro`), `codex` (alias: `gpt`), `claude` (alias: `opus`)

**Review Types** (via `--type` with `--protocol`):
| Type | Use Case |
|------|----------|
| `spec` | Review spec completeness and clarity |
| `plan` | Review plan coverage and feasibility |
| `impl` | Review implementation quality (Builder use) |
| `pr` | Review pull request before merge |
| `phase` | Phase-scoped review (Builder use) |
| `integration` | Review architectural fit (Architect use) |

---

## Quick Reference

### SPIR Checklist

```
[ ] Specify - Write spec in codev/specs/XXXX-name.md
[ ] Plan - Write plan in codev/plans/XXXX-name.md
    For each phase of the plan:
      [ ] Implement - Write code following the plan
      [ ] Defend - Write tests for the implementation
      [ ] Evaluate - Consult external reviewers, address feedback
[ ] Review - Write review in codev/reviews/XXXX-name.md, create PR
```

### Consultation Pattern

```bash
# Run 3-way review in parallel
consult -m gemini --protocol spir --type pr &
consult -m codex --protocol spir --type pr &
consult -m claude --protocol spir --type pr &
wait
```

---

*For detailed documentation, see the full protocol files in `codev/protocols/`.*
