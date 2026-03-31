# Analysis: Codev Modularization

## Metadata
- **ID**: 0082
- **Status**: analyzed (awaiting decision)
- **Created**: 2026-01-27
- **Type**: Analysis Document (not implementation spec)
- **Purpose**: Evaluate splitting codev into separate packages

## Executive Summary

Should we split `@cluesmith/codev` into three independent packages?

| Package | Purpose |
|---------|---------|
| **codev** | Core functionality (init, adopt, doctor, protocols, consult) |
| **agentfarm** | Multi-agent orchestration (dashboard, terminals, builders, web access) |
| **porch** | Protocol orchestrator (state machine, gates, AI backends) |

This document analyzes the pros, cons, and strategic implications.

---

## Current State

### Single Package: `@cluesmith/codev`

```
@cluesmith/codev (npm)
├── bin/
│   ├── codev.js      # codev init, adopt, doctor, update
│   ├── af.js         # afx start, spawn, status, cleanup
│   ├── consult.js    # consult --model gemini spec 42
│   └── porch.js      # porch init, run, status, approve
├── src/
│   ├── commands/     # All CLI implementations
│   ├── agent-farm/   # Dashboard, terminals, state
│   └── ...
└── skeleton/         # Protocol templates
```

**Install**: `npm install -g @cluesmith/codev`
**Result**: Gets everything - codev, afx, consult, porch

---

## Proposed State

### Three Packages

```
@cluesmith/codev (core)
├── bin/codev.js
├── bin/consult.js
└── Protocols, templates, init/adopt

@cluesmith/agentfarm
├── bin/af.js
├── Dashboard server
├── Terminal management
├── Web access (0081)
└── Depends on: @cluesmith/codev (peer)

@cluesmith/porch
├── bin/porch.js
├── State machine
├── Gate enforcement
├── AI backends
└── Depends on: nothing (standalone)
```

**Install options**:
- `npm install -g @cluesmith/codev` - Just core
- `npm install -g @cluesmith/agentfarm` - Full multi-agent workflow
- `npm install -g @cluesmith/porch` - Just protocol orchestration

---

## Analysis: PROS

### 1. Clearer Value Proposition

**Current problem**: "What is codev?" is hard to answer in one sentence.

**With modularization**:
- **codev**: "Structured development protocols for AI coding"
- **agentfarm**: "Orchestrate multiple AI agents in parallel"
- **porch**: "Enforce development workflows with gates"

Each package has a focused pitch.

### 2. Lower Barrier to Entry

**Current**: User must buy into everything
- Complex setup (ttyd, tmux, etc.)
- Dashboard they may not need
- Multi-agent patterns they may not want yet

**With modularization**:
- Start with `codev` for just SPIR protocols
- Add `agentfarm` when ready for parallel builders
- Use `porch` standalone for any protocol enforcement

**Adoption funnel**:
```
codev (low friction)
    ↓
"This is useful, what else?"
    ↓
agentfarm (higher investment)
    ↓
"I need custom workflows"
    ↓
porch (advanced users)
```

### 3. Independent Release Cycles

**Current**: One change anywhere = new version for everything

**With modularization**:
- Fix a dashboard bug → only `agentfarm` releases
- Add new AI backend → only `porch` releases
- Update protocols → only `codev` releases

Less churn for users who don't need the changes.

### 4. Easier Contributions

**Current**: Contributors must understand the entire codebase

**With modularization**:
- Want to improve protocols? → Just learn `codev`
- Building a dashboard feature? → Just learn `agentfarm`
- Adding Gemini backend? → Just learn `porch`

### 5. Marketing Flexibility

**"AgentFarm"** as a brand:
- Sounds exciting, visual
- Could have its own landing page
- Appeals to "multi-agent" audience
- Independent from "codev" (enterprise protocol) vibe

**"Porch"** as a brand:
- Developer tool feel
- "Protocol orchestrator" has technical appeal
- Could be used with OTHER agentic systems (not just codev)

### 6. Porch as Universal Tool

If `porch` is standalone:
- Could be used with Cursor, Aider, other AI tools
- Not tied to codev/agentfarm ecosystem
- Broader adoption potential
- "Use porch to enforce SPIR on any AI coding workflow"

---

## Analysis: CONS

### 1. Installation Complexity

