# Specification: ASPIR Protocol — Autonomous SPIR

## Metadata
- **ID**: spec-438-aspir-protocol
- **Status**: draft
- **Created**: 2026-02-18

## Clarifying Questions Asked

The architect provided clear direction in the issue and spawn message:

1. **Q: What exactly should differ from SPIR?** A: Only the `spec-approval` and `plan-approval` gates are removed (auto-approved). Everything else — phases, consultations, checks, PR flow — remains identical.
2. **Q: Should the PR gate also be removed?** A: No. The PR gate stays. Only spec-approval and plan-approval are removed.
3. **Q: Is this a new protocol directory or a configuration flag on SPIR?** A: New protocol directory. ASPIR is a standalone protocol that copies the full SPIR structure.

## Problem Statement

SPIR has two human approval gates — `spec-approval` (after the Specify phase) and `plan-approval` (after the Plan phase). These gates require a human to explicitly run `porch approve` before the builder can proceed to the next phase.

For trusted or low-risk work, these gates add latency without proportional value. The builder must stop, notify the architect, and wait — sometimes for hours — before resuming. This is especially costly for:

- Well-understood features with clear specs pre-written by the architect
- Internal tooling improvements with low blast radius
- Protocol/template additions where the scope is self-contained
- Work where the architect trusts the builder to proceed autonomously

There is no way to run SPIR without these gates today. Builders must either use SPIR with mandatory gates or use a different protocol (TICK, BUGFIX) that lacks SPIR's full discipline (consultations, phased implementation, review).

## Current State

- **SPIR** provides full discipline (Specify → Plan → Implement → Review) with 3-way consultations at every phase, but requires human approval at two gates before the builder can proceed
- **TICK** is lightweight (amend existing specs) but cannot be used for greenfield work
- **BUGFIX** is minimal (investigate → fix → PR) with no consultations
- **EXPERIMENT** is for research spikes, not feature implementation
- **MAINTAIN** is for codebase hygiene and documentation sync
- **RELEASE** manages the release process
- There is no protocol that combines SPIR's full discipline with autonomous execution

## Desired State

A new protocol called **ASPIR** (Autonomous SPIR) that:

1. Follows the exact same phases as SPIR: Specify → Plan → Implement → Review
2. Runs the same 3-way consultations (Gemini, Codex, Claude) at every phase
3. Enforces the same checks (build, tests, PR exists, review sections)
4. Uses the same prompts, templates, and consult-types
5. **Removes** the `spec-approval` and `plan-approval` gates, allowing the builder to proceed automatically after the verify step
6. **Keeps** the `pr` gate — the PR still requires human review before merge
7. Is invocable via `af spawn N --protocol aspir`

## Stakeholders
- **Primary Users**: Architects spawning builders for trusted work
- **Secondary Users**: Builders executing the protocol
- **Technical Team**: Codev maintainers (this project)

## Success Criteria

### Protocol Definition
- [ ] ASPIR protocol directory exists at `codev-skeleton/protocols/aspir/` (template for other projects)
- [ ] ASPIR protocol directory exists at `codev/protocols/aspir/` (our instance)
- [ ] `protocol.json` has `"name": "aspir"`, no `alias`, `"version": "1.0.0"`
- [ ] `protocol.json` has no `gate` property on the `specify` phase
- [ ] `protocol.json` has no `gate` property on the `plan` phase
- [ ] `protocol.json` retains `"gate": "pr"` on the `review` phase
- [ ] All phases, checks, and verify blocks are identical to SPIR (except gate removal)

### Runtime Behavior
- [ ] `af spawn N --protocol aspir` spawns a builder that follows the ASPIR protocol
- [ ] Builder proceeds from Specify → Plan without stopping at a `spec-approval` gate
- [ ] Builder proceeds from Plan → Implement without stopping at a `plan-approval` gate
- [ ] Builder still stops at the `pr` gate after the Review phase
- [ ] All 3-way consultations run: spec verification (specify phase), plan verification (plan phase), impl verification (implement phase), pr verification (review phase)
- [ ] All checks still run (build, tests, PR exists, review sections)

### Documentation
- [ ] `protocol.md` in ASPIR directory documents the protocol and when to use it
- [ ] ASPIR added to "Protocol Selection Guide" section in `CLAUDE.md` (root) and `AGENTS.md` (root)
- [ ] ASPIR added to "Available Protocols" section in `codev-skeleton/templates/CLAUDE.md` and `codev-skeleton/templates/AGENTS.md`

### Guardrails
- [ ] No changes to SPIR protocol files (ASPIR is additive only)
- [ ] No changes to porch source code (protocol definition drives behavior)
- [ ] No changes to `protocol-schema.json`

