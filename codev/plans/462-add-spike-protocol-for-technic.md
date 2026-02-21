# Plan: Add Spike Protocol for Technical Feasibility Exploration

## Metadata
- **ID**: plan-2026-02-21-spike-protocol
- **Status**: draft
- **Specification**: codev/specs/462-add-spike-protocol-for-technic.md
- **Created**: 2026-02-21

## Executive Summary

Implement the spike protocol as the lightest-weight protocol in the codev ecosystem. The implementation creates 4 files in `codev-skeleton/protocols/spike/`: a minimal protocol.json (single phase, no gates, no consultation), a protocol.md documenting the recommended 3-step workflow, a builder-prompt.md with Handlebars templating, and a findings template. No runtime code changes needed — this is purely configuration and documentation.

## Success Metrics
- [ ] All specification success criteria met
- [ ] protocol.json validates against protocol-schema.json
- [ ] protocol.md clearly documents the recommended workflow
- [ ] builder-prompt.md uses Handlebars templating consistent with other protocols
- [ ] findings template covers all sections from the spec
- [ ] Directory structure matches existing protocol conventions

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "protocol_config", "title": "Protocol Configuration"},
    {"id": "protocol_docs", "title": "Protocol Documentation and Templates"}
  ]
}
```

## Phase Breakdown

### Phase 1: Protocol Configuration
**Dependencies**: None

#### Objectives
- Create the spike protocol directory structure
- Define the minimal protocol.json

#### Deliverables
- [ ] `codev-skeleton/protocols/spike/protocol.json`
- [ ] `codev-skeleton/protocols/spike/templates/` directory

#### Implementation Details

Create `codev-skeleton/protocols/spike/protocol.json` with:
- `$schema`: `../../protocol-schema.json` (consistent with all existing protocols)
- `name`: `spike`
- `version`: `1.0.0`
- `description`: `Time-boxed technical feasibility exploration`
- Single phase `"spike"` (type: `once`, description: `Execute the spike`) for schema compliance
- `input`: type `task` with `required: false`
- `defaults`: `mode: "soft"`, `consultation: { enabled: false, models: [], parallel: false }`
- No gates, no hooks, no transitions, no checks
- `signals`: `PHASE_COMPLETE`, `BLOCKED` (convention, consistent with experiment protocol)

Reference: Follow the same structure as `codev-skeleton/protocols/experiment/protocol.json` but simpler.

#### Files
- Create: `codev-skeleton/protocols/spike/protocol.json`

#### Acceptance Criteria
- [ ] protocol.json validates against protocol-schema.json (check with JSON schema validator or manual inspection)
- [ ] Has exactly one phase with id "spike"
- [ ] No gates defined
- [ ] `defaults.mode` is "soft"
- [ ] `defaults.consultation.enabled` is false
- [ ] `input.type` is "task"

---

### Phase 2: Protocol Documentation and Templates
**Dependencies**: Phase 1

#### Objectives
- Create the protocol documentation (protocol.md)
- Create the builder prompt (builder-prompt.md)
- Create the findings template (templates/findings.md)

#### Deliverables
- [ ] `codev-skeleton/protocols/spike/protocol.md`
- [ ] `codev-skeleton/protocols/spike/builder-prompt.md`
- [ ] `codev-skeleton/protocols/spike/templates/findings.md`

#### Implementation Details

**protocol.md**: Document the spike protocol including:
- Overview and when to use
- Comparison with EXPERIMENT (lighter, no hypothesis)
- Recommended 3-step workflow: Research → Iterate → Findings (guidance only, not enforced)
- Output: findings document in `codev/spikes/<id>-<name>.md`
- POC code disposition (committed to branch as evidence, not merged)
- Outcome handling (feasible / not feasible / caveats)
- Git workflow and commit conventions

Reference: Follow the structure of `codev-skeleton/protocols/experiment/protocol.md`.

**builder-prompt.md**: Create using Handlebars templating:
- `{{protocol_name}}` — "spike"
- `{{#if mode_soft}}` block (spike is always soft mode)
- `{{#if task}}` / `{{task_text}}` — the spike question
- Emphasis on time-boxing, exploration over perfection, clear output, knowing when to stop
- Instructions for creating and committing the findings document
- Instructions to notify architect when complete

Reference: Follow the structure of `codev-skeleton/protocols/experiment/builder-prompt.md`.

**templates/findings.md**: Create findings template with sections:
- Question (what technical question was investigated?)
- Verdict (Feasible / Not Feasible / Feasible with Caveats)
- Research Summary
- Approaches Tried
- Constraints Discovered
- Recommended Approach (if feasible)
- Effort Estimate (small/medium/large for full SPIR project)
- Next Steps (explicit bridge to SPIR or "do not pursue")
- References

Reference: Follow the style of `codev-skeleton/protocols/experiment/templates/notes.md`.

#### Files
- Create: `codev-skeleton/protocols/spike/protocol.md`
- Create: `codev-skeleton/protocols/spike/builder-prompt.md`
- Create: `codev-skeleton/protocols/spike/templates/findings.md`

#### Acceptance Criteria
- [ ] protocol.md clearly describes the recommended 3-step workflow as guidance
- [ ] protocol.md explicitly states phases are not enforced by porch
- [ ] builder-prompt.md uses Handlebars templating (`{{protocol_name}}`, `{{#if mode_soft}}`, `{{task_text}}`)
- [ ] builder-prompt.md emphasizes time-boxing and knowing when to stop
- [ ] findings template includes all sections from spec (Question, Verdict, Research Summary, Approaches Tried, Constraints, Recommended Approach, Effort Estimate, Next Steps, References)

## Dependency Map
```
Phase 1 (Protocol Config) ──→ Phase 2 (Docs & Templates)
```

## Risk Analysis

### Technical Risks
| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| protocol.json doesn't validate against schema | Low | Medium | Cross-reference experiment protocol which uses similar patterns |
| Builder prompt template variables don't render | Low | Low | Use same variables as experiment builder-prompt.md |

## Validation Checkpoints
1. **After Phase 1**: Manually verify protocol.json includes all required schema fields (`name`, `version`, `description`, `phases`). Cross-check against experiment protocol.json for structural consistency.
2. **After Phase 2**: Verify all template sections match the spec. Confirm Handlebars variables are consistent with experiment builder-prompt.md.

## Notes
- This is a documentation-only change — no TypeScript, no runtime code, no automated tests to write
- All files follow existing conventions from the experiment and bugfix protocols
- The `codev-skeleton/spikes/` directory already exists with `.gitkeep` — no init/adopt changes needed
