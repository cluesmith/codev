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

# Clean up after (in finally block for error safety)
os.unlink(instructions_file)
```

**Note**: The existing codebase already has try/finally blocks for temp file cleanup in all three Codex invocation paths (`run_model_consultation`, `do_general`, `run_mediated_consultation`). This implementation reuses that infrastructure.

**Reasoning effort options**: `minimal` | `low` | `medium` | `high` | `none`
- `low` recommended for consultations - balances speed and quality
- Expected impact: 10-20% faster responses

### Part 2: Optimize Consultant Prompt

The consultant role (`codev/roles/consultant.md`) was reviewed for Codex optimization:

1. **Leverage Codex's strengths**: Encourage use of shell commands (`git show`, `rg`, etc.)
2. **Be directive**: Codex responds well to clear, specific instructions
3. **Avoid redundancy**: Codex already knows coding conventions
4. **Focus on the task**: PR review, spec review, or plan review

**Analysis Result**: After review, the consultant prompt is already well-optimized:
- Already encourages shell commands (PR Review Protocol section)
- Already directive with clear instructions per review type
- Model-agnostic design is correct since it's shared across Gemini/Codex/Claude
- No changes needed - the prompt structure is appropriate for all models

### Part 3: Investigate Performance

Before optimizing, verify the baseline:
1. Run `consult --model codex pr <N>` on main branch (not a builder branch)
2. Measure time
3. If still 200-250s, that's GPT-5.1-codex's inherent speed
4. If faster, the slowness may be branch/worktree related

## Success Criteria

- [x] `CODEX_SYSTEM_MESSAGE` replaced with `experimental_instructions_file`
- [x] Consultant prompt reviewed (no changes needed - already optimized)
- [x] Performance baseline documented (163.7s -> 118.7s, -27%)
- [x] No regressions in consultation quality (after review found issue baseline missed)

## Out of Scope

- **TypeScript consult CLI** (`packages/codev/src/commands/consult/index.ts`): This is a separate port (Spec 0039) and should be updated separately. The Python `codev/bin/consult` is the primary implementation.

## Constraints

- **Model**: GPT-5.1-codex only (no experimentation with other models)
- **Complexity**: Keep it simple - no profiles, no caching, no extra flags
- **Compatibility**: Must work on macOS and Linux

## Test Plan

1. **Functional**: Run `consult --model codex spec 43` and verify output quality
2. **Performance**: Measure time on main branch vs builder branch
3. **Reliability**: Verify temp file cleanup on success and failure

## Research: Community Tips for Faster Codex

From web research ([10 Codex Fixes](https://medium.com/@ThinkingLoop/10-openai-codex-fixes-for-performance-nightmares-ad55d3fc293a), [GitHub Issues](https://github.com/openai/codex/issues/5149), [Speed Discussion](https://medium.com/@magnusriga/the-problem-is-speed-792b30fb3609)):

### Known Issues
- **GPT-5 is inherently slow**: Users report 5-20 minutes per query, 4-7x slower than GPT-4.1
- **"Meanders a lot"**: GPT-5 explores many approaches before converging on a solution
- **Server load**: Response times vary significantly based on OpenAI server load

### Optimization Tips
1. **Optimize prompts**: Don't paste entire codebases - feed only relevant context
2. **Summarize boilerplate**: Compress repetitive code before passing to Codex
3. **Use focused queries**: Specific questions get faster responses than open-ended ones
4. **Streaming**: Perceived speed improves with streaming enabled (already using --full-auto)

### What We Can Control
- **Consultant prompt optimization**: Make it concise and focused
- **Reasoning effort**: `model_reasoning_effort=low` reduces computation
- **Context size**: Pass less context for faster responses (trade-off with quality)

### What We Cannot Control
- **Server latency**: OpenAI infrastructure speed
- **Model inherent speed**: GPT-5.1-codex is slower than alternatives by design
- **Token generation**: ~1ms per token, unavoidable

## Implementation Results

Performance measurements on PR #33 review (932-line diff, 8 files):

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Consultation Time | 163.7s | 118.7s | **-27.5%** |
| Total Time | 167.2s | 121.6s | **-27.3%** |
| Tokens Used | 51,223 | 38,556 | **-24.7%** |
| Reasoning Effort | medium | low | Reduced |

**Quality**: After implementation, Codex found a valid issue (missing `af spawn` integration) that the baseline review missed, suggesting quality is maintained or improved.

## References

- [Codex CLI Reference](https://developers.openai.com/codex/cli/reference/)
- [Custom System Prompt Discussion](https://github.com/openai/codex/discussions/3896)
- [Pro Tip: Custom System Prompts](https://github.com/openai/codex/discussions/7296)
- [Codex Prompting Guide](https://developers.openai.com/codex/prompting/)
- [10 Codex Fixes for Performance](https://medium.com/@ThinkingLoop/10-openai-codex-fixes-for-performance-nightmares-ad55d3fc293a)
- [Codex CLI Slow Issue #5149](https://github.com/openai/codex/issues/5149)
- [Speed Discussion](https://medium.com/@magnusriga/the-problem-is-speed-792b30fb3609)
- Current implementation: `codev/bin/consult`
- Consultant role: `codev/roles/consultant.md`
