# Review: Add Spike Protocol for Technical Feasibility Exploration

## Summary

Added a new `spike` protocol to the codev ecosystem for time-boxed technical feasibility exploration. The spike protocol fills the gap between EXPERIMENT (formal hypothesis testing) and ad-hoc exploration. It provides a lightweight, structured workflow for answering "Can we do X?" questions.

**Files created (7 total):**
- `codev-skeleton/protocols/spike/protocol.json` — Minimal protocol definition (single phase, soft mode, no gates/consultation)
- `codev-skeleton/protocols/spike/protocol.md` — Protocol documentation with recommended 3-step workflow
- `codev-skeleton/protocols/spike/builder-prompt.md` — Handlebars builder prompt template
- `codev-skeleton/protocols/spike/templates/findings.md` — Findings document template
- `codev/protocols/spike/protocol.json` — Instance copy for self-hosted use
- `codev/protocols/spike/protocol.md` — Instance copy
- `codev/protocols/spike/templates/findings.md` — Instance copy

## Spec Compliance

- [x] `protocol.json` exists and validates against protocol-schema.json
- [x] `protocol.md` documents the protocol clearly
- [x] `builder-prompt.md` provides effective builder instructions with Handlebars templating
- [x] `templates/findings.md` provides a useful findings template
- [x] Protocol can be referenced by `afx spawn --protocol spike`
- [x] Soft mode only — porch treats it as a no-orchestration protocol
- [x] No gates defined in protocol.json
- [x] Consultation disabled by default in protocol.json
- [x] protocol.json is minimal — single "spike" phase for schema compliance
- [x] Three-step guidance (research, iterate, findings) documented in protocol.md
- [x] Output is a single findings document in `codev/spikes/`

## Deviations from Plan

- **Input type**: Spec originally said `none`, changed to `task` based on schema analysis. The `task` type maps directly to `afx spawn --task "..."` usage pattern.
- **Phase structure**: Architect directed that phases be guidance-only in protocol.md, not formal porch phases in protocol.json. Plan was updated accordingly.
- **Dual-directory**: Architect identified that files needed to exist in both `codev-skeleton/` and `codev/` directories. Plan was updated to include this.
- **Schema compliance**: Codex review caught an invalid `transition.on_complete: null` in protocol.json. Fixed by removing the transition block entirely.

## Lessons Learned

### What Went Well
- The spec was comprehensive and well-structured, making implementation straightforward
- 3-way consultation caught a real schema violation (null in a string-only field) before it shipped
- Architect feedback on minimal protocol.json was timely and prevented over-engineering

### Challenges Encountered
- **Dual-directory convention not documented**: Had to discover the `codev-skeleton/` + `codev/` pattern by examining existing protocols. The architect caught the missing `codev/` files.

### What Would Be Done Differently
- Check for dual-directory conventions earlier in the plan phase
- Include schema validation as an explicit acceptance criterion from the start

## Consultation Feedback

### Specify Phase (Round 1)

#### Gemini (REQUEST_CHANGES)
- **Concern**: Prototype code lifecycle — POC code could pollute the codebase if committed alongside findings
  - **Addressed**: Added "Proof-of-Concept Code Disposition" section to spec clarifying POC stays on spike branch

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing findings filename conventions; no behavior for missing `--task` input; soft mode enforcement not specified
  - **Addressed**: Added naming convention section; resolved input type to `task`; clarified `defaults.mode: "soft"`

#### Claude (COMMENT)
- **Concern**: Input type `none` not in schema enum; `codev/spikes/` already exists in skeleton; consider `QUESTION_ANSWERED` signal
  - **Addressed**: Changed to `task` type; acknowledged existing directory; kept signal set minimal

### Plan Phase (Round 1)

#### Gemini (APPROVE)
- No concerns raised

#### Codex (REQUEST_CHANGES)
- **Concern**: Missing `description` field in protocol.json; missing manual validation steps
  - **Addressed**: Added explicit `description` field; added validation checkpoints

#### Claude (APPROVE)
- Minor observation about `$schema` field — covered by "follow experiment's structure" reference

### Implement Phase — protocol_config (Round 1)

#### Gemini (APPROVE)
- No concerns raised

#### Codex (REQUEST_CHANGES)
- **Concern**: Schema-invalid `transition.on_complete: null`; non-minimal extras (transition, checks)
  - **Addressed**: Removed transition block, empty checks, and transitions_to from signals

#### Claude (APPROVE)
- No concerns raised

### Implement Phase — protocol_docs (Round 1)

#### All models (APPROVE)
- No concerns raised — all consultations approved

## Architecture Updates

No architecture updates needed. This was a protocol definition addition (configuration + documentation) with no new subsystems, data flows, or runtime code. The spike protocol follows the same patterns established by the existing experiment protocol. A brief mention could be added to arch.md's protocol listing, but the protocol is self-documenting via its own protocol.md.

## Lessons Learned Updates

No lessons learned updates needed. This was a straightforward implementation of a well-specified feature with no novel insights beyond what's already captured. The dual-directory convention is already implicitly documented through the existing protocol structure.

## Technical Debt

None. This is a clean addition with no shortcuts taken.

## Flaky Tests

No flaky tests encountered during this project.

## Follow-up Items

- Consider adding `spike` to the Protocol Selection Guide in CLAUDE.md/AGENTS.md
- Consider mentioning spike in `codev/resources/cheatsheet.md` if it exists
- The `QUESTION_ANSWERED` signal (suggested by Claude consultation) could be added later if builders find the current workflow insufficient
