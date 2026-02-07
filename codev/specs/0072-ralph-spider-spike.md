# Spike Specification: Ralph-SPIR Integration

## Metadata
- **ID**: 0072
- **Status**: conceived
- **Created**: 2026-01-19
- **Protocol**: SPIKE
- **Time-box**: 4-6 hours

## Goal

Validate that SPIR can be reimagined using Ralph principles where:
1. Builder owns the entire lifecycle (S→P→I→D→E→R)
2. Human approval gates act as backpressure points
3. Fresh context per iteration (Ralph tenet #1)
4. State lives in files, not AI memory

## Spike Context

See `codev/spikes/ralph-spider/README.md` for full context, including:
- Background on current vs proposed model
- Key questions to answer
- Proposed implementation phases
- Mappings to Ralph Orchestrator concepts

## Deliverables

1. **Working loop orchestrator** - Shell script or TypeScript that:
   - Reads state from status file
   - Invokes Claude with phase-specific prompts
   - Handles human approval gates (polling)
   - Transitions through all SPIR phases

2. **Phase prompts** - Hat-specific prompts for:
   - Specify (Spec Writer)
   - Plan (Planner)
   - Implement (Implementer)
   - Defend (Tester)
   - Evaluate (Verifier)
   - Review (Reviewer)

3. **Integration test** - Run the full loop on a test project:
   - Create project entry
   - Run loop through specify → plan (with manual approvals)
   - Document friction points

## Success Criteria

1. **PASS**: Loop correctly transitions through all SPIR phases
2. **PASS**: Human approval gates block until approved
3. **PASS**: Test failures in Defend phase trigger retry
4. **PASS**: State persists across Claude restarts
5. **PASS**: Documented learnings for production implementation

## Out of Scope

- CODEV_HQ integration (use local file-based approvals)
- Multi-phase implementation plans (single phase sufficient for spike)
- Production-ready error handling
- Full consultation (Gemini/Codex) integration

## References

- [Spike README](../spikes/ralph-spider/README.md)
- [Checklister Spike](../spikes/checklister/README.md) - State file patterns
- [CODEV_HQ Spike](../spikes/codev-hq/README.md) - Approval flow
- [Ralph Research](../../codev2/synthesis.md) - 3-way analysis
