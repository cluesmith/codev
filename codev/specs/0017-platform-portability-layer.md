# Specification: Platform Portability Layer

## Metadata
- **ID**: 0017-platform-portability-layer
- **Protocol**: SPIR
- **Status**: specified
- **Created**: 2025-12-03
- **Priority**: low

## Problem Statement

Codev currently targets Claude Code exclusively. To support other platforms (Gemini CLI, Codex CLI), we need:
1. Platform-specific instruction files (CLAUDE.md, GEMINI.md, AGENTS.md)
2. Platform-specific agent/subagent definitions
3. A way to maintain a single source of truth

Currently, CLAUDE.md and AGENTS.md are manually synchronized, which is error-prone.

## Current State

- CLAUDE.md: Claude Code-specific instructions
- AGENTS.md: Generic instructions (AGENTS.md standard)
- Manual sync between them
- No support for Gemini CLI or Codex CLI

## Desired State

**Transpilation approach** (per conceptual-model.md):

```
.codev/                          # Source of truth
├── config.yaml                  # Global settings
├── roles/
│   ├── architect.md             # Platform-agnostic role
│   └── builder.md               # Platform-agnostic role
├── protocols/
│   └── *.yaml                   # Workflow definitions
└── skills/
    └── shared scripts           # Platform-agnostic scripts

         ↓ codev transpile --target=claude

CLAUDE.md                        # Generated for Claude Code
.claude/agents/                  # Generated subagent definitions

         ↓ codev transpile --target=gemini

GEMINI.md                        # Generated for Gemini CLI

         ↓ codev transpile --target=codex

AGENTS.md                        # Generated for Codex CLI
```

## Success Criteria

- [ ] Single source of truth in `.codev/` directory
- [ ] `codev transpile --target=claude` generates CLAUDE.md
- [ ] `codev transpile --target=gemini` generates GEMINI.md
- [ ] `codev transpile --target=codex` generates AGENTS.md
- [ ] Changes to source automatically propagate to all targets

## Technical Approach

### Source Format

```yaml
# .codev/config.yaml
name: "My Project"
default_target: claude
protocols:
  - spir
  - tick
  - cleanup

# .codev/instructions.md (platform-agnostic)
## Project Context
This project is...

## Protocols
{{#each protocols}}
- {{name}}: {{description}}
{{/each}}

## Platform-Specific
{{#if claude}}
<!-- Claude-specific instructions -->
{{/if}}
{{#if gemini}}
<!-- Gemini-specific instructions -->
{{/if}}
```

### Transpiler

```typescript
interface TranspileOptions {
  source: string;      // .codev/ directory
  target: 'claude' | 'gemini' | 'codex';
  output?: string;     // Output directory (default: project root)
}

async function transpile(options: TranspileOptions): Promise<void> {
  // 1. Load source files
  const config = await loadConfig(options.source);
  const instructions = await loadInstructions(options.source);
  const roles = await loadRoles(options.source);

  // 2. Apply platform-specific transformations
  const transformed = applyPlatformTransforms(instructions, options.target);

  // 3. Generate output files
  await generateOutputFiles(transformed, options.target, options.output);
}
```

### Platform Transforms

| Source | Claude | Gemini | Codex |
|--------|--------|--------|-------|
| `.codev/instructions.md` | `CLAUDE.md` | `GEMINI.md` | `AGENTS.md` |
| `.codev/roles/` | `.claude/agents/` | `.gemini/extensions/` | MCP config |
| `{{protocol}}` | Expand protocol details | Expand protocol details | Expand protocol details |

## Scope

### In Scope
- Transpiler CLI (`codev transpile`)
- Source format definition
- Claude and Codex output (AGENTS.md standard)

### Out of Scope (Phase 2)
- Gemini-specific output
- Watch mode (auto-transpile on change)
- IDE integration

## Dependencies

- 0021 Multi-CLI Builder Support (related but not blocking)
- conceptual-model.md Platform Portability section

## Complexity Assessment

This is a **large feature** that should be broken down:
1. **Phase 1**: Define source format, implement CLAUDE.md generation
2. **Phase 2**: Add AGENTS.md generation (Codex)
3. **Phase 3**: Add GEMINI.md generation

Consider starting with just CLAUDE.md ↔ AGENTS.md sync tool.

## References

- `codev/resources/conceptual-model.md` - Platform Portability section
- AGENTS.md standard: https://agents.md/

## Expert Consultation
**Date**: 2025-12-03
**Models Consulted**: GPT-5 Codex, Gemini 3 Pro
**Feedback Incorporated**:
- Define if one-way (.codev → platform) or bidirectional - bidirectional is much harder
- **HIGH COMPLEXITY WARNING**: Risk of "lowest common denominator" limiting platform-specific features
- Over-abstraction is a major risk
- Consider YAGNI - may be premature unless there's concrete immediate use case
- Requires strong schema definition, tests, and fallbacks

**Recommendation from Gemini**: This is an architectural pivot that might be premature. Ensure value justifies maintenance cost.

## Approval
- [ ] Technical Lead Review
- [ ] Product Owner Review
