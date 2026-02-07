# Codev Conceptual Model

This document defines the core abstractions in the Codev system and clarifies their boundaries, responsibilities, and composability.

## The Four Abstractions

Codev uses four distinct concepts that work together in a layered hierarchy:

```
Roles → Protocols → Subagents → Skills
(Who)    (How)       (What)      (Tools)
```

### 1. Roles = The "Who" (Perspective & Priorities)

**Definition:** A Role is a persistent **persona** with a specific set of values, expertise, and priorities. Roles define *judgment*, not steps.

**Characteristics:**
- Scope: Global or session-wide
- Persistence: Durable across tasks
- Purpose: Decides *when* to run which protocol, holds accountability

**Examples in Codev:**
- **Architect**: Prioritizes maintainability, system boundaries, documentation. Creates specs, coordinates work, reviews outcomes.
- **Builder**: Responsible for the structural integrity, functionality, and quality of the artifact. Takes the Architect's plans and turns them into working reality. Works in isolated git worktrees.

> **What "Builder" means:** In codev, "building" is not limited to creating new things. A Builder can:
> - **Build** new features from scratch
> - **Remodel** existing code (refactoring, restructuring)
> - **Repair** defects (bug fixes, error handling)
> - **Extend** functionality (enhancements, integrations)
> - **Validate** quality (writing tests, running checks)
> - **Document** the work (updating docs, adding comments)
> - **Maintain** the codebase (cleanup, dependency updates)
>
> The Builder owns the *artifact* - the complete, working result - not just the act of typing code. This mirrors real-world construction: a builder doesn't just erect new structures; they also renovate, repair, and maintain.

**Location:** `codev/roles/`

**Key Insight:** A Role without a Protocol is just a personality. Roles need Protocols to define *what* they do.

---

### 2. Protocols = The "How" (Orchestration & Lifecycle)

**Definition:** A Protocol is a **multi-phase workflow** that defines the sequence of steps to move a unit of work from start to finish. Protocols are orchestration layers.

**Characteristics:**
- Scope: Duration of a specific mission (feature, cleanup, experiment)
- Structure: State machine with phases, entry/exit criteria
- Purpose: Sequences work, decides *when* to call subagents

**Examples in Codev:**
- **SPIR**: Specify → Plan → Implement → Defend → Evaluate → Review (heavy-duty for complex features)
- **TICK**: Triage → Implement → Check → Klose (lightweight for quick tasks)
- **EXPERIMENT**: Hypothesis → Test → Analyze → Conclude (for research spikes)

**Location:** `codev/protocols/`

**Key Insight:** Protocols orchestrate the *what* (subagents/skills) according to a defined *how* (phases).

---

### 3. Subagents = The "What" (Specialized Task Workers)

**Definition:** A Subagent is a **bounded, autonomous worker** designed to execute a specific, complex task that requires reasoning. Subagents are spawnable micro-workers with narrow contracts.

**Characteristics:**
- Scope: Ephemeral (spawned, does job, terminates)
- Complexity: Requires reasoning/LLM, not just scripting
- Contract: Clear input → concrete artifact/decision output

**Examples in Codev:**
- Custom project-specific agents can be created in `.claude/agents/`
- The `codev import` command uses an interactive Claude session as a subagent for protocol import

**Location:** `.claude/agents/` (for custom agents)

**Key Insight:** Subagents are composable - they can be called by multiple protocols. For example, an architecture-documenter subagent could be invoked by SPIR (in Review phase) AND by a Cleanup protocol (in Sync phase). Codev has moved from bundled agents to CLI commands (like `codev import`) for common workflows, while allowing projects to define custom agents as needed.

---

### 4. Skills = The "Tools" (Atomic Actions)

**Definition:** Skills are **deterministic, atomic capabilities**. They are the hands and eyes of the system - quick, stateless, composable.

**Characteristics:**
- Scope: Instantaneous execution
- Complexity: No reasoning required, scripted behavior
- State: Stateless, idempotent where possible

**Examples:**
- `git commit`, `git status`
- `run_tests`, `lint_code`
- `read_file`, `write_file`
- `grep`, `glob`

**Location:** Built into Claude Code or defined as simple scripts

**Key Insight:** Skills are leaf nodes - they don't orchestrate anything else.

---

## Composability Rules

The abstractions compose in a clear hierarchy:

### 1. Roles execute Protocols

Roles decide which protocol to run based on the situation:

```
Architect (Role) → initiates SPIR (Protocol) for new feature
Builder (Role) → initiates TICK (Protocol) for quick fix
Architect (Role) → initiates CLEANUP (Protocol) for maintenance
```

### 2. Protocols orchestrate Subagents and Skills

