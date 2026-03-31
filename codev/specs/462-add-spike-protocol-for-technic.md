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
- Can be spawned with `afx spawn --task "Can we do X?" --protocol spike`
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
- [ ] Protocol can be referenced by `afx spawn --protocol spike`
- [ ] Soft mode only — porch treats it as a no-orchestration protocol
- [ ] No gates defined in protocol.json
- [ ] Consultation disabled by default in protocol.json
- [ ] protocol.json is minimal — single "spike" phase (schema requires ≥1), no orchestration
- [ ] Three-step guidance (research, iterate, findings) documented in protocol.md and builder-prompt.md as recommended workflow, not porch-enforced phases
- [ ] Output is a single findings document

## Constraints

### Technical Constraints
- Must conform to `codev-skeleton/protocols/protocol-schema.json`
- Must work with the existing `afx spawn` and porch infrastructure
- Soft mode only — porch should not attempt to orchestrate spike projects
- Must use existing protocol directory conventions

### Business Constraints
- Should be simple enough that builders can follow without extensive guidance
- Must not add complexity to existing protocols

## Assumptions
- The protocol-schema.json supports a protocol with no gates (confirmed: bugfix has no gates; experiment has one informational gate but no approval gates)
- `afx spawn --protocol spike` will work once the protocol directory exists in codev-skeleton
- Soft mode builders can follow protocol.md directly without porch orchestration
- The `input` field supports type `task` (established by convention across existing protocols and defined in protocol-schema.json's `protocolInput` definition) with `required: false`

## Solution Approaches

### Approach 1: Three-Phase Linear Protocol (Recommended)
**Description**: Define spike with a minimal protocol.json (single "spike" phase for schema compliance) and a 3-step recommended workflow (research → iterate → findings) documented in protocol.md as guidance. No gates, no consultation, no porch orchestration. Input type is `task` (task description comes from `afx spawn --task "..." --protocol spike`). Output goes to `codev/spikes/` directory. The builder follows the guidance phases at their discretion — they can skip iterate if the answer is clear from research alone.

**Pros**:
- Matches the issue description exactly (Research, Iterate, Findings)
- Simple linear flow — no branching or complex transitions
- Dedicated output directory keeps spikes separate from reviews
- Clean semantic separation: reviews are retrospective, spikes are prospective

**Cons**:
- Adds a new `codev/spikes/` directory convention (note: `codev-skeleton/spikes/` already exists with `.gitkeep`, so projects using `codev init`/`codev adopt` will already have it)
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
- [x] Should `codev init` / `codev adopt` create the `codev/spikes/` directory? Or create it on first spike? — Already handled. `codev-skeleton/spikes/` already exists with a `.gitkeep`, so projects using `codev init`/`codev adopt` will already have the directory. No additional work needed.
- [x] What input type to use in protocol.json? — Use `task` (not `none`). The `task` type is in the protocol schema enum and matches the spawn pattern `afx spawn --task "Can we do X?" --protocol spike`. Unlike experiments, spikes are specifically driven by a task/question.

### Nice-to-Know (Optimization)
- [x] Should the findings template include a "Recommended Next Steps" section linking to SPIR? — Yes. The primary output of a spike is a feasibility verdict that informs whether to start a SPIR project. A "Next Steps" section explicitly bridges spike → SPIR.

## Performance Requirements
- N/A — this is a protocol definition, not runtime code

## Security Considerations
- N/A — no authentication, authorization, or data handling changes

## Test Scenarios

### Functional Tests
1. protocol.json validates against protocol-schema.json
2. `afx spawn --task "test spike" --protocol spike` creates a working builder (manual verification)
3. Builder in soft mode can follow the protocol and produce a findings document

### Non-Functional Tests
1. Protocol documentation is clear enough for a builder to follow without ambiguity

## Dependencies
- **Internal Systems**: Protocol schema (`protocol-schema.json`), afx spawn infrastructure, porch (must not break)
- **Libraries/Frameworks**: None — this is documentation and JSON configuration

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Schema doesn't support spike's needs | Low | Medium | Validated that experiment uses similar patterns |
| Porch tries to orchestrate spike | Low | Medium | Set mode to soft-only, test that porch handles gracefully |
| New `codev/spikes/` directory confuses users | Low | Low | Document clearly in protocol.md |

## Protocol Design Details

### protocol.json Structure

The protocol.json is intentionally minimal. Since the protocol schema requires at least one phase (`minItems: 1`), we define a single "spike" phase. This phase is NOT orchestrated by porch — it exists purely for schema compliance.

```json
{
  "name": "spike",
  "version": "1.0.0",
  "description": "Time-boxed technical feasibility exploration",
  "input": { "type": "task", "required": false },
  "phases": [
    {
      "id": "spike",
      "name": "Spike",
      "type": "once",
      "description": "Execute the spike — research, iterate, write findings"
    }
  ],
  "defaults": {
    "mode": "soft",
    "consultation": { "enabled": false }
  }
}
```

No gates, no consultation config, no transitions, no hooks. The simplest valid protocol.

### Recommended Workflow (Guidance Only)

The following 3-step workflow is documented in protocol.md and builder-prompt.md as **recommended guidance**. It is NOT enforced by porch. The builder can follow it, skip steps, or reorder as they see fit.

**Step 1: Research**
- Read documentation, examine existing code, search for prior art
- Identify constraints, dependencies, and potential blockers
- Understand the problem space before writing any code

**Step 2: Iterate**
- Build minimal proof-of-concept code
- Try different approaches, hit walls, pivot
- Focus on answering the feasibility question, not building production code
- **Can be skipped** if the answer is clear from research alone

**Step 3: Findings**
- Document what was learned in `codev/spikes/<id>-<name>.md`
- Provide a clear feasibility verdict (feasible / not feasible / feasible with caveats)
- Recommend an approach if feasible
- Estimate effort for full implementation
- Commit and notify architect

### Protocol Properties
- **Mode**: `soft` (default and only mode — no strict/porch orchestration)
- **Consultation**: Disabled by default
- **Gates**: None
- **Input**: Type `task` — task description provided via `afx spawn --task "..." --protocol spike`
- **Hooks**: None
- **Signals**: `PHASE_COMPLETE`, `BLOCKED` (for convention, though not porch-tracked)

### Findings Document Naming Convention
Findings are stored in `codev/spikes/` using the pattern: `<id>-<descriptive-name>.md`

Examples:
- `codev/spikes/462-spike-websocket-feasibility.md`
- `codev/spikes/475-spike-sqlite-fts-performance.md`

The `<id>` is the GitHub issue number or project ID. The builder creates the `codev/spikes/` directory if it doesn't exist (`mkdir -p codev/spikes/`).

### Findings Template Structure
The findings document should include:
- **Question**: What technical question was being investigated?
- **Verdict**: Feasible / Not Feasible / Feasible with Caveats
- **Research Summary**: What was explored, what docs were read, what code was examined
- **Approaches Tried**: What was built/tested, what worked, what didn't
- **Constraints Discovered**: Technical limitations, dependencies, gotchas
- **Recommended Approach**: If feasible, how should full implementation proceed?
- **Effort Estimate**: Rough sizing for a full SPIR project (small/medium/large)
- **Next Steps**: Explicit recommendation — e.g., "Create SPIR spec for X" or "Do not pursue — blocked by Y"
- **References**: Links to relevant docs, code, and resources

### Proof-of-Concept Code Disposition
POC code from the iterate phase should be committed to the branch alongside the findings document. It serves as evidence supporting the findings. However:
- POC code does NOT need tests, polish, or production quality
- POC code does NOT get merged to main — it stays on the spike branch
- The findings document is the primary deliverable; the code is supporting evidence
- If the spike leads to a SPIR project, the builder starts fresh (POC informs design but isn't reused directly)

### Outcome Handling
- **Feasible**: Write findings with recommended approach and effort estimate. Architect decides whether to create a SPIR project.
- **Not Feasible**: Write findings documenting why it's not feasible, what was tried, and what alternatives exist. This is still a valuable output — it prevents future teams from wasting time on the same investigation.
- **Feasible with Caveats**: Write findings with conditions, risks, and trade-offs. Include what would need to change for full feasibility.

In all cases, the builder commits the findings document and notifies the architect via `afx send architect "Spike 462 complete. Verdict: [feasible/not feasible/caveats]"`.

### Builder Prompt Conventions
The builder-prompt.md uses Handlebars templating (consistent with all other protocols):
- `{{protocol_name}}` — protocol identifier
- `{{#if mode_soft}}` / `{{#if mode_strict}}` — mode conditionals
- `{{task_text}}` — the task description from `afx spawn --task "..."`
- `{{spec_path}}`, `{{plan_path}}` — artifact paths (not used for spike since no spec/plan)

### Builder Prompt Emphasis
The builder-prompt.md should emphasize:
- **Time-boxing**: Stay focused on the question. Don't gold-plate.
- **Exploration over perfection**: Proof-of-concept code doesn't need tests or polish
- **Clear output**: The findings document is the deliverable, not the code
- **Know when to stop**: Once you can answer the feasibility question, write findings and stop

## Expert Consultation

**Date**: 2026-02-21
**Models Consulted**: Gemini, Claude (Codex did not produce output)

### Gemini Feedback (REQUEST_CHANGES)
1. **Directory scaffolding**: Resolved — create on first use, not via init/adopt
2. **Input type**: Resolved — use `task` type per schema enum
3. **Success criteria incomplete**: Added that builder-prompt must use Handlebars templating

### Claude Feedback (COMMENT)
1. **Incorrect gate claim**: Fixed — experiment DOES have a gate (`experiment-complete`). Corrected to cite only bugfix as gate-free.
2. **Input type `none` contradiction**: Resolved — changed to `task` which is in schema enum
3. **Findings naming convention**: Added — `<id>-spike-<name>.md` pattern
4. **Handlebars templating convention**: Added — documented template variables
5. **POC code disposition**: Added — committed to branch as evidence, not merged to main

### Architect Feedback
1. **Phases are guidance only**: The 3 phases (research, iterate, findings) are recommended in protocol.md as guidance, not formal porch phases in protocol.json. protocol.json should be minimal — single "spike" phase for schema compliance, no orchestration. Builder can follow or skip steps as needed.
2. **Resolution**: Restructured protocol design to use minimal protocol.json with single phase + guidance-only workflow in protocol.md/builder-prompt.md.

## Approval
- [x] Technical Lead Review (architect feedback incorporated)
- [x] Expert AI Consultation Complete

## Notes
- The spike protocol fills the gap between EXPERIMENT (formal hypothesis testing) and ad-hoc exploration
- It's intentionally the lightest-weight protocol in the codev ecosystem
- The emphasis on time-boxing and structured output distinguishes it from "just hacking around"
