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
- [ ] `af spawn --protocol maintain` works unchanged (this is the existing protocol-only mode)
- [ ] Protocol hooks (collision check, issue comment) are data-driven
- [ ] Existing commands work unchanged (backwards compatible)
- [ ] All existing tests pass
- [ ] New unit tests for `resolveProtocol()` and `loadProtocol()`

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
- [ ] Unit tests for `resolveProtocol()` and `loadProtocol()`
- [ ] Optional: Protocol-specific builder-prompt.md templates

#### Implementation Details

**1. CLI Changes (cli.ts)**
Add `--use-protocol <name>` option to spawn command:
```typescript
.option('--use-protocol <name>', 'Override default protocol')
```

**Clarification: `--protocol` vs `--use-protocol`**:
- `--protocol <name>` is an **input type** - spawns a builder in "protocol-only mode" with no spec/issue
- `--use-protocol <name>` is a **modifier** - overrides which protocol to use for any input type

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

**Protocol Resolution Precedence (`resolveProtocol()`)**:
Resolution follows this order (first match wins):
1. **Explicit `--use-protocol` flag** - Always takes precedence
2. **Spec file header** - For `--project` mode, parse `**Protocol**: <name>` from spec (existing behavior preserved)
3. **Protocol `default_for`** - If protocol.json has `default_for: ["--issue"]`, use that protocol for `--issue` flag
4. **Hardcoded fallbacks** - spider for `--project`, bugfix for `--issue`, etc.

```typescript
async function resolveProtocol(options: SpawnOptions, config: Config): Promise<string> {
  // 1. Explicit override always wins
  if (options.useProtocol) {
    validateProtocol(config, options.useProtocol);
    return options.useProtocol;
  }

  // 2. For spec mode, check spec file header (preserves existing behavior)
  if (options.project) {
    const specFile = await findSpecFile(config.codevDir, options.project);
    if (specFile) {
      const specContent = readFileSync(specFile, 'utf-8');
      const match = specContent.match(/\*\*Protocol\*\*:\s*(\w+)/i);
      if (match) return match[1].toLowerCase();
    }
  }

  // 3. Check protocol.json default_for (future: iterate protocols)
  // For now, use hardcoded defaults

  // 4. Hardcoded fallbacks
  if (options.project) return 'spider';
  if (options.issue) return 'bugfix';
  if (options.protocol) return options.protocol;  // protocol-only mode uses the specified protocol
  if (options.task) return 'spider';  // task defaults to spider

  return 'spider';  // final fallback
}
```

**Hook Execution (`executePreSpawnHooks()`)**:
Hooks reuse existing logic but are triggered by protocol.json configuration:

```typescript
async function executePreSpawnHooks(
  protocol: ProtocolDefinition,
  context: { issueNumber?: number; issue?: GitHubIssue; worktreePath?: string; force?: boolean; noComment?: boolean }
): Promise<void> {
  const hooks = protocol.hooks?.['pre-spawn'];
  if (!hooks) return;

  // collision-check: reuses existing checkBugfixCollisions() logic
  if (hooks['collision-check'] && context.issueNumber && context.issue) {
    await checkBugfixCollisions(context.issueNumber, context.worktreePath!, context.issue, !!context.force);
  }

  // comment-on-issue: posts comment to GitHub issue
  if (hooks['comment-on-issue'] && context.issueNumber && !context.noComment) {
    const message = hooks['comment-on-issue'];
    try {
      await run(`gh issue comment ${context.issueNumber} --body "${message}"`);
    } catch {
      logger.warn('Warning: Failed to comment on issue (continuing anyway)');
    }
  }
}
```

**Prompt Rendering (`renderPrompt()`)**:
```typescript
function renderPrompt(protocol: ProtocolDefinition, context: PromptContext): string {
  // 1. Check for protocol-specific template
  const templatePath = resolve(config.codevDir, 'protocols', protocol.name, 'builder-prompt.md');
  if (existsSync(templatePath)) {
    const template = readFileSync(templatePath, 'utf-8');
    return renderTemplate(template, context);  // Simple mustache-style replacement
  }

  // 2. Fall back to generic prompt construction (existing behavior)
  return buildGenericPrompt(protocol, context);
}
```

**Template Fallback Behavior**:
- If `protocols/{name}/builder-prompt.md` exists → use template
- Otherwise → construct prompt using existing logic in each spawn function
- This ensures backwards compatibility - no protocol REQUIRES a template

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

