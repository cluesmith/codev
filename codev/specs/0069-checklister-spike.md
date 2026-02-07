# Specification: Checklister Agent Spike

## Metadata
- **ID**: 0069
- **Status**: conceived
- **Created**: 2026-01-16
- **Protocol**: SPIKE (time-boxed exploration)
- **Time-box**: 2-4 hours

## Executive Summary

Build a "checklister" agent that enforces SPIR protocol compliance by maintaining checklist state and blocking phase transitions until all required items are complete.

## Problem Statement

SPIR protocol compliance currently relies on AI memory - Claude is instructed to follow phases but can forget or skip steps. We need deterministic enforcement.

## Goal

Create a minimal checklister implementation that:
1. Tracks SPIR checklist items as state
2. Blocks phase transitions until prerequisites are met
3. Provides clear feedback about what's missing
4. Can be invoked as a Claude Code skill

## Detailed Design

See spike README: `codev/spikes/checklister/README.md`

### Key Components

1. **State File**: `.spir-state.json` tracking completed items
2. **Skill Definition**: `.claude/commands/checklister.md` for Claude integration
3. **Commands**:
   - `/checklister status` - Show current state
   - `/checklister complete <item>` - Mark item done
   - `/checklister gate <phase>` - Check if phase transition allowed

### SPIR Checklist Model

Based on protocol.md, track:
- Specify phase: draft, consult×2, human review, final
- Plan phase: draft, consult×2, human review, final
- IDE loop (per phase): implement, defend, evaluate, commit
- Review phase: doc, lessons, arch update

## Success Criteria

1. Checklister blocks phase transition when items incomplete
2. Checklister allows transition when all blocking items complete
3. State persists across sessions
4. Clear feedback about missing items
5. Reasonable overhead (not annoying to use)

## Test Plan

After building, test by running SPIR for a small task (tower light/dark mode) with checklister enforcement.

## References

- Spike README: `codev/spikes/checklister/README.md`
- SPIR Protocol: `codev/protocols/spir/protocol.md`