Protocol phases dispatch workers to accomplish phase goals:

```
SPIR Protocol
  └── Review Phase
        ├── calls: architecture-documenter (Subagent)
        └── calls: run_tests (Skill)

CLEANUP Protocol
  └── Sync Phase
        ├── calls: architecture-documenter (Subagent)
        └── calls: doc-sync (Subagent)
```

### 3. Subagents use Skills

Subagents compose skills to accomplish their bounded task:

```
architecture-documenter (Subagent)
  ├── uses: read_file (Skill)
  ├── uses: glob (Skill)
  └── uses: write_file (Skill)
```

### 4. Avoid Circular Composition

- **Subagents should NOT call top-level Protocols** (prevents circular orchestration)
- **Skills should NOT call Subagents** (skills are leaf nodes)
- **Protocols CAN embed other protocols** sparingly (e.g., Cleanup might embed EXPERIMENT for flaky test analysis)

---

## Decision Framework

When adding new functionality, ask these questions:

### Is it a Protocol?

Ask: "Is this a multi-step workflow with phases and orchestration needs?"

- Yes → Create a Protocol
- Examples: CLEANUP, REVIEW, MIGRATE

### Is it a Role?

Ask: "Is this a persistent persona with ongoing responsibilities and judgment?"

- Yes → Create a Role
- Examples: Architect, Builder, Maintainer (future)

### Is it a Subagent?

Ask: "Is this a bounded task that requires reasoning but has a narrow contract?"

- Yes → Create a Subagent
- Examples: architecture-documenter, migration-checker, dead-code-auditor

### Is it a Skill?

Ask: "Is this an atomic, deterministic action with no reasoning required?"

- Yes → Create a Skill (or use existing)
- Examples: run_tests, format_code, diff_files

---

## Case Study: Cleanup

**The question:** Should cleanup be a Protocol, Role, Subagent, or Skill?

**Analysis:**
- Cleanup involves multiple distinct activities (dead code, migrations, tests, docs)
- These activities have dependencies and ordering (remove code → run tests → update docs)
- Some activities require reasoning (identifying dead code)
- The process is episodic, not ongoing

**Decision:** Cleanup should be a **Protocol**

**Proposed CLEANUP Protocol:**

```
Phase 1: AUDIT
  - subagent: dead-code-auditor
  - skill: run-static-analysis

Phase 2: PRUNE
  - subagent: refactor-janitor
  - skill: apply-patches
  - skill: run-tests

Phase 3: VALIDATE
  - skill: check-migrations
  - skill: run-tests

Phase 4: SYNC
  - subagent: architecture-documenter
  - subagent: doc-sync (CLAUDE.md ↔ AGENTS.md)
```

**Note:** We do NOT need a "Cleaner" Role. The Architect or Builder can run the CLEANUP protocol when needed (remember: Builders maintain and repair, not just create). A "Maintainer" Role might be added later if governance requires a dedicated persona for cleanup cadence.

---

## Case Study: Architecture Documenter

**The question:** Is architecture-documenter correctly categorized as a Subagent?

**Analysis:**
- Scope: Produces updated architecture documentation (bounded deliverable)
- Complexity: Requires reading multiple files and synthesizing abstractions (needs reasoning)
- Lifecycle: Spawned on demand during specific phases
- Composability: Can be called by SPIR/Review AND CLEANUP/Sync

**Decision:** Yes, architecture-documenter is correctly a **Subagent**

It's:
- Too complex to be a Skill (involves synthesis and reasoning)
- Too narrow to be a Role (no ongoing judgment responsibilities)
- Not a workflow itself (no phases/orchestration)

---

## Summary Table

| Concept | Definition | Scope | Composes | Location |
|---------|------------|-------|----------|----------|
| **Role** | Persistent persona with judgment | Session/Global | Executes Protocols | `codev/roles/` |
| **Protocol** | Multi-phase workflow | Mission duration | Orchestrates Subagents + Skills | `codev/protocols/` |
| **Subagent** | Bounded reasoning task | Ephemeral | Uses Skills | `.claude/agents/` |
| **Skill** | Atomic deterministic action | Instantaneous | Leaf node | Built-in / scripts |

---

## Platform Portability

Codev is designed to be portable across multiple AI CLI platforms. The core concepts (Protocols, Roles, Subagents, Skills) are platform-agnostic, with adapters that translate them to each platform's native constructs.

### Supported Platforms

| Platform | Instruction File | Subagent Location | Skill Mechanism |
|----------|------------------|-------------------|-----------------|
| **Claude Code** | `CLAUDE.md` | `.claude/agents/` | MCP tools, Skills |
| **Gemini CLI** | `GEMINI.md` | `.gemini/` (extensions) | ADK, Extensions |
| **Codex CLI** | `AGENTS.md` | MCP servers | Agents SDK, MCP |

