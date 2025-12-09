# Specification: Codex CLI Reliability and Performance Optimization

## Metadata
- **ID**: 0043-codex-reliability
- **Status**: specified
- **Created**: 2025-12-08
- **Updated**: 2025-12-08

## Problem Statement

The Codex CLI is currently used in Codev's consultation workflow but has two issues:

1. **Slow response times**: 200-250 seconds for consultations, ~40-100% slower than Gemini (120-150s)
2. **Undocumented configuration**: We use `CODEX_SYSTEM_MESSAGE` env var which is not documented by OpenAI

This affects the effectiveness of our 3-way consultation workflow (Gemini, Codex, Claude) where Codex is the slowest contributor.

## Scope

This spec covers:
1. **Replace undocumented env var** with official `experimental_instructions_file` approach
2. **Tune reasoning effort** - use `-c model_reasoning_effort=low` for faster responses
3. **Optimize the consultant prompt** (`codev/roles/consultant.md`) for better Codex performance
4. **Investigate slowness** - determine if 200-250s is inherent to GPT-5.1-codex or fixable

**Out of scope:**
- Model switching (GPT-5.1-codex is the only model to use)
- Profile-based configuration (one size fits all)
- Timeout/streaming optimization
- Caching or other complexity

## Current State

**Current Implementation** (from `codev/bin/consult`):

```python
elif resolved == "codex":
    if not shutil.which("codex"):
        return "Error: codex not found", 1, 0.0
    cmd = ["codex", "exec", "--full-auto", query]
    env = {"CODEX_SYSTEM_MESSAGE": role}  # UNDOCUMENTED!
```

**Problems:**
- `CODEX_SYSTEM_MESSAGE` is not in any OpenAI documentation
- Could break in future Codex CLI versions
- Consultant prompt may not be optimized for Codex's capabilities

## Desired State

1. **Use official configuration** - Replace env var with `experimental_instructions_file`
2. **Optimized consultant prompt** - Tailored for Codex's strengths (shell commands, code exploration)
3. **Understood performance** - Know why it's slow and whether it's fixable

## Solution

### Part 1: Replace Undocumented Env Var + Add Reasoning Tuning

**Official approach** (from [OpenAI Codex discussions](https://github.com/openai/codex/discussions/3896)):

```python
# Write consultant role to temp file
import tempfile
with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
    f.write(role)
    instructions_file = f.name

# Use official config flags with reasoning effort tuning
cmd = [
    "codex", "exec",
    "-c", f"experimental_instructions_file={instructions_file}",
    "-c", "model_reasoning_effort=low",  # Faster responses
    "--full-auto",
    query
]

# Clean up after
os.unlink(instructions_file)
```

**Reasoning effort options**: `minimal` | `low` | `medium` | `high` | `none`
- `low` recommended for consultations - balances speed and quality
- Expected impact: 10-20% faster responses

### Part 2: Optimize Consultant Prompt

The consultant role (`codev/roles/consultant.md`) should be optimized for Codex:

1. **Leverage Codex's strengths**: Encourage use of shell commands (`git show`, `rg`, etc.)
2. **Be directive**: Codex responds well to clear, specific instructions
3. **Avoid redundancy**: Codex already knows coding conventions
4. **Focus on the task**: PR review, spec review, or plan review

Current prompt may be too generic. Need to review and optimize.

### Part 3: Investigate Performance

Before optimizing, verify the baseline:
1. Run `consult --model codex pr <N>` on main branch (not a builder branch)
2. Measure time
3. If still 200-250s, that's GPT-5.1-codex's inherent speed
4. If faster, the slowness may be branch/worktree related

## Success Criteria

- [ ] `CODEX_SYSTEM_MESSAGE` replaced with `experimental_instructions_file`
- [ ] Consultant prompt reviewed and optimized for Codex
- [ ] Performance baseline documented (main vs branch)
- [ ] No regressions in consultation quality

## Constraints

- **Model**: GPT-5.1-codex only (no experimentation with other models)
- **Complexity**: Keep it simple - no profiles, no caching, no extra flags
- **Compatibility**: Must work on macOS and Linux

## Test Plan

1. **Functional**: Run `consult --model codex spec 43` and verify output quality
2. **Performance**: Measure time on main branch vs builder branch
3. **Reliability**: Verify temp file cleanup on success and failure

## References

- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/)
- [Custom System Prompt Discussion](https://github.com/openai/codex/discussions/3896)
- [Pro Tip: Custom System Prompts](https://github.com/openai/codex/discussions/7296)
- [Codex Prompting Guide](https://developers.openai.com/codex/prompting/)
- Current implementation: `codev/bin/consult`
- Consultant role: `codev/roles/consultant.md`
