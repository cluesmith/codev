# Plan: Codex CLI Reliability and Performance

## Metadata
- **Spec**: [0043-codex-reliability.md](../specs/0043-codex-reliability.md)
- **Status**: draft
- **Created**: 2025-12-08
- **Protocol**: SPIDER

## Overview

Fix the undocumented `CODEX_SYSTEM_MESSAGE` environment variable usage with the official `experimental_instructions_file` approach, optimize the consultant prompt for Codex, and document performance characteristics.

## Phase 1: Baseline Performance Measurement

**Goal**: Understand current performance before making changes

### Tasks

- [ ] Run `time consult --model codex spec 43` from main branch
- [ ] Run `time consult --model codex pr <recent-pr>` from main branch
- [ ] Document baseline times (expected: 200-250s)
- [ ] Note number of shell commands Codex executes (visible in output)

### Exit Criteria
- Baseline performance documented
- Understand typical Codex behavior (shell commands, exploration patterns)

## Phase 2: Replace CODEX_SYSTEM_MESSAGE + Add Reasoning Tuning

**Goal**: Use official configuration instead of undocumented env var, add reasoning effort tuning

### Tasks

- [ ] Read current consult tool: `codev/bin/consult`
- [ ] Find the Codex CLI invocation (around line 152)
- [ ] Replace env var approach with temp file + `-c experimental_instructions_file=<path>`
- [ ] Add `-c model_reasoning_effort=low` for faster responses
- [ ] Ensure temp file cleanup in finally block (both success and failure)
- [ ] Test that consultant role is still passed correctly

### Implementation

```python
# Before
cmd = ["codex", "exec", "--full-auto", query]
env = {"CODEX_SYSTEM_MESSAGE": role}

# After
import tempfile
import os

# Create temp file for instructions
with tempfile.NamedTemporaryFile(mode='w', suffix='.md', delete=False) as f:
    f.write(role)
    instructions_file = f.name

try:
    cmd = [
        "codex", "exec",
        "-c", f"experimental_instructions_file={instructions_file}",
        "-c", "model_reasoning_effort=low",  # Faster responses (10-20% improvement)
        "--full-auto",
        query
    ]
    # ... run command ...
finally:
    if os.path.exists(instructions_file):
        os.unlink(instructions_file)
```

### Exit Criteria
- Codex consultations work without CODEX_SYSTEM_MESSAGE
- Reasoning effort set to low
- Temp files cleaned up after each run
- No change in output quality

## Phase 3: Optimize Consultant Prompt

**Goal**: Improve the consultant role for better Codex performance

### Tasks

- [ ] Read current consultant prompt: `codev/roles/consultant.md`
- [ ] Identify areas for improvement:
  - Is it too verbose? Codex works better with concise prompts
  - Does it leverage Codex's strengths? (shell commands, code exploration)
  - Is there redundant guidance? (Codex knows coding conventions)
- [ ] Update prompt with Codex-specific optimizations
- [ ] Test updated prompt with `consult --model codex spec 43`
- [ ] Compare output quality before/after

### Optimization Principles

1. **Be concise**: Codex prefers shorter, direct prompts
2. **Leverage tools**: Encourage `git show`, `rg`, `cat` for exploration
3. **Clear deliverables**: Explicit about expected output format
4. **Avoid redundancy**: Don't explain what Codex already knows

### Exit Criteria
- Consultant prompt updated
- No regression in consultation quality
- Document any performance improvement

## Phase 4: Post-Change Performance Measurement

**Goal**: Verify changes don't degrade performance

### Tasks

- [ ] Run `time consult --model codex spec 43` from main branch
- [ ] Run `time consult --model codex pr <recent-pr>` from main branch
- [ ] Compare with Phase 1 baseline
- [ ] Document findings

### Exit Criteria
- Performance documented (before/after)
- No significant regression (< 10% slower is acceptable)
- If faster, document the improvement

## Phase 5: Documentation and Cleanup

**Goal**: Update docs and commit

### Tasks

- [ ] Update CLAUDE.md/AGENTS.md if consult usage changed
- [ ] Add comment in consult tool explaining the approach
- [ ] Update projectlist.md status to implemented
- [ ] Commit all changes with descriptive message

### Exit Criteria
- All docs updated
- Clean commit history
- Project marked implemented

## Files to Modify

1. `codev/bin/consult` - Replace CODEX_SYSTEM_MESSAGE with experimental_instructions_file
2. `codev/roles/consultant.md` - Optimize for Codex
3. `codev/projectlist.md` - Update status

## Risks

| Risk | Mitigation |
|------|------------|
| experimental_instructions_file doesn't work | Fall back to env var with warning in code |
| Prompt optimization degrades quality | A/B test before/after, keep original as backup |
| Temp file not cleaned up | Use try/finally, test failure paths |

## Success Metrics

- [ ] No undocumented API usage
- [ ] Temp files cleaned up reliably
- [ ] Consultation quality maintained
- [ ] Performance documented (may or may not improve - that's OK)
