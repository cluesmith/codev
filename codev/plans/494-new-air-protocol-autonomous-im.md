# Plan: AIR Protocol — Autonomous Implement & Review

## Metadata
- **ID**: plan-2026-02-21-air-protocol
- **Status**: draft
- **Specification**: codev/specs/494-new-air-protocol-autonomous-im.md
- **Created**: 2026-02-21

## Executive Summary

Create the AIR protocol as a minimal two-phase protocol (Implement → Review) modeled after BUGFIX but designed for small features instead of bugs. The protocol lives in `codev-skeleton/protocols/air/` and consists of a protocol.json, protocol.md, builder-prompt.md, phase prompts, and consult-types. Source code changes are limited to updating help text strings in three files. Documentation updates cover CLAUDE.md, AGENTS.md, and the cheatsheet.

## Success Metrics
- [ ] `af spawn 42 --protocol air` creates a builder that runs the AIR protocol
- [ ] Protocol validates against `protocol-schema.json`
- [ ] No spec/plan/review files created during protocol execution
- [ ] Build passes, unit tests pass
- [ ] Documentation updated (CLAUDE.md, AGENTS.md, cheatsheet)

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "protocol_definition", "title": "Create AIR protocol definition and assets"},
    {"id": "source_updates", "title": "Update source code references and documentation"}
  ]
}
```

## Phase Breakdown

### Phase 1: Create AIR protocol definition and assets
**Dependencies**: None

#### Objectives
- Create the complete AIR protocol directory in `codev-skeleton/protocols/air/`
- All files needed for porch to discover and drive the protocol

#### Deliverables
- [ ] `codev-skeleton/protocols/air/protocol.json` — Protocol definition with implement and pr phases
- [ ] `codev-skeleton/protocols/air/protocol.md` — Human-readable documentation
- [ ] `codev-skeleton/protocols/air/builder-prompt.md` — Builder startup instructions (Handlebars template)
- [ ] `codev-skeleton/protocols/air/prompts/implement.md` — Implement phase prompt
- [ ] `codev-skeleton/protocols/air/prompts/pr.md` — PR/Review phase prompt
- [ ] `codev-skeleton/protocols/air/consult-types/impl-review.md` — Implementation consultation guide
- [ ] `codev-skeleton/protocols/air/consult-types/pr-review.md` — PR consultation guide

#### Implementation Details

**protocol.json** structure:
- Two phases: `implement` (type: `once`) and `pr` (type: `once`)
- Input type: `github-issue` (same as BUGFIX)
- `implement` phase: build/test checks, `TOO_COMPLEX` signal, transitions to `pr`
- `pr` phase: PR creation, optional consultation, `pr` gate, terminal phase
- Consultation optional (available in `pr` phase but not mandatory per-phase)
- No spec/plan artifacts — no `build_verify` phases that produce codev/ files

**builder-prompt.md**: Modeled after bugfix's builder-prompt.md but adapted for features:
- Mission: implement feature, write tests, create PR with review in body
- Escalation: if > 300 LOC or architectural, escalate to ASPIR

**prompts/implement.md**: Similar to bugfix/fix.md but for features:
- Read issue requirements
- Implement the feature (not fix a bug)
- Write tests
- Build + test checks

**prompts/pr.md**: Similar to bugfix/pr.md:
- Create PR with review section in body
- Optional CMAP consultation
- Notify architect

**consult-types/**: Reuse bugfix patterns — impl-review.md and pr-review.md adapted for features

#### Acceptance Criteria
- [ ] `protocol.json` validates against `protocol-schema.json`
- [ ] All Handlebars variables render correctly
- [ ] Phase transitions work: implement → pr → complete

---

### Phase 2: Update source code references and documentation
**Dependencies**: Phase 1

#### Objectives
- Update hardcoded protocol lists in source code
- Update CLAUDE.md, AGENTS.md, and cheatsheet with AIR protocol

#### Deliverables
- [ ] `packages/codev/src/agent-farm/cli.ts` — Add 'air' to --protocol help text
- [ ] `packages/codev/src/cli.ts` — Add 'air' to --protocol help text
- [ ] `packages/codev/src/agent-farm/types.ts` — Add 'air' to comment
- [ ] `CLAUDE.md` — Add AIR to protocol selection guide
- [ ] `AGENTS.md` — Add AIR to protocol selection guide (keep in sync with CLAUDE.md)
- [ ] `codev/resources/cheatsheet.md` — Add AIR to protocols table

#### Implementation Details

**Source code** (3 one-line changes):
- `cli.ts:196`: Add `air` to protocol list string
- `cli.ts:138`: Add `air` to protocol list string
- `types.ts:70`: Add `air` to protocol comment

**No changes needed in overview.ts**: The generic worktree pattern match already handles `air-XXX-slug`, and `calculateEvenProgress` works for non-SPIR protocols via dynamic phase loading from protocol.json.

**CLAUDE.md / AGENTS.md**: Add a "Use AIR for" section between BUGFIX and TICK:
```
### Use AIR for (small features from GitHub issues):
- Small features (< 300 LOC)
- Requirements fully stated in the GitHub issue
- No architectural decisions needed
- Would be overkill for full SPIR/ASPIR
```

**Cheatsheet**: Add AIR row to protocols table.

#### Acceptance Criteria
- [ ] `npm run build` passes in packages/codev/
- [ ] All unit tests pass
- [ ] CLAUDE.md and AGENTS.md are in sync
- [ ] `af spawn --protocol air` shows in help text

## Dependency Map
```
Phase 1 (protocol definition) ──→ Phase 2 (source + docs)
```

## Risks and Mitigation
| Risk | Probability | Impact | Mitigation Strategy |
|------|------------|--------|-------------------|
| Protocol schema doesn't support all needed features | Low | Medium | Already verified: `once` type and `github-issue` input work in BUGFIX |
| Porch can't drive the protocol | Low | Medium | BUGFIX proves the pattern works; AIR is structurally identical |

## Notes

The implementation is intentionally minimal. AIR's value is in being lighter than ASPIR — fewer phases, no artifacts. The protocol definition files are small and straightforward, modeled directly on the proven BUGFIX pattern.