**Current**: One command installs everything
```bash
npm install -g @cluesmith/codev
```

**With modularization**: Users must know what they need
```bash
npm install -g @cluesmith/codev @cluesmith/agentfarm
# Or
npm install -g @cluesmith/agentfarm  # with peer dep
```

**Mitigation**: agentfarm could auto-install codev as dependency

### 2. Version Compatibility Hell

Three packages must stay compatible:
- agentfarm 2.0 requires codev >=1.5
- porch 3.0 breaks with agentfarm <2.1
- User has codev 1.4, agentfarm 2.0, porch 3.0 → ???

**Mitigation**:
- Strict peer dependencies
- Version matrix documentation
- `codev doctor` checks compatibility

### 3. Documentation Fragmentation

**Current**: One doc site, one README, one CLAUDE.md

**With modularization**:
- Three README files
- Three doc sites (or one with confusing navigation)
- User doesn't know where to look

**Mitigation**:
- Unified docs site with clear sections
- "Getting Started" always leads through codev → agentfarm

### 4. Shared Code Duplication

Some code is shared:
- Logging utilities
- Config management
- Protocol definitions
- Type definitions

**Options**:
- Fourth package: `@cluesmith/codev-common` (ugh)
- Copy code into each package (maintenance burden)
- Accept some duplication

### 5. Testing Complexity

**Current**: One test suite, one CI pipeline

**With modularization**:
- Three test suites
- Integration tests span packages
- CI must test combinations
- More infrastructure

### 6. User Confusion

"Do I need agentfarm or porch or both?"
"I installed codev but `afx` command doesn't work"
"Which package has the bug?"

**Mitigation**: Clear docs, error messages that suggest missing packages

---

## Marketing & Adoption Analysis

### Target Audiences

| Audience | Primary Interest | Package |
|----------|------------------|---------|
| Solo developer wanting structure | SPIR protocol | codev |
| Team wanting parallel AI development | Multi-agent | agentfarm |
| Enterprise wanting audit/compliance | Gates, enforcement | porch |
| Tool builders / integrators | Reusable orchestration | porch |

### Brand Positioning Options

**Option A: Codev as Umbrella**
```
Codev
├── codev core
├── agentfarm (by codev)
└── porch (by codev)
```
- Unified brand
- Clear ownership
- But: "codev" appears twice, confusing

**Option B: Sibling Brands**
```
Cluesmith
├── Codev (protocols)
├── AgentFarm (orchestration)
└── Porch (enforcement)
```
- Each stands alone
- Can market independently
- But: Lose "codev" recognition

**Option C: AgentFarm as Hero**
```
AgentFarm
├── Protocols (codev)
├── Dashboard
└── Porch (optional)
```
- "AgentFarm" is more exciting name
- Dashboard is visual, demo-able
- But: Existing "codev" users confused

### Adoption Scenarios

**Scenario 1: New User Discovery**

*Current*: Finds codev → installs → overwhelmed by features

*Modular*: Finds codev → installs → clear next step → agentfarm when ready

**Scenario 2: Enterprise Evaluation**

*Current*: "We want gate enforcement" → "Install codev" → "What's all this other stuff?"

*Modular*: "We want gate enforcement" → "Install porch" → Evaluates just that

**Scenario 3: Competitor User**

*Current*: Cursor user wants SPIR → Must adopt entire codev ecosystem

*Modular*: Cursor user wants SPIR → Installs just porch → Uses with Cursor

---

## Strategic Considerations

### Porch as Strategic Asset

If porch is standalone:
- Can be the "Prettier for AI workflows"
- Works with any AI coding tool
- Network effects: porch protocols become standard
- Other tools adopt SPIR via porch

**Risk**: If porch succeeds independently, does it cannibalize codev?

**Counter**: Porch success → More users want agentfarm → More users want codev

### AgentFarm as Differentiator

Multi-agent orchestration is the **unique value**:
- No other tool does parallel AI builders well
- Dashboard is visual proof of concept
- "AgentFarm" name captures imagination

Should AgentFarm be the **primary brand**?

### Codev as Foundation

Protocols (SPIR, TICK, BUGFIX) are the **intellectual property**:
- Novel contribution to AI-assisted development
- What makes this more than "AI coding tools"
- Enterprise appeal

