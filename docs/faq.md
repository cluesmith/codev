# Frequently Asked Questions

## How do Codev Protocols and Roles compare to Claude Code subagents and skills?

These are **fundamentally different concepts** that operate at different layers. Here's an accurate comparison:

### Builders vs Subagents

**They are not the same thing.**

| Aspect | Claude Code Subagent | Codev Builder |
|--------|---------------------|---------------|
| **What it is** | A spawned task within the same Claude session | A **full Claude Code instance** in its own terminal |
| **Isolation** | Shares context with parent | **Isolated git worktree** with its own branch |
| **Lifetime** | Returns result and terminates | Runs until PR is merged |
| **Parallelism** | Limited by token context | True parallelism - multiple terminals |
| **Git access** | Same working directory | Own branch, can commit freely |
| **Human interaction** | None (autonomous task) | Can ask questions, report blocked status |

A Builder is essentially **another human-equivalent developer** working in parallel, not a helper task.

### Roles vs Subagents

**Also not the same thing.**

| Aspect | Claude Code Subagent | Codev Role |
|--------|---------------------|------------|
| **Scope** | Single task | Entire session |
| **How applied** | Task tool spawns it | System prompt loaded at startup |
| **Persistence** | Ephemeral | Persistent throughout session |
| **Purpose** | Parallelize specific work | Define persona, responsibilities, constraints |

A Role (Architect, Builder, Consultant) shapes **how the agent thinks and operates** for an entire session. It's not spawned for a task - it's who the agent *is*.

### Protocols vs Skills

**Different purposes entirely.**

| Aspect | Claude Code Skill | Codev Protocol |
|--------|------------------|----------------|
| **What it is** | Slash command that injects context | Multi-phase development methodology |
| **Phases** | Single action | Multiple stages with defined transitions |
| **Human gates** | None | Required approvals between phases |
| **Artifacts** | May produce output | Produces specs, plans, reviews |
| **External review** | No | Multi-model consultation built in |

A Protocol like SPIR defines a complete development lifecycle:
```
Specify (human approval) → Plan (human approval) → Implement (with IDE loop) → Review
```

Skills are more like shortcuts or macros. Protocols are methodologies.

### Summary

| Codev Concept | What it actually is | NOT equivalent to |
|---------------|--------------------|--------------------|
| **Builder** | Full Claude instance in isolated worktree | Subagent |
| **Role** | Session-wide persona via system prompt | Subagent |
| **Protocol** | Multi-phase methodology with human gates | Skill |

### How they work together

Codev runs *on top of* Claude Code. The Architect and Builder roles use Claude Code's tools (Bash, Read, Write, Task, etc.) but add:

- **Isolated parallel execution** via git worktrees
- **Structured workflows** with human approval gates
- **External consultation** with other AI models
- **Persistent project tracking** across sessions

Think of Claude Code as the engine. Codev is the operating system that orchestrates it for larger software projects.

## What protocols are available?

Codev ships with several protocols for different types of work:

| Protocol | Use For | Key Trait |
|----------|---------|-----------|
| **SPIR** | New features | Full ceremony: Specify → Plan → Implement → Review with human gates |
| **ASPIR** | Trusted features | Same as SPIR but without human gates on spec/plan — builder runs autonomously |
| **AIR** | Small features (< 300 LOC) | Lightweight: Implement → Review, no spec/plan artifacts |
| **BUGFIX** | Bug fixes from GitHub issues | Minimal: fix, test, PR — no spec needed |
| **TICK** | Amendments to existing specs | Extends an existing SPIR spec with incremental changes |
| **MAINTAIN** | Code hygiene | Dead code removal, documentation sync, dependency cleanup |
| **EXPERIMENT** | Research spikes | Hypothesis → Experiment → Conclude |

**How to choose**: SPIR for anything significant or novel. ASPIR for trusted, well-scoped features. AIR or BUGFIX for small work. TICK to amend an existing spec.

## What is porch?

**Porch** is the protocol orchestrator. It drives SPIR, ASPIR, TICK, and BUGFIX protocols via a state machine — managing phase transitions, human approval gates, and multi-agent consultations automatically.

When you `af spawn` a builder, porch orchestrates its work:
- Enforces phase order (can't skip from Specify to Implement)
- Runs 3-way consultations at checkpoints
- Blocks at human gates until approved
- Tracks state in `codev/projects/<id>/status.yaml`

You can also use porch manually: `porch status 42`, `porch run 42`, `porch approve 42 spec-approval`.

## Can I use Codev without Agent Farm?

Yes. All protocols (SPIR, TICK, etc.) work in any AI coding assistant — Claude Code, Cursor, Copilot, or any tool that reads CLAUDE.md/AGENTS.md. Just tell your AI: *"I want to build X using the SPIR protocol"*.

Agent Farm adds parallel builder orchestration, a web dashboard, and automated protocol enforcement. It's optional but powerful for larger projects.

## Can I access Agent Farm remotely?

Yes. Register your tower with [codevos.ai](https://codevos.ai) using `af tower connect`, then access your workspace from any browser. No SSH tunnels or port forwarding needed.

## More questions?

Join the conversation in [GitHub Discussions](https://github.com/cluesmith/codev/discussions) or our [Discord community](https://discord.gg/mJ92DhDa6n).