### Concept Mapping

| Codev Concept | Claude Code | Gemini CLI | Codex CLI |
|---------------|-------------|------------|-----------|
| **Protocol** | Orchestrated prompt flows | ADK workflows, Recipes | MCP + gating logic |
| **Role** | Project context (system prompt) | Persona (Strategist/Specialist) | Role definitions (PM, Dev) |
| **Subagent** | `.claude/agents/` folder | SubAgents, ADK components | Agent (via SDK) |
| **Skill** | MCP tool, Skill invocation | Extension, function call | MCP Server endpoint |

### Portability Architecture

Codev uses a **transpilation approach** rather than a runtime wrapper:

```
.codev/                          # Source of truth
├── config.yaml                  # Global settings
├── roles/
│   ├── architect.md             # Architect persona
│   └── builder.md               # Builder persona
├── protocols/
│   ├── spir.yaml                # SPIR workflow definition
│   ├── tick.yaml                # TICK workflow definition
│   └── cleanup.yaml             # CLEANUP workflow definition
└── skills/
    └── shared scripts           # Platform-agnostic scripts

         ↓ codev init --target=claude

CLAUDE.md                        # Generated for Claude Code
.claude/agents/                  # Generated subagent definitions

         ↓ codev init --target=gemini

GEMINI.md                        # Generated for Gemini CLI
.gemini/extensions/              # Generated extensions

         ↓ codev init --target=codex

AGENTS.md                        # Generated for Codex CLI
```

### Core Portability Principles

1. **Markdown Instructions**: All platforms understand markdown-based instructions
2. **Shell Scripts**: All platforms can execute local shell/Python scripts
3. **MCP as Standard**: Model Context Protocol is supported by Claude and Codex; Gemini can bridge via ADK
4. **Graceful Degradation**: Adapters detect platform capabilities and degrade gracefully

### Platform-Specific Features

When a platform offers unique capabilities, codev can leverage them via **hints**:

```yaml
# In a protocol definition
phases:
  - name: implement
    hints:
      claude:
        use_subagent: true
      gemini:
        use_adk_queue: true
      codex:
        use_gating_logic: true
```

Adapters ignore unknown hints, maintaining portability while enabling platform optimizations.

### Capability Detection

Each adapter exposes a capabilities matrix:

| Capability | Claude | Gemini | Codex |
|------------|--------|--------|-------|
| `parallel_agents` | Yes | Proposed | Yes |
| `isolated_worktrees` | Via git | Via git | Via git |
| `streaming_tools` | Yes | Yes | Yes |
| `native_subagents` | Yes | Proposed | Yes (SDK) |
| `mcp_support` | Yes | Bridge | Yes |

Protocols can declare optional features; adapters enable them when available.

### Future: Unified Event Schema

For observability across platforms, codev will define a normalized event schema:

- `protocol_phase_started`
- `role_transition`
- `subagent_spawned`
- `skill_invoked`
- `protocol_completed`

Platform adapters translate native events into this schema for unified logging and analysis.

---

## Research References

This conceptual model was informed by research into coordination systems across platforms:

**Gemini CLI:**
- [Multi-Agent Architecture Proposal](https://github.com/google-gemini/gemini-cli/discussions/7637) - Strategist/Specialist pattern
- [SubAgent Architecture Request](https://github.com/google-gemini/gemini-cli/issues/3132) - Bounded task workers
- [ADK Integration Proposal](https://github.com/google-gemini/gemini-cli/issues/8256) - Agent orchestration
- [Multi-Agent Framework (community)](https://github.com/swghosh/multi-agent-gemini-cli) - File-system-as-state pattern

**Codex CLI:**
- [Building Consistent Workflows](https://cookbook.openai.com/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk) - MCP + Agents SDK
- [Use Codex with Agents SDK](https://developers.openai.com/codex/guides/agents-sdk/) - Multi-agent coordination
- [Codex CLI Documentation](https://developers.openai.com/codex/cli/) - Official reference

**Common Patterns Observed:**
- PM/Coordinator + Specialized Workers (both platforms)
- Task queues / file-system-as-state (Gemini community)
- Gating logic between phases (Codex)
- MCP as interoperability standard (both platforms)

---

## Changelog

- **2025-12-03**: Kept "Builder" name after consultation, but clarified that "building" encompasses remodeling, repair, maintenance - not just new construction. Added platform portability section with mapping to Claude/Gemini/Codex.
- **2025-12-03**: Initial version. Consolidated from discussion with Gemini Pro and GPT-5 Codex consultation.
