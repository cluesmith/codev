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
| Protocols | Define HOW work happens (SPIDER, TICK, etc.) |
| Roles | Define WHO does what (Architect, Builder, Consultant) |
| Parallelism | Scale by running multiple builders simultaneously |

**Corollaries:**
- Well-defined protocols reduce ambiguity and rework
- Clear roles enable autonomous operation
- Parallel execution multiplies throughput

---

## Core Concepts

### Protocols

| Protocol | Use For | Phases |
|----------|---------|--------|
| **SPIDER** | New features | Specify → Plan → Implement → Defend → Evaluate → Review |
| **TICK** | Amendments to existing specs | Task Identification → Coding → Kickout |
| **MAINTAIN** | Codebase hygiene | Dead code removal, documentation sync |
| **EXPERIMENT** | Research & prototyping | Hypothesis → Experiment → Conclude |

### Roles

| Role | Responsibilities |
|------|------------------|
| **Architect** | Orchestrates development, writes specs/plans, reviews PRs, maintains big picture |
| **Builder** | Implements specs in isolated worktrees, writes tests, creates PRs |
| **Consultant** | External reviewers providing second opinions on specs, plans, implementations |

**Consultant Flavors** (via `--type`):
- `spec-review` - Review specification completeness
- `plan-review` - Review implementation plan feasibility
- `impl-review` - Review code for spec adherence
- `integration-review` - Review for architectural fit

### Information Hierarchy

```
┌─────────────────────────────────────────┐
│  arch.md, lessons-learned.md            │  ← System understanding
├─────────────────────────────────────────┤
│  projectlist.md                         │  ← Project tracking
├─────────────────────────────────────────┤
│  specs/, plans/, reviews/               │  ← Feature artifacts
├─────────────────────────────────────────┤
│  Source code                            │  ← Implementation
└─────────────────────────────────────────┘
```

**Key insight**: Higher levels inform lower levels. Start at the top, work down.

---

## Tools Reference

### codev

Project management commands.

| Command | Description |
|---------|-------------|
| `codev init <name>` | Create a new Codev project |
| `codev adopt` | Add Codev to an existing project |
| `codev doctor` | Check dependencies and configuration |
| `codev update` | Update Codev framework |
| `codev tower` | Cross-project dashboard |

### agent-farm (af)

Architect-Builder orchestration.

| Command | Description |
|---------|-------------|
| `af start` | Start the architect dashboard |
| `af stop` | Stop all processes |
| `af spawn -p <id>` | Spawn a builder for project |
| `af status` | Check status of all builders |
| `af send <id> <msg>` | Send message to a builder |
| `af cleanup -p <id>` | Clean up a builder worktree |
| `af open <file>` | Open file in dashboard viewer |

### consult

Multi-agent consultation.

| Command | Description |
|---------|-------------|
| `consult --model <model> spec <id>` | Review a specification |
| `consult --model <model> plan <id>` | Review an implementation plan |
| `consult --model <model> pr <id>` | Review a pull request |
| `consult --model <model> general "<query>"` | General consultation |

**Models**: `gemini` (alias: `pro`), `codex` (alias: `gpt`), `claude` (alias: `opus`)

**Review Types** (via `--type`):
| Type | Use Case |
|------|----------|
| `spec-review` | Review spec completeness and clarity |
| `plan-review` | Review plan coverage and feasibility |
| `impl-review` | Review implementation quality |
| `integration-review` | Review architectural fit (Architect use) |

---

## Quick Reference

### SPIDER Checklist

```
[ ] Specify - Write spec in codev/specs/XXXX-name.md
[ ] Plan - Write plan in codev/plans/XXXX-name.md
[ ] Implement - Write code following the plan
[ ] Defend - Write tests for the implementation
[ ] Evaluate - Consult external reviewers, address feedback
[ ] Review - Write review in codev/reviews/XXXX-name.md, create PR
```

### Consultation Pattern

```bash
# Run 3-way review in parallel
consult --model gemini pr <id> &
consult --model codex pr <id> &
consult --model claude pr <id> &
wait
```

### Git Workflow

```bash
# NEVER use git add -A or git add .
# ALWAYS add files explicitly
git add codev/specs/XXXX-name.md
git commit -m "[Spec XXXX][Phase] Description"

# PR merging - use regular merge, not squash
gh pr merge <number> --merge
```

---

*For detailed documentation, see the full protocol files in `codev/protocols/`.*