## Constraints

### Technical Constraints
- Porch discovers protocols by filesystem: `codev/protocols/{name}/protocol.json` — no code changes needed
- The `gate` property on a phase is what creates a human approval gate. Removing the property means the phase auto-transitions to the next phase after verification
- Both `codev-skeleton/protocols/` (template for other projects) and `codev/protocols/` (our instance) must be updated
- ASPIR must use the same `protocol-schema.json` as SPIR (no schema changes)

### Design Constraints
- ASPIR must be a complete copy, not a "mode" or flag on SPIR. This keeps protocols self-contained and avoids conditional logic in protocol definitions
- Prompt files, consult-type files, and template files should be identical to SPIR's. They can either be copied or symlinked (copy is simpler and avoids cross-platform symlink issues)
- The `pr` gate must be preserved — autonomous spec/plan does not mean autonomous merge

## Assumptions
- Porch correctly auto-transitions phases when no `gate` property is present. Evidence: the `implement` phase in SPIR has no `gate` and uses `transition.on_all_phases_complete` to move to `review`. Source: `getPhaseGate()` in `packages/codev/src/commands/porch/state.ts` returns `null` for phases without a `gate` property, and `next.ts` auto-advances when gate is null.
- The `consult` CLI and consultation models remain available
- The protocol directory structure and discovery mechanism remain unchanged

## Solution Approaches

### Approach 1: Full Copy with Gate Removal (Recommended)
**Description**: Copy each SPIR directory to its respective ASPIR location, then modify `protocol.json` and `protocol.md`. Each SPIR location is copied from its own source — they have different structures.

**Files to create in `codev-skeleton/protocols/aspir/`** (copied from `codev-skeleton/protocols/spir/`, 15 files):
- `protocol.json` — **modified**: remove gates, update name/version/description
- `protocol.md` — **modified**: ASPIR-specific documentation
- `builder-prompt.md` — copied as-is
- `prompts/specify.md` — copied as-is
- `prompts/plan.md` — copied as-is
- `prompts/implement.md` — copied as-is
- `prompts/review.md` — copied as-is
- `consult-types/spec-review.md` — copied as-is
- `consult-types/plan-review.md` — copied as-is
- `consult-types/impl-review.md` — copied as-is
- `consult-types/phase-review.md` — copied as-is
- `consult-types/pr-review.md` — copied as-is
- `templates/spec.md` — copied as-is
- `templates/plan.md` — copied as-is
- `templates/review.md` — copied as-is

**Files to create in `codev/protocols/aspir/`** (copied from `codev/protocols/spir/`, 10 files):
- `protocol.json` — **modified**: remove gates, update name/version/description (note: this copy has codev-specific check commands that differ from skeleton)
- `protocol.md` — **modified**: ASPIR-specific documentation
- `consult-types/spec-review.md` — copied as-is
- `consult-types/plan-review.md` — copied as-is
- `consult-types/impl-review.md` — copied as-is
- `consult-types/phase-review.md` — copied as-is
- `consult-types/pr-review.md` — copied as-is
- `templates/spec.md` — copied as-is
- `templates/plan.md` — copied as-is
- `templates/review.md` — copied as-is

Note: `codev/protocols/spir/` does not have `builder-prompt.md` or `prompts/` — those only exist in the skeleton.

**`protocol.json` modifications** (both copies):
- `"name"`: `"spir"` → `"aspir"`
- `"alias"`: remove entirely (ASPIR needs no alias)
- `"version"`: `"2.2.0"` → `"1.0.0"`
- `"description"`: update to reference ASPIR
- `specify` phase: remove `"gate": "spec-approval"` property
- `plan` phase: remove `"gate": "plan-approval"` property
- `review` phase: keep `"gate": "pr"` unchanged
- All other fields: unchanged

**Pros**:
- Self-contained — no dependencies between protocol directories
- Easy to understand — each protocol is a complete unit
- Can evolve independently if ASPIR needs future customization
- Follows the pattern of existing protocols (TICK, BUGFIX, etc.)

**Cons**:
- File duplication between SPIR and ASPIR
- Changes to SPIR prompts/templates must be manually propagated to ASPIR

**Estimated Complexity**: Low
**Risk Level**: Low

### Approach 2: Symlinks to SPIR Files
**Description**: Create the `aspir/` directory with its own `protocol.json` and `protocol.md`, but symlink `prompts/`, `templates/`, and `consult-types/` to SPIR's copies.

**Pros**:
- No file duplication
- Changes to SPIR prompts auto-propagate

**Cons**:
- Symlinks can break on Windows or in git operations
- Less transparent — "where does this file come from?"
- Harder to evolve independently
- No existing protocol uses symlinks (breaks convention)

