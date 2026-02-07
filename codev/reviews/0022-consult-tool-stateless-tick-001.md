# Review: TICK-001 - Architect-Mediated PR Reviews

## Metadata
- **Parent Spec**: 0022-consult-tool-stateless
- **TICK Number**: 001
- **Date**: 2025-12-08
- **Protocol**: TICK (amendment workflow per spec 0040)
- **Branch**: builder/task-Yygr

## Summary

This TICK amends the consult tool specification to change how PR reviews work. Instead of having each consultant independently explore the filesystem (slow, redundant), the architect now prepares a comprehensive PR overview that consultants analyze.

## What Changed

### Problem Addressed

The original PR review workflow had significant inefficiencies:

1. **Slow**: Codex took 200-250 seconds running 10-15 sequential shell commands
2. **Redundant**: Each consultant (Gemini, Codex, Claude) independently explored the same files
3. **Inconsistent**: Different consultants examined different aspects
4. **Costly**: Tool calls multiply token usage

### Solution

Architect-mediated reviews:
1. Architect prepares comprehensive PR overview (diff, context, key changes)
2. Architect passes overview to consult via `--context` flag or stdin
3. Consultants analyze provided context without filesystem access
4. Expected review time: <60s per consultant (vs 200s+)

### Files Modified

| File | Change Type |
|------|-------------|
| `codev/bin/consult` | Added mediated mode (~180 lines) |
| `codev/templates/pr-overview.md` | New template (60 lines) |
| `CLAUDE.md` | Documentation update (30 lines) |
| `codev/specs/0022-consult-tool-stateless.md` | Added Amendments section with TICK-001 |
| `codev/plans/0022-consult-tool-stateless.md` | Added Amendment History with Phase 6 |

## Implementation Status

All items completed:

- [x] Add `--context` flag to PR subcommand
- [x] Support stdin for context input (`--context -`)
- [x] Modify CLI invocation to disable filesystem tools when context provided
- [x] Create PR overview template
- [x] Update CLAUDE.md documentation
- [x] Add cleanup for mediated consultation directories

### Sandbox Mode Implementation

| Model | Exploration Mode | Mediated Mode |
|-------|------------------|---------------|
| Gemini | `--yolo` | `--sandbox` |
| Codex | `exec --full-auto` | `exec` (no full-auto) |
| Claude | `--print --dangerously-skip-permissions` | `--print` |

## 3-Way Review Summary

### Gemini (45.2s) - APPROVE
> "The implementation fully satisfies the requirements of Spec 0022 TICK-001. The code is robust and the documentation is complete."

Key points:
- Implementation correctness verified
- Argument parsing logic properly handles mixed positional/flag arguments
- Error handling is robust
- Clean separation of `do_pr` and `do_pr_mediated`

### Codex (317.4s) - APPROVE (with suggestions)
> "Verdict: APPROVE (addressing the above would be nice but not blocking)."

Suggestions addressed:
1. **Mediated cleanup** - Added `cleanup_old_pr_consultations()` call to mediated mode
2. **Documentation note** - The "How It Works" section applies to exploration mode; mediated mode uses different flags

## Test Results

All manual tests passed:
- `consult --model gemini pr --help` - Shows correct help with --context option
- `consult --model gemini pr 68 --context overview.md --dry-run` - Correct mediated mode output
- `echo "test" | consult --model claude pr 99 --context - --dry-run` - Stdin works
- `consult --model gemini pr 68 --dry-run` - Standard mode still works
- Error handling for missing/empty context files works

## Lessons Learned

### What Worked Well

1. **TICK-as-amendment workflow** (per spec 0040) - natural extension of existing spec
2. **Clean separation** - `do_pr_mediated()` keeps mediated logic isolated
3. **Backward compatible** - standard PR review mode unchanged

### What Could Be Improved

1. **Cleanup consistency** - Initially missed adding cleanup to mediated mode. Always ensure new code paths include cleanup logic.
2. **Mode-specific docs** - When adding modes, clearly indicate which documentation applies to which mode

### Technical Observations

- Each CLI has different ways to disable filesystem access:
  - Gemini: explicit `--sandbox` flag
  - Codex: `exec` without `--full-auto` implicitly disables tools
  - Claude: drop `--dangerously-skip-permissions` flag

## Related

- **Parent**: Spec 0022 (Consult Tool Stateless)
- **Meta-spec**: Spec 0040 (TICK as SPIR Amendment)
