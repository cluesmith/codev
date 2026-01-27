# Plan: Protocol-Agnostic Spawn System

## Metadata
- **ID**: plan-2026-01-28-protocol-agnostic-spawn
- **Status**: draft
- **Specification**: codev/specs/0083-protocol-agnostic-spawn.md
- **Created**: 2026-01-28

## Executive Summary

Refactor `af spawn` to decouple input types from protocols by adding a `--use-protocol` flag and making protocol selection data-driven via protocol.json. This is a single-phase implementation since the scope is well-defined and contained.

## Success Metrics
- [ ] `af spawn -p 0001 --use-protocol tick` uses TICK instead of SPIDER
- [ ] `af spawn -i 42 --use-protocol spider` uses SPIDER instead of BUGFIX
- [ ] `af spawn --protocol maintain` works
- [ ] Protocol hooks (collision check, issue comment) are data-driven
- [ ] Existing commands work unchanged (backwards compatible)
- [ ] All existing tests pass

## Phases (Machine Readable)

```json
{
  "phases": [
    {"id": "phase_1", "title": "Protocol-Agnostic Spawn Refactor"}
  ]
}
```

## Phase Breakdown

### Phase 1: Protocol-Agnostic Spawn Refactor
**Dependencies**: None

#### Objectives
- Add `--use-protocol <name>` flag to `af spawn`
- Make protocol selection data-driven via protocol.json
- Add input, hooks, and defaults sections to protocol schema
- Create prompt rendering from protocol-specific templates

#### Deliverables
- [ ] Updated `packages/codev/src/agent-farm/cli.ts` with `--use-protocol` option
- [ ] Updated `packages/codev/src/agent-farm/commands/spawn.ts` with protocol-agnostic helpers
- [ ] Updated `packages/codev/src/agent-farm/types.ts` with new type definitions
- [ ] Extended `codev-skeleton/protocols/protocol-schema.json` with input/hooks/defaults
- [ ] Updated protocol.json files for spider, bugfix, tick with new sections
- [ ] Optional: Protocol-specific builder-prompt.md templates

#### Implementation Details

**1. CLI Changes (cli.ts)**
Add `--use-protocol <name>` option to spawn command:
```typescript
.option('--use-protocol <name>', 'Override default protocol')
```

**2. Type Definitions (types.ts)**
Add new types:
```typescript
export interface ProtocolInput {
  type: 'spec' | 'github-issue' | 'task' | 'protocol' | 'shell' | 'worktree';
  required: boolean;
  default_for?: string[];  // e.g., ["--issue", "-i"]
}

export interface ProtocolHooks {
  'pre-spawn'?: {
    'collision-check'?: boolean;
    'comment-on-issue'?: string;
  };
}

export interface ProtocolDefaults {
  mode?: 'strict' | 'soft';
}

export interface ProtocolDefinition {
  name: string;
  version: string;
  description: string;
  input?: ProtocolInput;
  hooks?: ProtocolHooks;
  defaults?: ProtocolDefaults;
  phases: any[];  // Existing phase structure
}
```

**3. Spawn Refactor (spawn.ts)**
Add protocol-agnostic helpers:
- `loadProtocol(config: Config, name: string): ProtocolDefinition` - Load and parse protocol.json
- `resolveProtocol(options: SpawnOptions, config: Config): string` - Determine protocol from explicit flag, defaults, or fallback
- `executeHooks(protocol: ProtocolDefinition, phase: string, context: any)` - Execute data-driven hooks
- `renderPrompt(protocol: ProtocolDefinition, context: PromptContext): string` - Render protocol-specific prompt

Refactor spawn functions to:
1. Call `resolveProtocol()` to get the protocol name
2. Load protocol definition via `loadProtocol()`
3. Execute pre-spawn hooks via `executeHooks()`
4. Generate prompt using protocol definition or template
5. Start builder with resolved protocol

**4. Schema Extension (protocol-schema.json)**
Add to definitions:
```json
{
  "input": {
    "type": "object",
    "properties": {
      "type": { "type": "string", "enum": ["spec", "github-issue", "task", "protocol", "shell", "worktree"] },
      "required": { "type": "boolean" },
      "default_for": { "type": "array", "items": { "type": "string" } }
    }
  },
  "hooks": {
    "type": "object",
    "properties": {
      "pre-spawn": {
        "type": "object",
        "properties": {
          "collision-check": { "type": "boolean" },
          "comment-on-issue": { "type": "string" }
        }
      }
    }
  }
}
```

**5. Protocol Updates**
Update bugfix/protocol.json:
```json
{
  "input": {
    "type": "github-issue",
    "required": false,
    "default_for": ["--issue", "-i"]
  },
  "hooks": {
    "pre-spawn": {
      "collision-check": true,
      "comment-on-issue": "On it! Working on a fix now."
    }
  },
  "defaults": {
    "mode": "soft"
  }
}
```

Update spider/protocol.json:
```json
{
  "input": {
    "type": "spec",
    "required": false,
    "default_for": ["--project", "-p"]
  },
  "defaults": {
    "mode": "strict"
  }
}
```

#### Acceptance Criteria
- [ ] `af spawn -p 0001` works as before (backwards compatible)
- [ ] `af spawn -i 42` works as before (backwards compatible)
- [ ] `af spawn -p 0001 --use-protocol tick` uses TICK protocol
- [ ] `af spawn -i 42 --use-protocol spider` uses SPIDER protocol
- [ ] Collision checks happen when bugfix protocol specifies them
- [ ] Issue comments happen when bugfix protocol specifies them
- [ ] No regressions in existing functionality

#### Test Plan
- **Manual Tests**:
  - Verify `af spawn -p 0001` still works
  - Verify `af spawn -i 42` still works
  - Verify `af spawn -p 0001 --use-protocol tick` uses tick
  - Verify `af spawn --protocol maintain` works
  - Verify error handling for invalid protocol names

#### Rollback Strategy
Revert the commit if issues are found. Changes are contained to a few files.

#### Risks
- **Risk**: Breaking existing spawn behavior
  - **Mitigation**: Extensive backwards compatibility testing

---

## Dependency Map
```
Phase 1 (single phase)
```

## Resource Requirements
### Development Resources
- **Engineers**: 1 Builder (AI agent)
- **Environment**: Standard development environment

## Validation Checkpoints
1. **After Phase 1**: Test all spawn modes, verify backwards compatibility

## Documentation Updates Required
- [ ] Update CLAUDE.md/AGENTS.md with new `--use-protocol` flag documentation
- [ ] Update codev/resources/commands/agent-farm.md with flag documentation

## Post-Implementation Tasks
- [ ] Manual testing of all spawn variants
- [ ] Verify existing tests pass

## Expert Review
**Date**: TBD (pending consultation)
**Model**: TBD

## Approval
- [ ] Technical Lead Review
- [ ] Expert AI Consultation Complete

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-01-28 | Initial plan | Spec approved | Builder |
