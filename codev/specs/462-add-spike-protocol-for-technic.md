# Specification: Add Spike Protocol for Technical Feasibility Exploration

## Metadata
- **ID**: spec-2026-02-21-spike-protocol
- **Status**: draft
- **Created**: 2026-02-21
- **Updated**: 2026-02-21

## Clarifying Questions Asked

1. **Q: Should spike output go to `codev/reviews/` or a new `codev/spikes/` directory?**
   A: Per the issue, this is an open question. Given that spikes are distinct from reviews (they're pre-implementation research, not post-implementation reflection), a dedicated `codev/spikes/` directory is cleaner. However, this adds a new directory convention to the codev ecosystem. The alternative is reusing `codev/reviews/` since it's already the catch-all for non-spec/plan documents.

2. **Q: Should spikes have any consultation at all, or should it be completely disabled?**
   A: Per the issue — no consultation by default. Speed is the priority. Builders can manually consult if they choose.

3. **Q: How does spike relate to the existing experiment protocol?**
   A: Spike is lighter than experiment. Experiment has a formal hypothesis/design/execute/analyze cycle. Spike is: explore, try things, document what you learned. No hypothesis structure needed.

4. **Q: Should porch support spike at all?**
   A: Soft mode only — no porch orchestration. Spike runs as a soft-mode builder that follows the protocol document directly, similar to how experiments work today.

## Problem Statement

Codev currently has no protocol for quick technical feasibility investigations. When the architect needs to answer "Can we do X?" or "What would approach Y require?", the options are:

- **SPIR**: Too heavy — requires spec, plan, gates, consultation. Overhead destroys the speed advantage.
- **EXPERIMENT**: Better but still structured around formal hypothesis testing with design phases. The hypothesis/analyze framing adds friction when you just want to explore.
- **Ad-hoc**: No structure at all — findings get lost, time isn't bounded, output is inconsistent.

There's a gap between "formal experiment" and "just try stuff."

## Current State

Today, technical feasibility work either:
1. Gets shoehorned into an EXPERIMENT protocol (forcing unnecessary hypothesis framing)
2. Happens informally with no structured output (knowledge gets lost)
3. Gets embedded in a SPIR spec's "Solution Approaches" section (mixing exploration with specification)

None of these are ideal. The architect needs a way to say "spend an hour figuring out if X is feasible" and get back a structured findings document.

## Desired State

A lightweight `spike` protocol that:
- Can be spawned with `af spawn --task "Can we do X?" --protocol spike`
- Runs autonomously (no gates, no human approval needed)
- Produces a structured findings document
- Emphasizes time-boxing (stay focused, stop when the question is answered)
- Is easy to reference later when deciding whether to pursue a full SPIR project

## Stakeholders
- **Primary Users**: Architects deciding whether to invest in a full feature
- **Secondary Users**: Builders executing spikes
- **Technical Team**: Codev maintainers (us)

## Success Criteria
- [ ] `codev-skeleton/protocols/spike/protocol.json` exists and validates against protocol-schema.json
- [ ] `codev-skeleton/protocols/spike/protocol.md` documents the protocol clearly
- [ ] `codev-skeleton/protocols/spike/builder-prompt.md` provides effective builder instructions
- [ ] `codev-skeleton/protocols/spike/templates/findings.md` provides a useful findings template
- [ ] Protocol can be referenced by `af spawn --protocol spike`
- [ ] Soft mode only — porch treats it as a no-orchestration protocol
- [ ] No gates defined in protocol.json
- [ ] Consultation disabled by default in protocol.json
- [ ] Three phases defined: research, iterate, findings
- [ ] Output is a single findings document

## Constraints

### Technical Constraints
- Must conform to `codev-skeleton/protocols/protocol-schema.json`
- Must work with the existing `af spawn` and porch infrastructure
- Soft mode only — porch should not attempt to orchestrate spike projects
- Must use existing protocol directory conventions

### Business Constraints
- Should be simple enough that builders can follow without extensive guidance
- Must not add complexity to existing protocols

## Assumptions
- The protocol-schema.json supports a protocol with no gates (confirmed: bugfix and experiment have no gates)
- `af spawn --protocol spike` will work once the protocol directory exists in codev-skeleton
- Soft mode builders can follow protocol.md directly without porch orchestration
- The `input` field can use type `task` (per protocol-schema.json enum: `spec`, `github-issue`, `task`, `protocol`, `shell`, `worktree`) with `required: false`

## Solution Approaches

### Approach 1: Three-Phase Linear Protocol (Recommended)
**Description**: Define spike as a 3-phase protocol: research → iterate → findings. Each phase is `once` type. No gates, no consultation. Input type is `task` (task description comes from `af spawn --task "..." --protocol spike`). Output goes to `codev/spikes/` directory.

**Pros**:
- Matches the issue description exactly (Research, Iterate, Findings)
- Simple linear flow — no branching or complex transitions
- Dedicated output directory keeps spikes separate from reviews
- Clean semantic separation: reviews are retrospective, spikes are prospective

**Cons**:
- Adds a new `codev/spikes/` directory convention
- Projects adopting codev need to know about one more directory

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Two-Phase Minimal Protocol
**Description**: Collapse to just explore → findings. The "iterate" phase is implicit within exploration.

**Pros**:
- Even simpler
- Fewer phases to track

**Cons**:
- Loses the explicit signal to "stop researching, start building"
- The iterate phase (building proof-of-concept code) is distinct from research (reading docs, examining code)
- Doesn't match the issue description

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 3: Reuse Reviews Directory
**Description**: Same as Approach 1 but output goes to `codev/reviews/` instead of a new `codev/spikes/` directory.

**Pros**:
- No new directory to manage
- Reviews directory already exists

**Cons**:
- Semantically wrong — spikes aren't reviews
- Clutters the reviews directory with non-review documents
- Harder to find spike findings later

**Estimated Complexity**: Low
**Risk Level**: Low

**Recommended**: Approach 1 — three phases with dedicated `codev/spikes/` directory.

## Open Questions

### Critical (Blocks Progress)
- [x] Output directory: `codev/spikes/` vs `codev/reviews/` — Recommending `codev/spikes/`

### Important (Affects Design)
- [x] Should `codev init` / `codev adopt` create the `codev/spikes/` directory? Or create it on first spike? — Create on first spike. Adding a new directory to init/adopt requires changes to the codev CLI, which is out of scope. The builder-prompt can instruct the builder to `mkdir -p codev/spikes/` when writing findings.
- [x] What input type to use in protocol.json? — Use `task` (not `none`). The `task` type is in the protocol schema enum and matches the spawn pattern `af spawn --task "Can we do X?" --protocol spike`. Unlike experiments, spikes are specifically driven by a task/question.

### Nice-to-Know (Optimization)
- [x] Should the findings template include a "Recommended Next Steps" section linking to SPIR? — Yes. The primary output of a spike is a feasibility verdict that informs whether to start a SPIR project. A "Next Steps" section explicitly bridges spike → SPIR.

## Performance Requirements
- N/A — this is a protocol definition, not runtime code

## Security Considerations
- N/A — no authentication, authorization, or data handling changes

## Test Scenarios

### Functional Tests
1. protocol.json validates against protocol-schema.json
2. `af spawn --task "test spike" --protocol spike` creates a working builder (manual verification)
3. Builder in soft mode can follow the protocol and produce a findings document

### Non-Functional Tests
1. Protocol documentation is clear enough for a builder to follow without ambiguity

## Dependencies
- **Internal Systems**: Protocol schema (`protocol-schema.json`), af spawn infrastructure, porch (must not break)
- **Libraries/Frameworks**: None — this is documentation and JSON configuration

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Schema doesn't support spike's needs | Low | Medium | Validated that experiment uses similar patterns |
| Porch tries to orchestrate spike | Low | Medium | Set mode to soft-only, test that porch handles gracefully |
| New `codev/spikes/` directory confuses users | Low | Low | Document clearly in protocol.md |

## Protocol Design Details

### Phase Structure

**Phase 1: Research**
- Read documentation, examine existing code, search for prior art
- Identify constraints, dependencies, and potential blockers
- Understand the problem space before writing any code
- Steps: `explore`, `document_constraints`

**Phase 2: Iterate**
- Build minimal proof-of-concept code
- Try different approaches, hit walls, pivot
- Focus on answering the feasibility question, not building production code
- Steps: `prototype`, `test_approaches`

**Phase 3: Findings**
- Document what was learned
- Provide a clear feasibility verdict (feasible / not feasible / feasible with caveats)
- Recommend an approach if feasible
- Estimate effort for full implementation
- Steps: `write_findings`, `commit`

### Protocol Properties
- **Mode**: `soft` (default and only mode — no strict/porch orchestration)
- **Consultation**: Disabled by default
- **Gates**: None
- **Input**: Type `task` — task description provided via `af spawn --task "..." --protocol spike`
- **Signals**: `PHASE_COMPLETE`, `BLOCKED`

### Findings Template Structure
The findings document should include:
- **Question**: What technical question was being investigated?
- **Verdict**: Feasible / Not Feasible / Feasible with Caveats
- **Research Summary**: What was explored, what docs were read, what code was examined
- **Approaches Tried**: What was built/tested, what worked, what didn't
- **Constraints Discovered**: Technical limitations, dependencies, gotchas
- **Recommended Approach**: If feasible, how should full implementation proceed?
- **Effort Estimate**: Rough sizing for a full SPIR project (small/medium/large)
- **References**: Links to relevant docs, code, and resources

### Builder Prompt Emphasis
The builder-prompt.md should emphasize:
- **Time-boxing**: Stay focused on the question. Don't gold-plate.
- **Exploration over perfection**: Proof-of-concept code doesn't need tests or polish
- **Clear output**: The findings document is the deliverable, not the code
- **Know when to stop**: Once you can answer the feasibility question, write findings and stop

## Approval
- [ ] Technical Lead Review
- [ ] Expert AI Consultation Complete

## Notes
- The spike protocol fills the gap between EXPERIMENT (formal hypothesis testing) and ad-hoc exploration
- It's intentionally the lightest-weight protocol in the codev ecosystem
- The emphasis on time-boxing and structured output distinguishes it from "just hacking around"