**Estimated Complexity**: Low
**Risk Level**: Medium (cross-platform concerns)

### Approach 3: Protocol Inheritance / `extends` Field
**Description**: Add an `extends` field to `protocol-schema.json` that lets ASPIR say `"extends": "spir"` and only override the gate fields.

**Pros**:
- Minimal duplication
- Elegant conceptually

**Cons**:
- Requires porch source code changes to support inheritance
- Adds complexity to protocol loading
- Over-engineered for a single use case
- Violates the "no code changes" constraint

**Estimated Complexity**: High
**Risk Level**: High (porch changes, schema changes)

**Recommended**: Approach 1 (Full Copy). The duplication is manageable (the files are small) and avoids all risk.

## Open Questions

### Critical (Blocks Progress)
- None. The architect's direction is clear.

### Important (Affects Design)
- [x] Should ASPIR have a different `alias` field? → No alias needed; `aspir` is already short
- [x] Should the `version` start at `1.0.0` or match SPIR's `2.2.0`? → `1.0.0` (new protocol, own versioning)

### Nice-to-Know (Optimization)
- [ ] Should we add a `MAINTAIN` task to keep ASPIR prompts in sync with SPIR? → Out of scope for this spec; can be addressed later
<!-- REVIEW(@architect): No -->

## Performance Requirements
- Not applicable. This is a protocol definition, not runtime code.

## Security Considerations
- ASPIR removes human gates, so it should only be used for trusted work. This is a usage guideline, not a technical enforcement — the architect decides which protocol to use when spawning.
- The `pr` gate remains, ensuring a human reviews all code before merge.

## Test Scenarios

### Functional Tests
1. **Happy path**: `af spawn N --protocol aspir` succeeds and builder runs through Specify → Plan → Implement → Review without stopping at spec-approval or plan-approval gates
2. **PR gate preserved**: Builder stops at the `pr` gate after Review phase and waits for human approval
3. **Consultations run**: All 3-way consultations execute — one per phase: spec verification (specify), plan verification (plan), impl verification (implement), pr verification (review)
4. **Checks enforced**: Build checks, test checks, and PR existence checks all run
5. **Protocol discovery**: `porch status` shows "aspir" as the protocol name

### Non-Functional Tests
1. **No SPIR regression**: SPIR protocol continues to work with all gates intact
2. **Schema validation**: ASPIR `protocol.json` passes validation against `protocol-schema.json`

## Dependencies
- **SPIR protocol**: Source material for ASPIR (copy, not modify)
- **Porch**: Must already support gateless phase transitions (it does — `implement` has no gate)
- **Protocol schema**: Must support omitted `gate` field (it does — `gate` is optional in schema)

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| ASPIR prompts/templates drift from SPIR over time | Medium | Low | Document in review; consider MAINTAIN task |
| codev-specific protocol.json checks drift from SPIR (test exclusions, cwd paths) | Medium | Low | These change with test infrastructure; document drift risk in review |
| Architect uses ASPIR for high-risk work inappropriately | Low | Medium | Document usage guidelines clearly in protocol.md |
| Porch has undocumented behavior requiring gates | Low | High | Test thoroughly; the `implement` phase already has no gate |

## Expert Consultation

**Date**: 2026-02-19
**Models Consulted**: Codex (GPT-5.2), Claude
**Verdicts**: Codex: REQUEST_CHANGES (MEDIUM confidence), Claude: APPROVE (HIGH confidence)

**Changes incorporated from consultation feedback**:
- Added complete file checklist for both `codev-skeleton/` and `codev/` directories with explicit per-file copy/modify annotations (Codex, Claude)
- Made protocol.json field changes (name, alias, version, description) formal requirements in Success Criteria instead of just open questions (Claude)
- Added MAINTAIN and RELEASE to Current State protocol inventory for completeness (Claude)
- Cited source evidence for gateless auto-transition assumption (`getPhaseGate()` in state.ts, `next.ts` auto-advance) (Codex)
- Clarified consultation phase names to match SPIR's actual verify types: spec, plan, impl, pr (Codex)
- Added codev-specific protocol.json drift risk to Risks table (Claude)
- Split Success Criteria into Protocol Definition / Runtime Behavior / Documentation / Guardrails sections (Codex)

## Notes

- ASPIR is intentionally a "dumb copy" with minimal changes. The value is in providing the right default (no gates) for trusted work, not in adding new capabilities.
- The name "ASPIR" follows the convention of prefixing with "A" for "Autonomous" — it's memorable and clearly signals the difference from SPIR.
- Future work could add a `--autonomous` flag to `af spawn` that selects ASPIR automatically, but that is out of scope for this spec.