Update tick/protocol.json:
```json
{
  "input": {
    "type": "spec",
    "required": false
  },
  "defaults": {
    "mode": "soft"
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
- [ ] Spec file `**Protocol**: TICK` header still works (protocol resolution respects it)
- [ ] `--use-protocol` overrides spec file header
- [ ] No regressions in existing functionality

#### Test Plan

**Unit Tests** (new file: `packages/codev/src/agent-farm/__tests__/spawn.test.ts`):
```typescript
describe('resolveProtocol', () => {
  it('returns explicit --use-protocol when provided', async () => {
    const result = await resolveProtocol({ useProtocol: 'tick', project: '0001' }, config);
    expect(result).toBe('tick');
  });

  it('reads protocol from spec file header', async () => {
    // Mock spec file with **Protocol**: TICK
    const result = await resolveProtocol({ project: '0001' }, config);
    expect(result).toBe('tick');
  });

  it('falls back to spider for --project without spec header', async () => {
    const result = await resolveProtocol({ project: '0001' }, config);
    expect(result).toBe('spider');
  });

  it('falls back to bugfix for --issue', async () => {
    const result = await resolveProtocol({ issue: 42 }, config);
    expect(result).toBe('bugfix');
  });
});

describe('loadProtocol', () => {
  it('loads and parses valid protocol.json', () => {
    const result = loadProtocol(config, 'spider');
    expect(result.name).toBe('spider');
    expect(result.phases).toBeDefined();
  });

  it('throws for invalid protocol name', () => {
    expect(() => loadProtocol(config, 'nonexistent')).toThrow();
  });
});
```

**Manual Tests**:
- Verify `af spawn -p 0001` still works
- Verify `af spawn -i 42` still works
- Verify `af spawn -p 0001 --use-protocol tick` uses tick
- Verify `af spawn --protocol maintain` works
- Verify error handling for invalid protocol names
- Verify spec with `**Protocol**: TICK` header uses tick by default
- Verify `--use-protocol spider` overrides spec header

#### Rollback Strategy
Revert the commit if issues are found. Changes are contained to a few files.

#### Risks

- **Risk**: Breaking existing spawn behavior
  - **Mitigation**: Extensive backwards compatibility testing, unit tests for resolution logic
  - **Mitigation**: Protocol resolution preserves existing spec-header parsing as step 2

- **Risk**: Schema changes affect downstream codev-skeleton users
  - **Mitigation**: New fields are additive and optional - existing protocol.json files work unchanged

- **Risk**: Hook execution duplicates vs reuses existing code
  - **Mitigation**: `executePreSpawnHooks()` calls existing `checkBugfixCollisions()` function, just controlled by config

- **Risk**: Interaction between `--protocol` and `--use-protocol` flags is confusing
  - **Mitigation**: Clear documentation that `--protocol` is input type, `--use-protocol` is modifier

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
- [ ] Update CLI help text to clarify `--protocol` vs `--use-protocol`

## Post-Implementation Tasks
- [ ] Manual testing of all spawn variants
- [ ] Run all unit tests
- [ ] Verify existing e2e tests pass

## Expert Review

### First Consultation (2026-01-28)
**Models**: Gemini, Codex, Claude

**Key Feedback**:
- Missing specification file (resolved: spec now exists in worktree)
- Protocol resolution from spec headers needs clarification (resolved: added precedence order)
- Hook execution mechanics unclear (resolved: explained reuse of existing functions)
- Need automated tests (resolved: added unit test plan)
- Template fallback behavior unspecified (resolved: added explicit fallback description)
- Clarify `--protocol` vs `--use-protocol` (resolved: added clarification section)

**Plan Adjustments**:
- Added detailed protocol resolution precedence (4-step order)
- Added `executePreSpawnHooks()` implementation details showing reuse of existing code
- Added unit test specifications for `resolveProtocol()` and `loadProtocol()`
- Added template fallback behavior description
- Added `--protocol` vs `--use-protocol` clarification
- Expanded risk analysis

## Approval
- [ ] Technical Lead Review
- [x] Expert AI Consultation Complete (Round 1)

## Change Log
| Date | Change | Reason | Author |
|------|--------|--------|--------|
| 2026-01-28 | Initial plan | Spec approved | Builder |
| 2026-01-28 | Address consultation feedback | Gemini/Codex/Claude review | Builder |
