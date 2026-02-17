# Codev Manifesto

## What is Codev?

Codev is a framework for AI-assisted software development. It provides protocols, roles, and tooling to orchestrate multiple AI agents working together on complex software projects.

## Core Philosophies

### 1. Natural Language is the Programming Language

Specifications and plans written in natural language are the primary artifacts. Code is generated from these documents, not the other way around. When requirements change, update the spec first. The spec is the source of truth; code is a derived artifact.

### 2. Multiple Models Perform Better

No single AI model has all the answers. Different models have different strengths:
- One model writes the code
- Another reviews it for edge cases
- A third catches architectural issues

Multi-agent consultation catches errors that single-agent workflows miss. The cost of consultation is far less than the cost of bugs in production.

### 3. Parallel Agents are Faster

Complex projects can be decomposed into independent specs. Multiple builders working in isolated git worktrees can implement features simultaneously. The architect orchestrates; the builders execute. Parallelism multiplies throughput.

## Core Concepts

### Protocols

Protocols are sequences of steps to build something. Each protocol balances rigor against speed.

| Protocol | Purpose | When to Use |
|----------|---------|-------------|
| **SPIR** | Multi-phase development with consultation | Complex features, architecture changes, unclear requirements |
| **TICK** | Fast autonomous implementation | Small features, bug fixes, well-defined tasks |
| **EXPERIMENT** | Disciplined experimentation | Prototypes, research spikes, evaluating approaches |

**Note**: To skip consultation in SPIR, say "without consultation" when starting work.

### Roles

| Role | Responsibility |
|------|----------------|
| **Architect** | Understands the big picture. Decomposes work into specs. Spawns and orchestrates builders. Reviews and integrates. Never writes code directly. |
| **Builder** | Implements a single spec in isolation. Works in a git worktree. Reports status. Asks for help when blocked. Delivers clean PRs. |
| **Consultant** | External models (GPT-5, Gemini) that review work at checkpoints. Catch issues the primary agent missed. Provide alternative perspectives. |

### Tools

| Tool | Purpose |
|------|---------|
| **Agent Farm (`af`)** | Orchestrates parallel builders. Manages git worktrees, spawns agents, tracks status, provides a dashboard. |
| **Consult** | Multi-model consultation. Query Gemini, Codex, and Claude for review and validation. |

#### Agent Farm

Enables the Architect-Builder pattern with isolated execution environments:

```bash
af dash start         # Launch the architect dashboard
af spawn 3            # Create a builder for project 3
af status             # See what everyone is doing
af cleanup -p 3       # Clean up when done
```

#### Consult

Brings external models into the conversation for review and validation:

```bash
# Consult Gemini or Codex
consult -m gemini --prompt "Review this spec for issues..."
consult -m codex --prompt "Review this implementation..."

# Parallel 3-way review
consult -m gemini --protocol spir --type spec &
consult -m codex --protocol spir --type spec &
consult -m claude --protocol spir --type spec &
wait
```

Consultation happens at protocol checkpoints. The primary agent implements; consultants review.

## Design Principles

1. **Context drives code** - More documentation, not less. Natural language specs reduce ambiguity.

2. **Fail fast, never fallback** - When something fails, fail loudly. No silent retries. No guessing.

3. **Atomic commits per phase** - Each protocol phase produces a commit. History tells the story.

4. **Specs before code** - Never implement without a spec. Even for "small" changes.

5. **Reviews capture knowledge** - Lessons learned documents prevent repeating mistakes.

---

*Codev: Where natural language meets parallel execution.*
