# Specification: Protocol-Agnostic Spawn System

**Spec ID**: 0083
**Title**: Protocol-Agnostic Spawn System
**Status**: Draft
**Protocol**: SPIR
**Author**: Claude (with human guidance)
**Date**: 2026-01-27

## Overview

Refactor `af spawn` to decouple input types from protocols, making the system extensible without hardcoding protocol-specific logic.

## Problem Statement

Currently, specific protocols are deeply baked into `af spawn`:
- `spawnBugfix()` hardcodes BUGFIX protocol path, collision checks, and issue commenting
- `spawnSpec()` defaults to SPIR with protocol-specific prompts
- `spawnStrict()` ignores protocol metadata in spec files
- Adding a new protocol requires modifying spawn.ts

This violates the open-closed principle and makes the system harder to extend.

## Goals

1. **Decouple input types from protocols** - Input (spec, issue, task) and protocol (spir, bugfix, tick) are orthogonal
2. **Universal `--use-protocol` flag** - Override default protocol for any input type
3. **Protocol-defined behaviors** - Hooks, defaults, and prompts defined in protocol.json
4. **Protocol prompt templates** - Each protocol can provide builder-prompt.md
5. **Backwards compatible** - Existing commands work unchanged

## Non-Goals

1. Changing the protocols themselves (just how they're selected/invoked)
2. Modifying porch internals
3. Adding new protocols (just making it easier to add them)

## Design

### Three Orthogonal Concerns

```
Input Type (what to build from)  ×  Mode (who orchestrates)  ×  Protocol (what workflow)
```

**Input Types**:
- `--project/-p`: Start from a spec file
- `--issue/-i`: Start from a GitHub issue
- `--task`: Start from ad-hoc text
- `--protocol`: Protocol-only mode (no spec/issue)
- `--worktree`: Interactive (no input)
- `--shell`: Bare Claude session

**Modes**:
- `strict`: Porch drives the protocol
- `soft`: AI reads and follows protocol.md

**Protocols**: spir, bugfix, tick, maintain, experiment, etc.

### Protocol Selection

1. Explicit `--use-protocol <name>` takes precedence
2. Protocol's `default_for` in protocol.json
3. Hardcoded defaults (spir for specs, bugfix for issues)

### Protocol Definition Extensions

```json
{
  "name": "bugfix",
  "version": "1.0.0",
  "input": {
    "type": "github-issue",
    "required": false,
    "default_for": ["--issue"]
  },
  "hooks": {
    "pre-spawn": {
      "collision-check": true,
      "comment-on-issue": "On it! Working on a fix now."
    }
  },
  "defaults": {
    "mode": "soft"
  },
  "phases": [...]
}
```

### Protocol Prompt Templates

Each protocol can provide `protocols/{name}/builder-prompt.md`:

```markdown
# {{protocol_name}} Builder ({{mode}} mode)

You are implementing {{input_description}}.

{{#if mode_soft}}
## Mode: SOFT
- Follow the protocol document yourself
- The architect monitors your work
{{/if}}

{{#if mode_strict}}
## Mode: STRICT
- Porch orchestrates your work
- Run: porch run {{project_id}}
{{/if}}

## Protocol
Follow: codev/protocols/{{protocol}}/protocol.md

{{#if spec}}
## Spec
{{spec.path}}
{{/if}}

{{#if issue}}
## Issue #{{issue.number}}
{{issue.title}}
{{/if}}
```

### Example Commands

```bash
# Standard (unchanged behavior)
af spawn -p 0001                         # strict, spir
af spawn -i 42                           # soft, bugfix

# New flexibility
af spawn -p 0001 --use-protocol tick     # strict, tick
af spawn -i 42 --use-protocol spir     # soft, spir (escalate bug)
af spawn --protocol maintain             # soft, maintain
```

## Implementation

**This is a single-phase project.** The refactoring is straightforward and can be done in one pass.

### Files to Modify

1. **packages/codev/src/agent-farm/cli.ts**
   - Add `--use-protocol <name>` flag

2. **packages/codev/src/agent-farm/commands/spawn.ts**
   - Add protocol-agnostic helper functions
   - Update spawnSpec, spawnBugfix, spawnTask, spawnProtocol, spawnStrict to use helpers
   - Add template rendering for prompts

3. **packages/codev/src/agent-farm/types.ts**
   - Add ProtocolDefinition, InputResult, PromptContext types

4. **codev-skeleton/protocols/*/protocol.json**
   - Add input, hooks, defaults sections

5. **codev-skeleton/protocols/*/builder-prompt.md** (optional)
   - Create prompt templates for protocols that want custom prompts

### Acceptance Criteria

- [ ] `af spawn -p 0001 --use-protocol tick` uses TICK instead of SPIR
- [ ] `af spawn -i 42 --use-protocol spir` uses SPIR instead of BUGFIX
- [ ] `af spawn --protocol maintain` works
- [ ] Protocol hooks (collision check, issue comment) are data-driven
- [ ] Existing commands work unchanged (backwards compatible)
- [ ] Prompt templates render correctly

## Testing

Manual testing:
```bash
# Verify backwards compatibility
af spawn -p 0001              # Should work as before
af spawn -i 42                # Should work as before

# Verify new flexibility
af spawn -p 0001 --use-protocol tick
af spawn --protocol maintain
```

## Notes

- Implementation already partially started in spawn.ts (resolveInput, resolveProtocol, etc.)
- Single phase since the refactoring is well-defined and contained