But: Protocols alone don't sell → Need tools to demonstrate value

---

## Decision Framework

### Modularize IF:
1. You believe porch has standalone value outside codev ecosystem
2. You want to pursue enterprise market (gate enforcement)
3. You're willing to invest in multi-package infrastructure
4. You see "AgentFarm" as a distinct marketing opportunity

### Stay Monolithic IF:
1. Current package size isn't a barrier to adoption
2. Single install simplicity is more important
3. Limited bandwidth for multi-package maintenance
4. Brand is "codev" and everything else is features

---

## Recommendation

**Phased approach**:

### Phase 1: Extract Porch (Low Risk)
- Porch has clearest standalone value
- Already somewhat isolated in codebase
- Can be used with other tools
- Test modularization with one package

### Phase 2: Evaluate
- Did porch extraction help adoption?
- Did version management become painful?
- Is there demand for agentfarm separately?

### Phase 3: Maybe Extract AgentFarm
- Only if Phase 1 was positive
- Rename to something memorable
- Position as "multi-agent orchestration platform"

**Don't extract codev core** - it becomes too thin to be useful alone.

---

## Open Questions

1. **Naming**: Is "AgentFarm" the right name? Alternatives:
   - Hive
   - Colony
   - Swarm
   - Fleet

2. **Porch scope**: Should porch include consult tool? Or is consult part of codev?

3. **Protocol ownership**: If porch is standalone, where do SPIR/TICK definitions live?

4. **npm scope**: Keep `@cluesmith/` or new scope like `@agentfarm/`?

5. **Backwards compatibility**: What happens to existing `@cluesmith/codev` users?

---

## Next Steps

1. Gather feedback on this analysis
2. Consult Gemini + Codex for external perspective
3. Survey existing users (if any) on preferences
4. Make go/no-go decision on porch extraction
5. If go: Create implementation spec

---

## Consultation Log

### Consultation Attempt (2026-01-28)

**Status**: External consultations (Gemini, Codex, Claude) failed due to shell environment issues in builder worktree.

**Self-Review Performed**: Builder 0082 conducted thorough self-analysis.

### Codebase Structure Analysis

| Module | Files | Current Location | Standalone Readiness |
|--------|-------|------------------|---------------------|
| Porch | 22 | `src/commands/porch/` | High - has own `porch.js` entry |
| Agent Farm | 62 | `src/agent-farm/` | Medium - imports porch for strict mode |
| Codev Core | 26 | `src/commands/` + `src/lib/` | N/A - remains as main package |

**Key Finding**: No circular dependencies. Code flows: Codev → AgentFarm → Porch.

### Gaps Identified

1. **Migration Strategy Missing** - How do existing users transition?
2. **Monorepo Tooling Undecided** - Turborepo vs nx vs pnpm workspaces
3. **TypeScript Types Sharing** - Where do shared types live?
4. **CLI Entry Point Strategy** - What happens to `afx` shim?
5. **Build/Publish Workflow** - Coordinated releases across packages?

### Additional Risks Identified

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Version drift between packages | High | Medium | Strict peer deps, compatibility matrix |
| User confusion on what to install | Medium | High | Clear "getting started" path |
| Maintenance burden triples | High | High | Start with just porch extraction |
| Breaking changes compound | Medium | High | Semantic versioning discipline |

### Alternative Approaches Considered

1. **Lazy Loading** - Keep single package, lazy-load subsystems
2. **Plugin Architecture** - `codev install @cluesmith/agentfarm-plugin`
3. **Feature Flags** - Single package with configurable features

### Recommendation Validation

The spec's phased approach (Porch first) is validated by codebase analysis:
- Porch has clearest API boundaries
- Already has standalone entry point
- Minimal coupling to other modules
- 22 files is manageable extraction scope

### Suggested Addition Before Porch Extraction

Create `@cluesmith/codev-common` for shared utilities:
- Logger
- Config parser
- Type definitions
- Error classes

This prevents duplication and creates clean foundation for multiple packages.

---

## References

- Lerna / Turborepo / nx for monorepo management
- How Babel modularized (babel-core, babel-cli, plugins)
- How ESLint modularized (eslint, plugins, configs)
- [npm peer dependencies](https://docs.npmjs.com/cli/v8/configuring-npm/package-json#peerdependencies)
